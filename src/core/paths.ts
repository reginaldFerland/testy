import * as path from 'node:path';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Minimatch } from 'minimatch';

export const defaultExcludes = [
    '**/bin/**', '**/obj/**', '**/TestResults/**', '**/node_modules/**', '**/.git/**',
    '**/.testy/**', '**/*.g.cs', '**/*.g.i.cs', '**/*.generated.cs', '**/*.designer.cs'
] as const;

class TtlMap<T> {
    private readonly entries = new Map<string, { readonly value: T; readonly expires: number }>();
    constructor(private readonly limit: number, private readonly ttl: number) {}
    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) {return undefined;}
        this.entries.delete(key);
        if (entry.expires <= Date.now()) {return undefined;}
        this.entries.set(key, entry); return entry.value;
    }
    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: Date.now() + this.ttl });
        if (this.entries.size > this.limit) {this.entries.delete(this.entries.keys().next().value!);}
    }
    clear(): void { this.entries.clear(); }
}

/** Directory realpaths only: leaf files are always resolved fresh, so created, deleted
 * and retargeted files are seen immediately. The shared instance is bounded and expires.
 * On macOS it also holds directory listings, used only to recover a leaf's on-disk case. */
class DirectoryCache {
    private readonly directories: TtlMap<string>;
    private readonly listings: TtlMap<ReadonlyMap<string, string>>;
    /** Asynchronous resolutions in flight, so concurrent lookups share one realpath. */
    readonly resolving = new Map<string, Promise<string>>();
    constructor(limit = Infinity, ttl = Infinity) {
        this.directories = new TtlMap(limit, ttl); this.listings = new TtlMap(limit, ttl);
    }
    get(directory: string): string | undefined { return this.directories.get(directory); }
    set(directory: string, real: string): void { this.directories.set(directory, real); }
    listing(directory: string): ReadonlyMap<string, string> | undefined { return this.listings.get(directory); }
    setListing(directory: string, names: ReadonlyMap<string, string>): void { this.listings.set(directory, names); }
    clear(): void { this.directories.clear(); this.listings.clear(); this.resolving.clear(); }
}

/** Default APFS ignores case, so the exact name is looked up first (cached listing, then one
 * fresh read for files created since) and only then mapped case-insensitively. */
function onDiskName(cache: DirectoryCache, directory: string, name: string, names: readonly string[]): string {
    const listing = new Map(names.map(entry => [entry.toLowerCase(), entry] as const));
    cache.setListing(directory, listing);
    return listing.get(name.toLowerCase()) ?? name;
}

const isListed = (cache: DirectoryCache, directory: string, name: string): boolean =>
    cache.listing(directory)?.get(name.toLowerCase()) === name;

const sharedDirectories = new DirectoryCache(4096, 2000);

/** Drop shared directory resolutions, e.g. before a run that must observe new symlinks. */
export function clearPathCache(): void { sharedDirectories.clear(); }

function resolveDirectory(directory: string, cache: DirectoryCache): string {
    const cached = cache.get(directory);
    if (cached !== undefined) {return cached;}
    try { const real = realpathSync.native(directory); cache.set(directory, real); return real; }
    catch {
        const parent = path.dirname(directory);
        return parent === directory ? directory : path.join(resolveDirectory(parent, cache), path.basename(directory));
    }
}

function resolveDirectoryAsync(directory: string, cache: DirectoryCache): Promise<string> {
    const cached = cache.get(directory);
    if (cached !== undefined) {return Promise.resolve(cached);}
    let resolving = cache.resolving.get(directory);
    if (!resolving) {
        resolving = (async () => {
            try { const real = await fsp.realpath(directory); cache.set(directory, real); return real; }
            catch {
                const parent = path.dirname(directory);
                return parent === directory ? directory : path.join(await resolveDirectoryAsync(parent, cache), path.basename(directory));
            }
        })();
        const settled = resolving, forget = (): void => {if (cache.resolving.get(directory) === settled) {cache.resolving.delete(directory);}};
        cache.resolving.set(directory, settled); void settled.then(forget, forget);
    }
    return resolving;
}

function resolveLeaf(directory: string, name: string, cache: DirectoryCache): string {
    const leaf = path.join(directory, name);
    try {
        if (lstatSync(leaf).isSymbolicLink()) {return realpathSync.native(leaf);}
        if (process.platform !== 'darwin' || isListed(cache, directory, name)) {return leaf;}
        return path.join(directory, onDiskName(cache, directory, name, readdirSync(directory)));
    } catch { return leaf; }
}

async function resolveLeafAsync(directory: string, name: string, cache: DirectoryCache): Promise<string> {
    const leaf = path.join(directory, name);
    try {
        if ((await fsp.lstat(leaf)).isSymbolicLink()) {return await fsp.realpath(leaf);}
        if (process.platform !== 'darwin' || isListed(cache, directory, name)) {return leaf;}
        return path.join(directory, onDiskName(cache, directory, name, await fsp.readdir(directory)));
    } catch { return leaf; }
}

const canonicalSpelling = (resolved: string): string => {
    const normalized = resolved.replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function normalizeWith(file: string, cache: DirectoryCache): string {
    // PDBs and MSBuild may spell the same path through different symlink aliases
    // (notably /var and /private/var on macOS). Preserve that identity for new or
    // deleted files by resolving their nearest existing ancestor as well.
    const resolved = path.resolve(file), parent = path.dirname(resolved);
    return canonicalSpelling(parent === resolved ? resolveDirectory(resolved, cache) : resolveLeaf(resolveDirectory(parent, cache), path.basename(resolved), cache));
}

async function normalizeWithAsync(file: string, cache: DirectoryCache): Promise<string> {
    const resolved = path.resolve(file), parent = path.dirname(resolved);
    return canonicalSpelling(parent === resolved ? await resolveDirectoryAsync(resolved, cache)
        : await resolveLeafAsync(await resolveDirectoryAsync(parent, cache), path.basename(resolved), cache));
}

export function normalizePath(file: string): string { return normalizeWith(file, sharedDirectories); }

/** Same result as normalizePath without blocking the extension host on the filesystem. */
export function normalizePathAsync(file: string): Promise<string> { return normalizeWithAsync(file, sharedDirectories); }

/** A pathNormalizer whose paths are resolved up front without blocking the extension host:
 * each distinct path once, with bounded concurrency, through one scoped directory cache.
 * A path that was not supplied is still resolved, synchronously, when it is looked up. */
export async function preparePathNormalizer(files: Iterable<string>, signal?: AbortSignal, concurrency = 16): Promise<(file: string) => string> {
    const directories = new DirectoryCache(), paths = new Map<string, string>(), pending = [...new Set(files)];
    let next = 0;
    signal?.throwIfAborted();
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        for (let file = pending[next++]; file !== undefined; file = pending[next++]) {
            paths.set(file, await normalizeWithAsync(file, directories));
            signal?.throwIfAborted();
        }
    }));
    // Normalization is idempotent: results (such as test IDs built from normalized files) are their own.
    for (const normalized of [...paths.values()]) {if (!paths.has(normalized)) {paths.set(normalized, normalized);}}
    return file => {
        let normalized = paths.get(file);
        if (normalized === undefined) {normalized = normalizeWith(file, directories); paths.set(file, normalized);}
        return normalized;
    };
}

/** normalizePath for many paths, resolved asynchronously and deduplicated. */
export async function normalizePathsAsync(files: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const normalize = await preparePathNormalizer(files, signal);
    return files.map(normalize);
}

/** Scope this cache to one discovery/run so filesystem changes cannot outlive it. */
export function pathNormalizer(): (file: string) => string {
    const paths = new Map<string, string>(), directories = new DirectoryCache();
    return file => {
        let normalized = paths.get(file);
        if (normalized === undefined) {normalized = normalizeWith(file, directories); paths.set(file, normalized);}
        return normalized;
    };
}

/** On-disk spellings of canonical paths. Windows keys are lowercase for identity only; labels and URIs show the real case. */
const spellings = new TtlMap<string>(65536, Infinity);

/** Whether canonical paths lose their on-disk case (Windows). */
export const lowercaseKeys = (): boolean => process.platform === 'win32';

/** Recover the on-disk case of canonical paths asynchronously (a no-op elsewhere); see displayPath. */
export async function resolveDisplayPaths(files: Iterable<string>, concurrency = 16): Promise<void> {
    if (!lowercaseKeys()) {return;}
    const pending = [...new Set(files)].filter(file => file && spellings.get(file) === undefined);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
        for (let file = pending[next++]; file !== undefined; file = pending[next++]) {
            let real: string;
            try { real = await fsp.realpath(file); }
            catch {
                const directory = path.dirname(path.resolve(file));
                real = directory === path.resolve(file) ? file : path.join(await resolveDirectoryAsync(directory, sharedDirectories), path.basename(file));
            }
            spellings.set(file, real);
        }
    }));
}

/** The on-disk spelling of a canonical path once resolveDisplayPaths has seen it; otherwise the path itself. */
export function displayPath(file: string): string { return lowercaseKeys() ? spellings.get(file) ?? file : file; }

export function isInside(file: string, folder: string): boolean {
    const relative = path.relative(folder, file);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

const matchers = new Map<string, Minimatch>();
function matcher(pattern: string): Minimatch {
    let compiled = matchers.get(pattern);
    if (!compiled) {
        // Patterns come from settings, so the set is tiny; the bound only guards pathological churn.
        if (matchers.size >= 512) {matchers.clear();}
        compiled = new Minimatch(pattern, { dot: true, nocase: true }); matchers.set(pattern, compiled);
    }
    return compiled;
}

export function matchesPattern(file: string, pattern: string, roots: readonly string[] = []): boolean {
    const directory = /[/\\]$/.test(file);
    const candidates = [file, ...roots.filter(root => isInside(file, root)).map(root => path.relative(root, file) + (directory ? '/' : ''))];
    const compiled = matcher(pattern);
    return candidates.some(candidate => compiled.match(candidate.replace(/\\/g, '/')));
}

export function isExcluded(file: string, excludes: readonly string[] = defaultExcludes, roots: readonly string[] = []): boolean {
    return excludes.some(pattern => matchesPattern(file, pattern, roots));
}

/** Locale-independent string order for identities: localeCompare varies with the ICU
 * data and locale of the editor host, which would change persisted hashes. */
export function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

export function contentHash(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

/** Decode the BOM encodings used by C# sources without changing the input bytes. */
export function sourceText(bytes: Buffer): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {return bytes.subarray(2).toString('utf16le');}
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return Buffer.from(bytes.subarray(2, bytes.length - bytes.length % 2)).swap16().toString('utf16le');
    }
    return bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0).toString('utf8');
}

export function isGeneratedSource(file: string, content: string | Buffer): boolean {
    // Production save/disk events and source tracking use the same byte prefix.
    // A supplied string represents UTF-8 text, without an on-disk encoding.
    const prefix = Buffer.isBuffer(content) ? content.subarray(0, 2048) : Buffer.from(content.slice(0, 2048)).subarray(0, 2048);
    if (!/\.cs$/i.test(file)) {return false;}
    let remaining = sourceText(prefix).trimStart();
    // Only leading comments can declare a generated header. Marker strings in
    // generator tests, or prose mentioning a marker, are ordinary source.
    while (remaining.startsWith('//') || remaining.startsWith('/*')) {
        const line = remaining.startsWith('//');
        const end = line ? remaining.indexOf('\n') : remaining.indexOf('*/', 2);
        const comment = remaining.slice(2, end < 0 ? undefined : end);
        if (comment.split(/\r?\n/).some(text => /^\s*[*\/]?\s*<auto-generated\b/i.test(text))) {return true;}
        if (end < 0) {return false;}
        remaining = remaining.slice(end + (line ? 1 : 2)).trimStart();
    }
    return false;
}

/** Missing dependencies are versions too: their later creation invalidates a trace. */
export function sourceVersion(hashes: ReadonlyMap<string, string>, file: string): string { return hashes.get(file) ?? '<missing>'; }

export function testFileId(project: string, framework: string, file?: string, normalize = normalizePath): string {
    return contentHash(`${normalize(project)}\0${framework}\0${file ? normalize(file) : '<unknown>'}`);
}

/** Inputs are already canonical paths from project evaluation. */
export function testTargetKey(project: string, framework: string): string {
    return `${project}\0${framework}`;
}

export function isConfigurationFile(file: string): boolean {
    return /\.(csproj|sln|slnx|slnf|props|targets|runsettings|json|config|resx|editorconfig|globalconfig|ruleset)$/i.test(file);
}

export function isCompilerConfiguration(file: string): boolean { return /\.(editorconfig|globalconfig|ruleset)$/i.test(file); }

export function isInheritedConfiguration(file: string): boolean {
    return isCompilerConfiguration(file) || path.basename(file).toLowerCase() === 'global.json';
}

/** Inherited configs above a workspace must not turn its ancestors into source roots. */
export function sourceDirectories(files: readonly string[], directories: readonly string[]): readonly string[] {
    const configs = new Set<string>(), sources = new Set<string>();
    for (const file of files) {(isInheritedConfiguration(file) ? configs : sources).add(path.dirname(file));}
    return directories.filter(directory => !configs.has(directory) || sources.has(directory));
}

/** Random UUIDs name extension-owned storage entries. */
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
