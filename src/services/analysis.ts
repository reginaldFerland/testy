import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { contentHash, normalizePath } from '../core/paths';
import { Project } from '../core/model';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { analyzerServers, AnalyzerRequestFailed, AnalyzerServerUnavailable } from './analyzerServer';
import { roslynIdentity } from './analysisContext';

export { disposeAnalyzerServers } from './analyzerServer';

/** Run one analyzer request. A long-lived server answers it when one can be used; otherwise
 * (it could not start, crashed, or the protocol broke) a one-shot process does. One-shot
 * responses are written to a file: stdout is a bounded diagnostic tail and cannot carry
 * arbitrarily large results. */
async function analyze(dotnet: string, analyzer: string, storage: string, prefix: string, request: string, operation: string, options: ProcessOptions): Promise<string> {
    try {return await analyzerServers.request(dotnet, analyzer, request, options, await roslynIdentity(dotnet, options));}
    catch (error) {
        if (error instanceof AnalyzerRequestFailed) {throw new Error(`${operation} failed.\n${error.message}`);}
        if (!(error instanceof AnalyzerServerUnavailable)) {throw error;}
        options.signal?.throwIfAborted();
    }
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, prefix));
    try {
        const input = path.join(directory, 'request.json'), output = path.join(directory, 'response.json');
        await fs.writeFile(input, request);
        // A process that serves one request never recoups the cost of Tier-0 instrumentation.
        requireSuccess(await runProcess(dotnet, [analyzer, input, output], { ...options, output: undefined, env: { ...options.env, DOTNET_TieredPGO: '0' } }), operation);
        return await fs.readFile(output, 'utf8');
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

export async function sourceLocations(dotnet: string, analyzer: string, assembly: string, storage: string, options: ProcessOptions): Promise<ReadonlyMap<string, { file: string; line: number }>> {
    const output = await analyze(dotnet, analyzer, storage, 'symbols-', JSON.stringify({ assembly }), 'Reading portable symbols', options);
    const values = JSON.parse(output) as Record<string, { file?: string; line?: number } | null>;
    return new Map(Object.entries(values).filter((entry): entry is [string, { file: string; line: number }] =>
        typeof entry[1]?.file === 'string' && Number.isSafeInteger(entry[1]?.line) && entry[1].line! > 0)
        .map(([key, value]) => [key, { file: normalizePath(value.file), line: value.line }]));
}

export interface SourceShape {
    readonly signature: string;
    readonly body: string;
    readonly partialTypes: readonly string[];
    readonly excludedTypes: readonly string[];
}

const workers = (concurrency: number): number => Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(name => typeof name === 'string');
const aliasesEqual = (left: readonly string[], right: readonly string[]): boolean => {
    const expected = new Set(left), actual = new Set(right);
    return expected.size === actual.size && [...expected].every(alias => actual.has(alias));
};
function sourceShape(value: unknown): value is SourceShape {
    const hash = (value: unknown): value is string => typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
    const shape = value as Partial<SourceShape> | null;
    return !!shape && hash(shape.signature) && hash(shape.body) && names(shape.partialTypes) && names(shape.excludedTypes);
}

export interface SourceAnalysisBatch {
    readonly aliases: readonly string[];
    readonly analyses: ReadonlyMap<string, SourceShape | null>;
    /** Present only for a complete response bound to the exact request bytes. */
    readonly sourceHashes?: ReadonlyMap<string, string>;
}
export interface SourceAliasUpdate {
    readonly sources: readonly string[];
    readonly allFiles: readonly string[];
}

/** Resolve changed aliases and analyze their affected files in one process.
 * A complete response is required before callers may publish the alias state. */
export async function sourceAnalysisBatch(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions,
    excludedAliases: readonly string[] = [], concurrency = 1, aliasUpdate?: SourceAliasUpdate, provenance = false): Promise<SourceAnalysisBatch> {
    options.signal?.throwIfAborted();
    if (!aliasUpdate || !aliasUpdate.sources.length) {
        const aliases = aliasUpdate ? [] : excludedAliases;
        const selected = aliasUpdate && !aliasesEqual(aliases, excludedAliases) ? aliasUpdate.allFiles : files;
        if (!provenance) {return { aliases, analyses: await sourceAnalyses(dotnet, analyzer, selected, storage, options, aliases, concurrency) };}
        if (!selected.length) {return { aliases, analyses: new Map(), sourceHashes: new Map() };}
        files = selected; excludedAliases = aliases; aliasUpdate = undefined;
    }
    const request = JSON.stringify({ files, excludedAliases, aliasSources: aliasUpdate?.sources, allFiles: aliasUpdate?.allFiles,
        concurrency: workers(concurrency), ...(provenance ? { provenance: true } : {}) });
    const output = await analyze(dotnet, analyzer, storage, 'analysis-', request, 'Analyzing C# declarations and aliases', options);
    const parsed: unknown = JSON.parse(output);
    const value = parsed as Partial<{ aliases: unknown; analyses: Record<string, unknown>; version: unknown; requestHash: unknown; sourceHashes: Record<string, unknown> }> | null;
    if (!value || !names(value.aliases) || !value.analyses || typeof value.analyses !== 'object' || Array.isArray(value.analyses)) {
        throw new Error('Invalid combined source analysis response.');
    }
    if (!aliasUpdate && !aliasesEqual(value.aliases, excludedAliases)) {throw new Error('Unexpected source analysis aliases.');}
    const selected = aliasUpdate && !aliasesEqual(value.aliases, excludedAliases) ? aliasUpdate.allFiles : files;
    const expected = new Set(selected);
    if (Object.keys(value.analyses).length !== expected.size) {throw new Error('Incomplete combined source analysis response.');}
    if (provenance && (value.version !== 1 || value.requestHash !== contentHash(request).toUpperCase()
        || !value.sourceHashes || typeof value.sourceHashes !== 'object' || Array.isArray(value.sourceHashes)
        || Object.keys(value.sourceHashes).length !== expected.size)) {throw new Error('Invalid source analysis provenance.');}
    const analyses = new Map<string, SourceShape | null>();
    const sourceHashes = new Map<string, string>();
    for (const file of expected) {
        if (!Object.hasOwn(value.analyses, file)) {throw new Error('Incomplete combined source analysis response.');}
        const shape = value.analyses[file];
        if (shape !== null && !sourceShape(shape)) {throw new Error('Invalid combined source analysis record.');}
        const normalized = normalizePath(file);
        if (provenance) {
            const hash = value.sourceHashes![file];
            if (!Object.hasOwn(value.sourceHashes!, file) || (hash !== null && (typeof hash !== 'string' || !/^[A-F0-9]{64}$/.test(hash)))
                || (shape !== null && hash === null)) {throw new Error('Invalid source analysis hash.');}
            if (typeof hash === 'string') {sourceHashes.set(normalized, hash.toLowerCase());}
        }
        analyses.set(normalized, shape);
    }
    options.signal?.throwIfAborted();
    return { aliases: value.aliases, analyses, ...(provenance ? { sourceHashes } : {}) };
}

/** Parse global aliases with the same C# syntax rules as declaration analysis. */
export async function sourceAliases(dotnet: string, analyzer: string, contents: readonly string[], storage: string, options: ProcessOptions): Promise<readonly string[]> {
    if (!contents.length) {return [];}
    const aliases: unknown = JSON.parse(await analyze(dotnet, analyzer, storage, 'aliases-', JSON.stringify({ aliasSources: contents }), 'Analyzing global C# aliases', options));
    if (!names(aliases)) {throw new Error('Invalid C# alias response.');}
    return aliases;
}

/** Resolve cross-file exclusions using incremental syntax records, not rereads. */
export function resolveShapes(analyses: ReadonlyMap<string, SourceShape | null>, projects?: readonly Pick<Project, 'sourceFiles' | 'analysisFiles'>[]): ReadonlyMap<string, string | null> {
    const bodies = new Set<string>();
    for (const files of projects?.map(project => project.analysisFiles ?? project.sourceFiles) ?? [[...analyses.keys()]]) {
        const excluded = new Set(files.flatMap(file => analyses.get(file)?.excludedTypes ?? []));
        if (!excluded.size) {continue;}
        for (const file of files) {
            if (excluded.has('*') || analyses.get(file)?.partialTypes.some(type => excluded.has(type))) {bodies.add(file);}
        }
    }
    return new Map([...analyses].map(([file, shape]) => [file, !shape ? null : bodies.has(file) ? shape.body : shape.signature]));
}

/** Declaration fingerprints catch dependencies that runtime coverage cannot see. */
export async function sourceAnalyses(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions, excludedAliases: readonly string[] = [], concurrency = 1): Promise<ReadonlyMap<string, SourceShape | null>> {
    if (!files.length) {return new Map();}
    const output = await analyze(dotnet, analyzer, storage, 'analysis-', JSON.stringify({ files, excludedAliases, concurrency: workers(concurrency) }), 'Analyzing C# declarations', options);
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Invalid source analysis response.');}
    const result = new Map<string, SourceShape | null>();
    for (const file of files) {
        const value = (parsed as Record<string, Partial<SourceShape> | null>)[file];
        result.set(normalizePath(file), sourceShape(value) ? value : null);
    }
    return result;
}

export async function sourceShapes(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions, excludedAliases: readonly string[] = [], concurrency = 1): Promise<ReadonlyMap<string, string | null>> {
    return resolveShapes(await sourceAnalyses(dotnet, analyzer, files, storage, options, excludedAliases, concurrency));
}
