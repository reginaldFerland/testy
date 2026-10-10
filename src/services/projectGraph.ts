import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { Project } from '../core/model';
import { isExcluded, normalizePathAsync, preparePathNormalizer } from '../core/paths';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { EvaluationInputs, evaluationInputs } from './projectEvaluationCache';
import { sdkConfigurationCandidates } from './projectDiscovery';

export const contextId = (project: Project): string => project.contextId ?? `${project.file}\0${project.framework}`;

/** Keep exact SDK contexts for execution; file unions are only for ownership. */
export function buildContexts(projects: readonly Project[]): readonly Project[] {
    const contexts = new Map<string, Project>();
    for (const project of projects) {for (const context of project.contexts ?? [project]) {
        const id = contextId(context), previous = contexts.get(id);
        contexts.set(id, previous ? { ...context, entryPoint: previous.entryPoint || context.entryPoint } : context);
    }}
    return [...contexts.values()];
}

export const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const escapeMsbuild = (value: string): string => value.replace(/[%;,"$@'()*?]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
export const parallelism = (value: number): number => Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1);

/** A test project that Testy cannot run is kept in the graph so it still builds
 * and its sources keep their ownership, but it is never discovered or executed. */
export function unsupportedTestReason(project: Pick<Project, 'file' | 'framework' | 'isTestProject'> & { readonly isMtp?: boolean }): string | undefined {
    if (!project.isTestProject) {return undefined;}
    if (project.isMtp === false) {return `${path.basename(project.file)} (${project.framework}) uses VSTest; Testy requires Microsoft.Testing.Platform.`;}
    if (Number(/^net(\d+)\./.exec(project.framework)?.[1] ?? 0) < 10) {return `${path.basename(project.file)} targets ${project.framework}; Testy requires .NET 10 or later.`;}
    return undefined;
}

/** The project-graph output format this reader understands (ProjectGraphOutput.Current in the helper). */
const graphVersion = 2;

/** Evaluate shared dependencies once, retaining each entry point's exact snapshot.
 * All files must select the SDK used by options.cwd (see sdkContextGroups).
 * digestCache names a directory where the helper keeps SDK file digests between evaluations. */
export async function evaluateProjects(dotnet: string, files: readonly string[], configuration: string, options: ProcessOptions, analyzer: string, concurrency = 1, digestCache?: string): Promise<ReadonlyMap<string, readonly Project[]>> {
    if (!files.length) {return new Map();}
    options.signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testy-graph-'));
    try {
        const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.json'), query = path.join(directory, 'query.proj');
        await fs.writeFile(input, JSON.stringify({ files: [...new Set(files)], configuration, concurrency: parallelism(concurrency), ...digestCache ? { digestCache } : {} }));
        // Attribute values are expanded by MSBuild, so '%', '$(' and ';' in a path need escaping too.
        const attribute = (value: string): string => xml(escapeMsbuild(value));
        await fs.writeFile(query, `<Project><UsingTask TaskName="Testy.Analysis.ProjectGraphTask" AssemblyFile="${attribute(analyzer)}"/><Target Name="Inspect"><ProjectGraphTask RequestFile="${attribute(input)}" OutputFile="${attribute(output)}"/></Target></Project>`);
        // The task DLL must not stay loaded in a reused node or MSBuild server,
        // which would lock the extension's files and serve a stale task after updates.
        requireSuccess(await runProcess(dotnet, ['msbuild', query, '-nologo', '-nodeReuse:false', '-target:Inspect', `-maxcpucount:${parallelism(concurrency)}`],
            { ...options, output: undefined, env: { ...options.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDNOINPROCNODE: undefined } }), `Inspecting ${files.length} project${files.length === 1 ? '' : 's'}`);
        const graph = JSON.parse(await fs.readFile(output, { encoding: 'utf8', signal: options.signal })) as {
            version?: number;
            projects: (Project & { isMtp: boolean })[];
            roots: { file: string; contexts: string[]; entryPoints: string[]; evaluation?: (string | EvaluationInputs)[] }[];
            evaluations?: Readonly<Record<string, EvaluationInputs>>;
        };
        if (graph.version !== graphVersion) {throw new Error(`Project inspection returned an unsupported graph version: ${String(graph.version)}.`);}
        // Every path in the graph, resolved before the synchronous mapping below.
        const normalize = await preparePathNormalizer([...files, ...graph.roots.map(root => root.file), ...graph.projects.flatMap(project => [
            project.file, project.assembly, ...project.sourceFiles, ...project.inputs ?? [], ...sdkConfigurationCandidates(project.file),
            ...project.outputDirectories ?? [], ...project.references, ...project.binaryReferences ?? []])], options.signal);
        // Exclusion matching costs microseconds per path: a large graph yields between slices.
        let work = 0;
        const included = async (files: readonly string[]): Promise<string[]> => {
            const kept: string[] = [];
            for (const file of files) {
                if (!isExcluded(file)) {kept.push(file);}
                if (++work % 1024 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
            }
            return kept;
        };
        const projects = new Map<string, Project>();
        for (const project of graph.projects) {
            const unsupported = unsupportedTestReason(project);
            const paths = (files: readonly string[]): string[] => [...new Set(files.map(normalize))];
            const analysisFiles = paths(project.sourceFiles);
            const normalized: Project = { ...project, file: normalize(project.file), assembly: normalize(project.assembly), runner: 'mtp',
                analysisFiles,
                sourceFiles: await included(analysisFiles),
                inputs: await included(paths([...project.inputs ?? [], ...sdkConfigurationCandidates(project.file)])),
                outputDirectories: paths(project.outputDirectories ?? []),
                references: paths(project.references), binaryReferences: paths(project.binaryReferences ?? []),
                ...unsupported ? { unsupported } : {} };
            projects.set(contextId(normalized), normalized);
            await yieldTurn(); options.signal?.throwIfAborted();
        }
        const result = new Map<string, readonly Project[]>();
        for (const root of graph.roots) {
            const entries = new Set(root.entryPoints);
            const snapshot = root.contexts.map(id => {
                const project = projects.get(id);
                if (!project) {throw new Error(`Project inspection returned an unknown context: ${id}`);}
                return { ...project, entryPoint: entries.has(id) };
            });
            if (root.evaluation) {
                const metadata = root.evaluation.map(input => typeof input === 'string' ? graph.evaluations?.[input] : input);
                if (metadata.every((input): input is EvaluationInputs => !!input)) {evaluationInputs.set(snapshot, metadata);}
            }
            result.set(normalize(root.file), snapshot);
        }
        for (const file of files) {if (!result.has(normalize(file))) {throw new Error(`Project inspection omitted ${file}.`);}}
        return result;
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

/** Single-entry compatibility adapter used by callers with a narrow refresh. */
export async function evaluateProject(dotnet: string, file: string, configuration: string, options: ProcessOptions, analyzer: string): Promise<readonly Project[]> {
    return (await evaluateProjects(dotnet, [file], configuration, options, analyzer)).get(await normalizePathAsync(file))!;
}

/** Union ownership across contexts; execute each workspace entry point only once. */
export function mergeProjects(projects: readonly Project[]): readonly Project[] {
    const merged = new Map<string, Project>();
    for (const project of projects) {
        const key = `${project.file}\0${project.framework}`, previous = merged.get(key);
        if (!previous) {merged.set(key, project); continue;}
        const preferred = project.entryPoint ? project : previous;
        const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
        merged.set(key, { ...preferred, entryPoint: previous.entryPoint || project.entryPoint,
            contexts: [...previous.contexts ?? [previous], ...project.contexts ?? [project]],
            assemblies: union(previous.assemblies ?? [previous.assembly], project.assemblies ?? [project.assembly]),
            sourceFiles: union(previous.sourceFiles, project.sourceFiles), inputs: union(previous.inputs ?? [], project.inputs ?? []),
            analysisFiles: union(previous.analysisFiles ?? previous.sourceFiles, project.analysisFiles ?? project.sourceFiles),
            references: union(previous.references, project.references), binaryReferences: union(previous.binaryReferences ?? [], project.binaryReferences ?? []) });
    }
    return [...merged.values()];
}

/** Compare the evaluated information for each physical project independent of
 * serialization order and its entry-point role in a particular snapshot. */
function graphState(graph: readonly Project[]): ReadonlyMap<string, string> {
    const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
    // Serialize each element once; sorting then compares cached keys, not fresh JSON.
    const canonical = (value: unknown): unknown => Array.isArray(value)
        ? value.map(item => { const canonicalItem = canonical(item); return { canonicalItem, key: JSON.stringify(canonicalItem) }; })
            .sort((a, b) => ordinal(a.key, b.key)).map(item => item.canonicalItem)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => ordinal(a, b)).map(([key, value]) => [key, canonical(value)])) : value;
    const byFile = new Map<string, string[]>();
    for (const project of graph) {
        const records = byFile.get(project.file) ?? [];
        records.push(JSON.stringify(canonical({ ...project, entryPoint: undefined })));
        byFile.set(project.file, records);
    }
    return new Map([...byFile].map(([file, records]) => [file, JSON.stringify([...new Set(records)].sort())]));
}

/** Replace whole evaluation snapshots, including removals. Refresh overlapping
 * roots together so an older snapshot cannot resurrect a shared dependency edge. */
export async function refreshProjectSnapshots(
    previous: ReadonlyMap<string, readonly Project[]>, entryPoints: readonly string[], selected: readonly string[] | undefined,
    evaluate: (file: string) => Promise<readonly Project[]>
): Promise<ReadonlyMap<string, readonly Project[]>> {
    return refreshProjectSnapshotBatches(previous, entryPoints, selected, async files => {
        const snapshots = new Map<string, readonly Project[]>();
        for (const file of files) {snapshots.set(file, await evaluate(file));}
        return snapshots;
    });
}

/** Refresh selected snapshots in waves, batching newly affected overlapping roots. */
export async function refreshProjectSnapshotBatches(
    previous: ReadonlyMap<string, readonly Project[]>, entryPoints: readonly string[], selected: readonly string[] | undefined,
    evaluate: (files: readonly string[]) => Promise<ReadonlyMap<string, readonly Project[]>>
): Promise<ReadonlyMap<string, readonly Project[]>> {
    const live = new Set(entryPoints);
    const next = new Map([...previous].filter(([file]) => live.has(file)));
    let queue = selected ? selected.filter(file => live.has(file)) : [...entryPoints];
    const seen = new Set<string>(), touched = new Set<string>();
    while (queue.length) {
        const files = [...new Set(queue)].filter(file => !seen.has(file));
        if (!files.length) {break;}
        files.forEach(file => seen.add(file));
        const evaluated = await evaluate(files);
        for (const file of files) {
            const graph = evaluated.get(file);
            if (!graph) {throw new Error(`Project inspection omitted ${file}.`);}
            if (selected) {
                const before = graphState(previous.get(file) ?? []), after = graphState(graph);
                for (const file of new Set([...before.keys(), ...after.keys()])) {
                    if (before.get(file) !== after.get(file)) {touched.add(file);}
                }
            }
            next.set(file, graph);
        }
        queue = [];
        if (selected) {for (const [root, snapshot] of next) {
            if (!seen.has(root) && snapshot.some(node => touched.has(node.file))) {queue.push(root);}
        }}
    }
    return next;
}
