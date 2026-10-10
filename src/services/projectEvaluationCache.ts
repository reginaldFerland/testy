import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../core/model';
import { mapConcurrent } from '../core/concurrency';
import { EnvironmentError } from '../core/errors';
import { EvaluationStorageLimits, listingDigestPattern, readEvaluationSnapshot, writeEvaluationSnapshot } from './projectEvaluationStorage';
import { isNativeExecutable, resolveNodeExecutable } from './executable';
import { HashMemo } from './hashMemo';
import { fileIdentity } from './preparationTools';

export interface EvaluationQuery {
    readonly kind: 'file' | 'directory' | 'exists' | 'files' | 'directories' | 'entries' | 'mtime' | 'imports';
    readonly path: string;
    readonly pattern: string | null;
    readonly recursive: boolean;
    readonly values: readonly string[];
}
export interface EvaluationInputs {
    readonly reusable: boolean;
    readonly files: readonly string[];
    readonly hashes?: Readonly<Record<string, string>>;
    readonly queries: readonly EvaluationQuery[];
    readonly excludedDirectories: readonly string[];
    readonly sdkDirectory: string;
}

/** Metadata is deliberately separate from graph identity/coverage ownership. */
export const evaluationInputs = new WeakMap<readonly Project[], readonly EvaluationInputs[]>();
export interface EvaluationEntry {
    readonly graph: readonly Project[]; readonly inputs: readonly EvaluationInputs[]; readonly context: string; readonly stamp: string;
    /** Canonical graph files mapped to the original captured input spellings; absent
     * without storage, or when a spelling could not be captured (such entries are not saved). */
    readonly projectInputs?: Readonly<Record<string, string>> | undefined;
}
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const lexical = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
/** `within` for operands already passed through lexical. */
const underLexical = (file: string, directory: string): boolean => file === directory || file.startsWith(`${directory}${path.sep}`);
const within = (file: string, directory: string): boolean => underLexical(lexical(file), lexical(directory));
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
/** The digest of a listing's names, as EvaluationInputs.Listing in the helper computes it. */
const listingDigest = (names: readonly string[]): string => { const sorted = [...names].sort(); return `${sorted.length}:${digest(sorted.join('\n'))}`; };

/** Resolve the actual CLI in every possible inspection cwd. A relative PATH
 * selecting different hosts cannot share an evaluation cache context. `identities`
 * (the engine's tool hashes) reuses the host and analyzer hashes while their metadata is unchanged. */
export async function evaluationToolContext(dotnet: string, analyzer: string, directories: readonly string[], signal?: AbortSignal,
    identities?: Map<string, Promise<string>>): Promise<{ readonly key: string; readonly root: string } | undefined> {
    signal?.throwIfAborted();
    const fingerprints = new Map<string, Promise<string>>();
    const fingerprint = (file: string): Promise<string> => {
        const previous = fingerprints.get(file);
        if (previous) {return previous;}
        const pending = fileIdentity(file, signal, identities);
        fingerprints.set(file, pending); return pending;
    };
    try {
        if (Object.entries(process.env).some(([key, value]) => value && /^(?:MSBUILD.*SDKRESOLVER|DOTNET_MSBUILD_SDK_RESOLVER|MSBuildSDKsPath|MsBuildCacheFileExistence$)/i.test(key))) {return undefined;}
        const hosts = await mapConcurrent([...new Set(directories)], 16, signal, async (cwd, _index, workerSignal) => {
            // Inspection uses a direct Node launch (cleanupDescendants:false),
            // including its cwd/PATH precedence and literal POSIX path spelling.
            const executable = await resolveNodeExecutable(dotnet, process.env, cwd, workerSignal);
            if (!executable) {throw new EnvironmentError('host-unresolved', 'The configured .NET host could not be resolved.');}
            return fingerprint(executable);
        });
        const unique = [...new Set(hosts)], [host] = unique;
        if (unique.length !== 1 || !host) {return undefined;}
        const [executable] = host.split('\0');
        if (!executable) {return undefined;}
        const root = path.dirname(executable);
        if (!['dotnet', 'dotnet.exe'].includes(path.basename(executable).toLowerCase()) || !isNativeExecutable(await fileHeader(executable))
            || !(await fs.stat(path.join(root, 'sdk'))).isDirectory() || !(await fs.stat(path.join(root, 'host', 'fxr'))).isDirectory()) {return undefined;}
        const analyzerIdentity = await fingerprint(analyzer);
        signal?.throwIfAborted();
        return { key: digest(JSON.stringify([host, analyzerIdentity])), root };
    } catch {signal?.throwIfAborted(); return undefined;}
}

/** The leading bytes that identify an executable format. */
async function fileHeader(file: string): Promise<Buffer> {
    const handle = await fs.open(file, 'r');
    try {const { buffer, bytesRead } = await handle.read(Buffer.alloc(4), 0, 4, 0); return buffer.subarray(0, bytesRead);}
    finally {await handle.close();}
}

function configurationCandidates(file: string): string[] {
    const candidates: string[] = [];
    for (let directory = path.dirname(file);;) {
        for (const name of ['global.json', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'NuGet.Config', 'nuget.config']) {
            candidates.push(path.join(directory, name));
        }
        const parent = path.dirname(directory);
        if (parent === directory) {return candidates;}
        directory = parent;
    }
}

/** A validation pass shares filesystem reads across all requested root closures. */
class Validation {
    private readonly files = new Map<string, Promise<string>>();
    private readonly queries = new Map<string, Promise<string>>();
    private readonly realPaths = new Map<string, Promise<string>>();
    private readonly listings = new Map<string, Promise<Dirent[]>>();
    constructor(private readonly signal?: AbortSignal, private readonly memo?: HashMemo) {}
    file(file: string): Promise<string> {
        const key = lexical(file), previous = this.files.get(key);
        if (previous) {return previous;}
        const promise = (async () => {
            this.signal?.throwIfAborted();
            try {
                const actualPath = this.realPath(file);
                void actualPath.catch(() => undefined);
                // Stat first: a file edited while it is read then differs from the stat on record.
                const stat = await fs.stat(file, { bigint: true }), readAt = Date.now();
                let hash = this.memo?.get(key, stat);
                if (hash === undefined) {
                    hash = digest(await fs.readFile(file, { signal: this.signal }));
                    this.memo?.set(key, stat, hash, readAt);
                }
                return `${await actualPath}:${stat.mode}:${hash}`;
            } catch (error) {if (missing(error)) {return 'missing';} throw error;}
        })();
        this.files.set(key, promise); return promise;
    }
    /** One listing per directory per pass, shared by every query that walks it. */
    private list(directory: string): Promise<Dirent[]> {
        const previous = this.listings.get(directory);
        if (previous) {return previous;}
        const pending = fs.readdir(directory, { withFileTypes: true });
        this.listings.set(directory, pending); return pending;
    }
    private realPath(file: string): Promise<string> {
        const previous = this.realPaths.get(file);
        if (previous) {return previous;}
        const pending = fs.realpath(file).catch((error: unknown) => {if (missing(error)) {return 'missing';} throw error;});
        this.realPaths.set(file, pending); return pending;
    }
    query(query: EvaluationQuery, excluded: readonly string[]): Promise<string> {
        const relevantExcludes = query.kind === 'files' || query.kind === 'directories' || query.kind === 'entries'
            ? excluded.filter(output => within(output, query.path) || within(query.path, output)) : [];
        const key = JSON.stringify([query.kind, query.path, query.pattern, query.recursive, relevantExcludes]), previous = this.queries.get(key);
        if (previous) {return previous;}
        const promise = this.readQuery(query, relevantExcludes);
        this.queries.set(key, promise); return promise;
    }
    private async readQuery(query: EvaluationQuery, excluded: readonly string[]): Promise<string> {
        this.signal?.throwIfAborted();
        if (query.kind === 'mtime' || query.kind === 'file' || query.kind === 'directory' || query.kind === 'exists') {
            try {
                const stat = await fs.stat(query.path, { bigint: true });
                return JSON.stringify([query.kind === 'mtime' ? String(stat.mtimeNs / 100n + 621355968000000000n) : String(query.kind === 'file' ? stat.isFile() : query.kind === 'directory' ? stat.isDirectory() : true)]);
            } catch (error) {if (missing(error)) {return JSON.stringify(query.kind === 'mtime' ? ['504911232000000000'] : ['false']);} throw error;}
        }
        const values: string[] = [], pending = [query.path], excludedPaths = excluded.map(lexical);
        const suffix = query.pattern === '*' || !query.pattern ? undefined : query.pattern.slice(1);
        const importPattern = query.kind === 'imports' ? new RegExp(`^${(query.pattern ?? '*').split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, process.platform === 'win32' ? 'i' : '') : undefined;
        while (pending.length) {
            const directory = pending.pop()!;
            let entries;
            try {entries = await this.list(directory);}
            catch (error) {if (query.kind === 'imports' && missing(error)) {continue;} throw error;}
            for (const entry of entries) {
                this.signal?.throwIfAborted();
                const file = path.join(directory, entry.name);
                const lexicalFile = lexical(file);
                if (query.kind !== 'imports' && excludedPaths.some(output => underLexical(lexicalFile, output))) {continue;}
                // MSBuild follows linked source directories; decline cached
                // validation for links instead of assuming a Dirent is a file.
                const stat = entry.isSymbolicLink() ? await fs.stat(file) : entry;
                if (entry.isSymbolicLink() && stat.isDirectory()) {throw new Error('Directory links require fresh project evaluation.');}
                if (query.recursive && stat.isDirectory()) {pending.push(file);}
                if (importPattern ? !importPattern.test(entry.name) : suffix && !(process.platform === 'win32' ? entry.name.toLowerCase().endsWith(suffix.toLowerCase()) : entry.name.endsWith(suffix))) {continue;}
                if (query.kind === 'entries' || ((query.kind === 'files' || query.kind === 'imports') && stat.isFile()) || (query.kind === 'directories' && stat.isDirectory())) {values.push(lexicalFile);}
            }
        }
        return JSON.stringify([listingDigest(values)]);
    }
    async projectInputs(graph: readonly Project[], inputs: readonly EvaluationInputs[], signal?: AbortSignal): Promise<Readonly<Record<string, string>> | undefined> {
        const captured = new Map<string, string>();
        // stamp already resolved every captured file. Reuse those realpath reads
        // to bind native/case/symlink spellings to normalized graph identities.
        const paths = [...new Set(inputs.flatMap(input => Object.keys(input.hashes ?? {})))];
        const actual = await mapConcurrent(paths, 16, signal, async file => [file, await this.realPath(file)] as const);
        for (const [file, resolved] of actual) {if (resolved !== 'missing') {captured.set(lexical(resolved), file);}}
        const result: Record<string, string> = {};
        const nodes = new Set(graph);
        for (const project of nodes) {
            for (const context of project.contexts ?? []) {nodes.add(context);}
            const file = captured.get(lexical(project.file)); if (!file) {return undefined;}
            result[project.file] = file;
        }
        return result;
    }
    async stamp(graph: readonly Project[], inputs: readonly EvaluationInputs[], signal?: AbortSignal): Promise<string | undefined> {
        if (!inputs.length || inputs.some(input => !input.reusable)) {return undefined;}
        const files = [...new Set([...inputs.flatMap(input => input.files), ...graph.flatMap(project => configurationCandidates(project.file)),
            ...inputs.flatMap(input => [path.join(input.sdkDirectory, 'Microsoft.Build.dll'), path.join(input.sdkDirectory, 'MSBuild.dll')])])].sort();
        const records = await mapConcurrent(files, 16, signal, async file => [lexical(file), await this.file(file)]);
        for (const input of inputs) {for (const [file, hash] of Object.entries(input.hashes ?? {})) {
            if (!(await this.file(file)).endsWith(`:${hash}`)) {return undefined;}
        }}
        const queries = inputs.flatMap(input => input.queries.map(query => ({ query, excluded: input.excludedDirectories })));
        const checked = await mapConcurrent(queries, 16, signal, async ({ query, excluded }) => {
            const expected = query.kind === 'files' || query.kind === 'directories' || query.kind === 'entries' || query.kind === 'imports'
                ? JSON.stringify(query.values.length === 1 && listingDigestPattern.test(query.values[0]!) ? query.values : [listingDigest(query.values.map(lexical))]) : JSON.stringify(query.values);
            return await this.query(query, excluded) === expected;
        });
        if (checked.some(valid => !valid)) {return undefined;}
        const queryPaths = await mapConcurrent([...new Set(queries.map(({ query }) => query.path))].sort(), 16, signal, async file => [file, await this.realPath(file)]);
        // A newly installed SDK can change selection without modifying global.json.
        const sdkInventories = await mapConcurrent([...new Set(inputs.map(input => path.dirname(input.sdkDirectory)))].sort(), 8, signal,
            async directory => [directory, (await fs.readdir(directory)).sort()]);
        return digest(JSON.stringify([records, queryPaths, sdkInventories]));
    }
}

/** Every hit, including one loaded after restart, validates evaluated files and
 * actual MSBuild queries, including absent imports and glob inventories. */
export class ProjectEvaluationCache {
    private readonly entries = new Map<string, EvaluationEntry>();
    private readonly replacements = new Map<string, number>();
    private live: ReadonlySet<string> | undefined;
    private loaded = false;
    private revision = 0;
    private dirty = false;
    private pending = Promise.resolve();
    private readonly hashes = new HashMemo(16384);
    constructor(private readonly storage?: string, private readonly limits: EvaluationStorageLimits = {},
        private readonly log: (text: string) => void = () => undefined) {}
    retain(files: readonly string[]): void {
        this.live = new Set(files);
        for (const file of this.entries.keys()) {if (!this.live.has(file)) {this.entries.delete(file); this.dirty = true; this.revision++;}}
    }
    /** Forget every evaluation, including the saved snapshot. */
    async clear(signal?: AbortSignal): Promise<void> {
        this.loaded = true; this.live = undefined;
        this.entries.clear(); this.hashes.clear(); this.dirty = true; this.revision++;
        await this.save(signal);
    }
    private async load(signal?: AbortSignal): Promise<void> {
        if (!this.storage || this.loaded) {return;}
        const revision = this.revision;
        try {
            const snapshot = await readEvaluationSnapshot(this.storage, this.limits, signal);
            signal?.throwIfAborted();
            // A concurrent load can finish during the read.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            if (!snapshot || this.loaded || revision !== this.revision) {return;}
            // A concurrent admission/retirement wins over an older disk read.
            for (const [file, entry] of snapshot.entries) {
                if (this.live && !this.live.has(file)) {this.dirty = true; this.revision++; continue;}
                if (!this.replacements.has(file) && !this.entries.has(file)) {
                    this.entries.set(file, entry); evaluationInputs.set(entry.graph, entry.inputs);
                }
            }
            this.loaded = true;
        } catch (error) {
            signal?.throwIfAborted();
            // A fresh install has no snapshot yet: that is an empty one, not a failure.
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {this.loaded = true; return;}
            // An absent, corrupt or unreadable snapshot is a retryable miss.
            this.log(`Saved project evaluations unavailable; evaluating projects. ${String(error)}\n`);
        }
    }
    async get(files: readonly string[], context: string, signal?: AbortSignal): Promise<ReadonlyMap<string, readonly Project[]>> {
        signal?.throwIfAborted(); await this.load(signal);
        const validation = new Validation(signal, this.hashes), result = new Map<string, EvaluationEntry>();
        await mapConcurrent(files, 4, signal, async file => {
            const entry = this.entries.get(file);
            if (!entry || entry.context !== context) {return;}
            try {if (await validation.stamp(entry.graph, entry.inputs, signal) === entry.stamp && this.entries.get(file) === entry) {result.set(file, entry);}}
            catch (error) {
                signal?.throwIfAborted();
                // An unreadable input requires normal inspection.
                this.log(`Project evaluation for ${path.basename(file)} could not be validated; evaluating it again. ${String(error)}\n`);
            }
        });
        // An earlier completed root may be retired or superseded while a sibling
        // is still validating. Recheck every captured entry at final publication.
        return new Map([...result].filter(([file, entry]) => this.entries.get(file) === entry).map(([file, entry]) => [file, entry.graph] as const));
    }
    async put(graphs: ReadonlyMap<string, readonly Project[]>, context: string, signal?: AbortSignal, dotnetRoot?: string): Promise<void> {
        signal?.throwIfAborted(); await this.load(signal);
        const validation = new Validation(signal, this.hashes), staged = new Map<string, EvaluationEntry>(), revision = ++this.revision;
        for (const file of graphs.keys()) {this.replacements.set(file, revision);}
        try {
        await mapConcurrent([...graphs], 4, signal, async ([file, graph]) => {
            const inputs = evaluationInputs.get(graph);
            if (!inputs || dotnetRoot && inputs.some(input => !within(input.sdkDirectory, path.join(dotnetRoot, 'sdk')))) {return;}
            try {
                const stamp = await validation.stamp(graph, inputs, signal);
                if (stamp) {staged.set(file, { graph, inputs, context, stamp,
                    projectInputs: this.storage ? await validation.projectInputs(graph, inputs, signal) : undefined });}
            } catch (error) {
                signal?.throwIfAborted();
                // Caching must not turn a successful inspection into a failure.
                this.log(`Project evaluation for ${path.basename(file)} will not be reused. ${String(error)}\n`);
            }
        });
        signal?.throwIfAborted();
        for (const file of graphs.keys()) {
            if (this.replacements.get(file) !== revision || this.live && !this.live.has(file)) {continue;}
            if (this.entries.delete(file)) {this.dirty = true;}
            const entry = staged.get(file);
            if (entry) {this.entries.set(file, entry); this.dirty = true;}
        }
        this.revision++; await this.save(signal); signal?.throwIfAborted();
        } finally {
            for (const file of graphs.keys()) {if (this.replacements.get(file) === revision) {this.replacements.delete(file);}}
        }
    }
    private async save(signal?: AbortSignal): Promise<void> {
        if (!this.storage) {return;}
        const saving = this.pending.catch(() => undefined).then(async () => {
            signal?.throwIfAborted(); if (!this.dirty) {return;}
            const revision = this.revision;
            try {
                await writeEvaluationSnapshot(this.storage!, new Map(this.entries), this.limits, signal, this.log);
                this.loaded = true;
                if (this.revision === revision) {this.dirty = false;}
            } catch (error) {
                signal?.throwIfAborted();
                // Persistence is optional; retry after the next admission or clean disposal.
                this.log(`Project evaluations could not be saved. ${String(error)}\n`);
            }
        });
        this.pending = saving; await saving;
    }
    async dispose(): Promise<void> {await this.save();}
}
