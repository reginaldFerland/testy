import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { contentHash, preparePathNormalizer } from '../core/paths';
import { Project } from '../core/model';
import type { MemberBody } from '../core/memberImpact';
import { EnvironmentError } from '../core/errors';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { AnalyzerRequestFailed, AnalyzerServers, AnalyzerServerUnavailable } from './analyzerServer';
import { roslynIdentity } from './analysisContext';
import { untilAborted } from '../core/concurrency';

export interface AnalysisOptions extends ProcessOptions {
    /** The long-lived analyzer processes of the caller (the engine owns and disposes them); without them, every request runs a one-shot process. */
    readonly analyzerServers?: AnalyzerServers | undefined;
}

/** roslynIdentity resolves the host and stats every installed SDK, which is too much for each request of a
 * burst. Concurrent and near-simultaneous requests share one answer; an SDK change is noticed within the window. */
const identityWindowMs = 5_000;
const identities = new Map<string, { readonly at: number; readonly identity: Promise<string> }>();
function cachedRoslynIdentity(dotnet: string, options: ProcessOptions): Promise<string> {
    const env = { ...process.env, ...options.env };
    const key = JSON.stringify([dotnet, options.cwd, env.PATH ?? env.Path ?? null, env.PATHEXT ?? null, env.TESTY_ROSLYN_DIR ?? null]);
    const now = Date.now(), known = identities.get(key);
    if (known && now - known.at < identityWindowMs) {return options.signal ? untilAborted(known.identity, options.signal) : known.identity;}
    // Shared work must not die with its first caller's cancellation; each caller stops waiting on its own.
    const identity = roslynIdentity(dotnet, { ...options, signal: undefined });
    if (identities.size >= 16) {identities.delete(identities.keys().next().value!);}
    identities.set(key, { at: now, identity });
    return options.signal ? untilAborted(identity, options.signal) : identity;
}

/** Run one analyzer request. A long-lived server answers it when one can be used; otherwise
 * (none was given, it could not start, crashed, or the protocol broke) a one-shot process does. One-shot
 * responses are written to a file: stdout is a bounded diagnostic tail and cannot carry
 * arbitrarily large results. */
async function analyze(dotnet: string, analyzer: string, storage: string, prefix: string, request: string, operation: string, options: AnalysisOptions): Promise<string> {
    const { analyzerServers, ...processOptions } = options;
    if (analyzerServers) {
        try {return await analyzerServers.request(dotnet, analyzer, request, processOptions, await cachedRoslynIdentity(dotnet, processOptions));}
        catch (error) {
            if (error instanceof AnalyzerRequestFailed) {throw new EnvironmentError('analyzer', `${operation} failed.\n${error.message}`);}
            if (!(error instanceof AnalyzerServerUnavailable)) {throw error;}
            options.signal?.throwIfAborted();
        }
    }
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, prefix));
    try {
        const input = path.join(directory, 'request.json'), output = path.join(directory, 'response.json');
        await fs.writeFile(input, request);
        // A process that serves one request never recoups the cost of Tier-0 instrumentation.
        requireSuccess(await runProcess(dotnet, [analyzer, input, output], { ...processOptions, output: undefined, env: { ...options.env, DOTNET_TieredPGO: '0' } }), operation);
        return await fs.readFile(output, 'utf8');
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

/** The marker of in-code coverage suppression (see backend CoverageSuppression), searched for before asking the analyzer. */
export const suppressionMarker = /testy:\s*no coverage/i;

/** The collector's function-exclusion patterns of each file's `// testy: no coverage` members (see backend CoverageSuppression). */
export async function coverageSuppressions(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: AnalysisOptions): Promise<ReadonlyMap<string, readonly string[]>> {
    if (!files.length) {return new Map();}
    const value: unknown = JSON.parse(await analyze(dotnet, analyzer, storage, 'suppressions-', JSON.stringify({ suppressions: files }), 'Reading coverage suppressions', options));
    if (!value || typeof value !== 'object') {throw new Error('Unexpected coverage suppression response.');}
    return new Map(Object.entries(value).map(([file, patterns]) => [file, Array.isArray(patterns) ? patterns.filter((pattern): pattern is string => typeof pattern === 'string') : []]));
}

/** Collector settings that leave the matching functions uninstrumented (`dotnet-coverage instrument --settings`). */
export function suppressionSettings(patterns: readonly string[]): string {
    const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="utf-8"?>\n<Configuration><CodeCoverage><Functions><Exclude>${patterns.map(pattern => `<Function>${escape(pattern)}</Function>`).join('')}</Exclude></Functions></CodeCoverage></Configuration>\n`;
}

export async function sourceLocations(dotnet: string, analyzer: string, assembly: string, storage: string, options: AnalysisOptions): Promise<ReadonlyMap<string, { file: string; line: number }>> {
    const output = await analyze(dotnet, analyzer, storage, 'symbols-', JSON.stringify({ assembly }), 'Reading portable symbols', options);
    const values = JSON.parse(output) as Record<string, { file?: string; line?: number } | null>;
    const entries = Object.entries(values).filter((entry): entry is [string, { file: string; line: number }] =>
        typeof entry[1]?.file === 'string' && Number.isSafeInteger(entry[1].line) && entry[1].line! > 0);
    const normalize = await preparePathNormalizer(entries.map(([, value]) => value.file), options.signal);
    return new Map(entries.map(([key, value]) => [key, { file: normalize(value.file), line: value.line }]));
}

export interface SourceShape {
    readonly signature: string;
    readonly body: string;
    readonly partialTypes: readonly string[];
    readonly excludedTypes: readonly string[];
    /** Executable bodies in document order and the fingerprints of the text around them (see core/memberImpact). */
    readonly members?: readonly MemberBody[];
    readonly gaps?: readonly string[];
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
    return !!shape && hash(shape.signature) && hash(shape.body) && names(shape.partialTypes) && names(shape.excludedTypes)
        && (shape.members === undefined || (Array.isArray(shape.members) && shape.members.every(member => memberBody(member, hash))))
        && (shape.gaps === undefined || (Array.isArray(shape.gaps) && shape.gaps.every(gap => hash(gap))));
}
function memberBody(value: unknown, hash: (value: unknown) => value is string): value is MemberBody {
    const member = value as Partial<MemberBody> | null;
    return !!member && Number.isSafeInteger(member.start) && Number.isSafeInteger(member.end) && member.start! > 0 && member.end! >= member.start! && hash(member.hash);
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
export async function sourceAnalysisBatch(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: AnalysisOptions,
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
    const normalize = await preparePathNormalizer(expected, options.signal);
    let work = 0;
    for (const file of expected) {
        // Responses can hold tens of thousands of records; validate them in slices.
        if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
        if (!Object.hasOwn(value.analyses, file)) {throw new Error('Incomplete combined source analysis response.');}
        const shape = value.analyses[file];
        if (shape !== null && !sourceShape(shape)) {throw new Error('Invalid combined source analysis record.');}
        const normalized = normalize(file);
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
export async function sourceAliases(dotnet: string, analyzer: string, contents: readonly string[], storage: string, options: AnalysisOptions): Promise<readonly string[]> {
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
export async function sourceAnalyses(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: AnalysisOptions, excludedAliases: readonly string[] = [], concurrency = 1): Promise<ReadonlyMap<string, SourceShape | null>> {
    if (!files.length) {return new Map();}
    const output = await analyze(dotnet, analyzer, storage, 'analysis-', JSON.stringify({ files, excludedAliases, concurrency: workers(concurrency) }), 'Analyzing C# declarations', options);
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Invalid source analysis response.');}
    const result = new Map<string, SourceShape | null>(), normalize = await preparePathNormalizer(files, options.signal);
    let work = 0;
    for (const file of files) {
        if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
        const value = (parsed as Record<string, Partial<SourceShape> | null>)[file];
        result.set(normalize(file), sourceShape(value) ? value : null);
    }
    return result;
}

export async function sourceShapes(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: AnalysisOptions, excludedAliases: readonly string[] = [], concurrency = 1): Promise<ReadonlyMap<string, string | null>> {
    return resolveShapes(await sourceAnalyses(dotnet, analyzer, files, storage, options, excludedAliases, concurrency));
}
