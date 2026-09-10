import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePath } from '../core/paths';
import { Project } from '../core/model';
import { ProcessOptions, requireSuccess, runProcess } from './process';

export async function sourceLocations(dotnet: string, analyzer: string, assembly: string, storage: string, options: ProcessOptions): Promise<ReadonlyMap<string, { file: string; line: number }>> {
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, 'symbols-'));
    try {
        const input = path.join(directory, 'assembly.json');
        await fs.writeFile(input, JSON.stringify({ assembly }));
        const result = requireSuccess(await runProcess(dotnet, [analyzer, input], { ...options, output: undefined }), 'Reading portable symbols');
        const values = JSON.parse(result.stdout) as Record<string, { File?: string; Line?: number } | null>;
        return new Map(Object.entries(values).filter((entry): entry is [string, { File: string; Line: number }] =>
            typeof entry[1]?.File === 'string' && Number.isSafeInteger(entry[1]?.Line) && entry[1]!.Line! > 0)
            .map(([key, value]) => [key, { file: normalizePath(value.File), line: value.Line }]));
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

export interface SourceShape {
    readonly signature: string;
    readonly body: string;
    readonly partialTypes: readonly string[];
    readonly excludedTypes: readonly string[];
}

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
}
export interface SourceAliasUpdate {
    readonly sources: readonly string[];
    readonly allFiles: readonly string[];
}

/** Resolve changed aliases and analyze their affected files in one process.
 * A complete response is required before callers may publish the alias state. */
export async function sourceAnalysisBatch(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions,
    excludedAliases: readonly string[] = [], concurrency = 1, aliasUpdate?: SourceAliasUpdate): Promise<SourceAnalysisBatch> {
    options.signal?.throwIfAborted();
    if (!aliasUpdate || !aliasUpdate.sources.length) {
        const aliases = aliasUpdate ? [] : excludedAliases;
        const selected = aliasUpdate && !aliasesEqual(aliases, excludedAliases) ? aliasUpdate.allFiles : files;
        return { aliases, analyses: await sourceAnalyses(dotnet, analyzer, selected, storage, options, aliases, concurrency) };
    }
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, 'analysis-'));
    try {
        const input = path.join(directory, 'files.json');
        await fs.writeFile(input, JSON.stringify({ files, excludedAliases, aliasSources: aliasUpdate.sources, allFiles: aliasUpdate.allFiles,
            concurrency: Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1 }));
        const output = requireSuccess(await runProcess(dotnet, [analyzer, input], { ...options, output: undefined }), 'Analyzing C# declarations and aliases').stdout;
        const parsed: unknown = JSON.parse(output);
        const value = parsed as Partial<{ aliases: unknown; analyses: Record<string, unknown> }> | null;
        if (!value || !names(value.aliases) || !value.analyses || typeof value.analyses !== 'object' || Array.isArray(value.analyses)) {
            throw new Error('Invalid combined source analysis response.');
        }
        const selected = aliasesEqual(value.aliases, excludedAliases) ? files : aliasUpdate.allFiles;
        const expected = new Set(selected);
        if (Object.keys(value.analyses).length !== expected.size) {throw new Error('Incomplete combined source analysis response.');}
        const analyses = new Map<string, SourceShape | null>();
        for (const file of expected) {
            if (!Object.hasOwn(value.analyses, file)) {throw new Error('Incomplete combined source analysis response.');}
            const shape = value.analyses[file];
            if (shape !== null && !sourceShape(shape)) {throw new Error('Invalid combined source analysis record.');}
            analyses.set(normalizePath(file), shape);
        }
        options.signal?.throwIfAborted();
        return { aliases: value.aliases, analyses };
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

/** Parse global aliases with the same C# syntax rules as declaration analysis. */
export async function sourceAliases(dotnet: string, analyzer: string, contents: readonly string[], storage: string, options: ProcessOptions): Promise<readonly string[]> {
    if (!contents.length) {return [];}
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, 'aliases-'));
    try {
        const input = path.join(directory, 'input.json');
        await fs.writeFile(input, JSON.stringify({ aliasSources: contents }));
        const result = requireSuccess(await runProcess(dotnet, [analyzer, input], { ...options, output: undefined }), 'Analyzing global C# aliases');
        const aliases: unknown = JSON.parse(result.stdout);
        if (!names(aliases)) {throw new Error('Invalid C# alias response.');}
        return aliases;
    } finally {await fs.rm(directory, { recursive: true, force: true });}
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
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, 'analysis-'));
    try {
        const input = path.join(directory, 'files.json');
        await fs.writeFile(input, JSON.stringify({ files, excludedAliases, concurrency: Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1 }));
        const output = requireSuccess(await runProcess(dotnet, [analyzer, input], { ...options, output: undefined }), 'Analyzing C# declarations').stdout;
        const parsed: unknown = JSON.parse(output);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Invalid source analysis response.');}
        const result = new Map<string, SourceShape | null>();
        for (const file of files) {
            const value = (parsed as Record<string, Partial<SourceShape> | null>)[file];
            result.set(normalizePath(file), sourceShape(value) ? value : null);
        }
        return result;
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

export async function sourceShapes(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions, excludedAliases: readonly string[] = [], concurrency = 1): Promise<ReadonlyMap<string, string | null>> {
    return resolveShapes(await sourceAnalyses(dotnet, analyzer, files, storage, options, excludedAliases, concurrency));
}
