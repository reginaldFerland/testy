import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { defaultExcludes, isExcluded, isInside, matchesPattern, normalizePath, normalizePathAsync, normalizePathsAsync, preparePathNormalizer } from '../core/paths';
import { parseSolution } from '../core/solution';
import { mapConcurrent, Semaphore, walkTree } from '../core/concurrency';
import { EnvironmentError } from '../core/errors';

/** `onUnowned` receives every other file the walk finds outside the directory of each project it finds (the same walk, so a
 * large workspace is read once). A directory is visited after its parent, so the parent's ownership is known by then. */
export async function findProjects(roots: readonly string[], excludes: readonly string[] = defaultExcludes, signal?: AbortSignal, concurrency = 16,
    onSkipped?: (directory: string, error: Error) => void, onUnowned?: (file: string) => void): Promise<readonly string[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {throw new Error('Worker limit must be a positive integer.');}
    signal?.throwIfAborted();
    const result = new Set<string>();
    const visited = new Set<string>();
    const owned = new Set<string>();
    const visit = async (directory: string): Promise<string[]> => {
        // Keys are real paths, so symlink cycles and aliased directories are visited once.
        const key = await normalizePathAsync(directory);
        const children: string[] = [];
        if (visited.has(key)) {return children;}
        visited.add(key);
        let entries;
        try {entries = await fs.readdir(directory, { withFileTypes: true });}
        catch (error) {
            // Unreadable directories (volumes owned by another user, races with
            // deletion) cannot contain projects Testy could build anyway.
            const [skipped, ...normalizedRoots] = await normalizePathsAsync([directory, ...roots], signal);
            if (skipped !== undefined && !normalizedRoots.includes(skipped)
                && ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                onSkipped?.(directory, error as Error); return children;
            }
            throw error;
        }
        const files: string[] = [];
        let project = false;
        for (const entry of entries) {
            signal?.throwIfAborted();
            const file = path.join(directory, entry.name);
            let directoryEntry = entry.isDirectory(), fileEntry = entry.isFile();
            if (entry.isSymbolicLink()) {
                // A Dirent describes the link itself; follow it (broken links are skipped).
                try {const target = await fs.stat(file); directoryEntry = target.isDirectory(); fileEntry = target.isFile();}
                catch {continue;}
            }
            if (isExcluded(directoryEntry ? `${file}/` : file, excludes, roots)) {continue;}
            if (directoryEntry) {children.push(file);}
            else if (fileEntry && /\.csproj$/i.test(entry.name)) {result.add(await normalizePathAsync(file)); project = true;}
            else if (fileEntry && onUnowned) {files.push(file);}
        }
        if (project || owned.has(path.dirname(directory))) {owned.add(directory);}
        else if (onUnowned) {for (const file of files) {onUnowned(file);}}
        return children;
    };
    // One shared queue: a slow directory delays only itself, not its whole level.
    await walkTree(roots, visit, new Semaphore(concurrency), signal, concurrency);
    signal?.throwIfAborted();
    return [...result].sort();
}

/** SDK resolution walks project ancestors, including paths outside the workspace. */
export function sdkConfigurationCandidates(file: string): readonly string[] {
    const files: string[] = [];
    for (let directory = path.dirname(file);;) {
        files.push(path.join(directory, 'global.json'));
        const parent = path.dirname(directory);
        if (parent === directory) {return files;}
        directory = parent;
    }
}

export interface EntryPointFilter {
    /** A .sln, .slnx or .slnf whose projects limit the workspace entry points. */
    readonly solution?: string | undefined;
    /** Solutions that limit only the entry points inside `root`. */
    readonly solutions?: readonly { readonly file: string; readonly root: string }[] | undefined;
    readonly include?: readonly string[] | undefined;
    readonly exclude?: readonly string[] | undefined;
}

/** Limit discovered entry points to a solution and include/exclude globs. Returns the
 * files that define the filter too, so edits to them refresh the project structure. */
export async function filterEntryPoints(found: readonly string[], filter: EntryPointFilter, roots: readonly string[], signal?: AbortSignal): Promise<{ readonly entryPoints: readonly string[]; readonly inputs: readonly string[] }> {
    let entryPoints = found;
    const inputs: string[] = [];
    for (const { file, root } of [...filter.solution ? [{ file: filter.solution, root: undefined }] : [], ...filter.solutions ?? []]) {
        const solution = await normalizePathAsync(file);
        inputs.push(solution);
        let content: string;
        try {content = await fs.readFile(solution, { encoding: 'utf8', signal });}
        catch (error) {signal?.throwIfAborted(); throw new EnvironmentError('configuration', `testy.solution could not be read: ${solution}. ${(error as Error).message}`);}
        const listed = parseSolution(solution, content);
        if (listed.solution) {inputs.push(await normalizePathAsync(listed.solution));}
        const allowed = new Set(await normalizePathsAsync(listed.projects, signal));
        const scope = root === undefined ? undefined : await normalizePathAsync(root);
        entryPoints = entryPoints.filter(project => allowed.has(project) || (scope !== undefined && !isInside(project, scope)));
    }
    if (filter.include?.length) {entryPoints = entryPoints.filter(file => filter.include!.some(pattern => matchesPattern(file, pattern, roots)));}
    if (filter.exclude?.length) {entryPoints = entryPoints.filter(file => !filter.exclude!.some(pattern => matchesPattern(file, pattern, roots)));}
    if (found.length && !entryPoints.length) {
        throw new EnvironmentError('configuration', 'testy.solution and testy.projects exclude every project in the workspace. Check those settings.');
    }
    return { entryPoints, inputs };
}

export function sdkConfigurationFiles(file: string): readonly string[] {
    return sdkConfigurationCandidates(file).map(normalizePath);
}

/** Share an SDK host only when its global.json search resolves to the same pin. */
export async function sdkContextGroups(files: readonly string[], signal?: AbortSignal): Promise<readonly { key: string; cwd: string; files: readonly string[] }[]> {
    const pins = new Map<string, Promise<string>>();
    // Every directory the search can visit and its candidate, resolved without blocking the host.
    const candidates = [...new Set(files)].flatMap(sdkConfigurationCandidates);
    const normalize = await preparePathNormalizer([...candidates, ...candidates.map(file => path.dirname(file))], signal);
    const pin = (directory: string): Promise<string> => {
        const key = normalize(directory), previous = pins.get(key);
        if (previous) {return previous;}
        const pending = (async () => {
            signal?.throwIfAborted();
            const file = path.join(directory, 'global.json');
            try {if ((await fs.stat(file)).isFile()) {return normalize(file);}}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}}
            const parent = path.dirname(directory);
            return parent === directory ? '' : pin(parent);
        })();
        pins.set(key, pending); return pending;
    };
    const entries = await mapConcurrent([...new Set(files)], 16, signal, async file => ({ file, key: await pin(path.dirname(file)) }));
    const groups = new Map<string, { key: string; cwd: string; files: string[] }>();
    for (const { file, key } of entries) {
        const group = groups.get(key) ?? { key, cwd: path.dirname(file), files: [] };
        group.files.push(file); groups.set(key, group);
    }
    return [...groups.values()];
}
