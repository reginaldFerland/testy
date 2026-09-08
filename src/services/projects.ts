import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../core/model';
import { defaultExcludes, isExcluded, normalizePath, pathNormalizer, testTargetKey } from '../core/paths';
import { mapConcurrent } from '../core/concurrency';
import { ProcessOptions, requireSuccess, runProcess } from './process';

export async function findProjects(roots: readonly string[], excludes: readonly string[] = defaultExcludes, signal?: AbortSignal, concurrency = 16): Promise<readonly string[]> {
    const result = new Set<string>();
    const visited = new Set<string>();
    let pending = [...roots];
    while (pending.length) {
        const directories = pending.filter(directory => {
            const key = normalizePath(directory);
            if (visited.has(key)) {return false;}
            visited.add(key); return true;
        });
        const next = await mapConcurrent(directories, concurrency, signal, async (directory, _index, workerSignal) => {
            const children: string[] = [];
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                workerSignal.throwIfAborted();
                const file = path.join(directory, entry.name);
                if (isExcluded(entry.isDirectory() ? `${file}/` : file, excludes, roots)) {continue;}
                if (entry.isDirectory()) {children.push(file);}
                else if (entry.isFile() && entry.name.endsWith('.csproj')) {result.add(normalizePath(file));}
            }
            return children;
        });
        pending = next.flat();
    }
    signal?.throwIfAborted();
    return [...result].sort();
}

const contextId = (project: Project): string => project.contextId ?? `${project.file}\0${project.framework}`;

/** SDK resolution walks project ancestors, including paths outside the workspace. */
function sdkConfigurationCandidates(file: string): readonly string[] {
    const files: string[] = [];
    for (let directory = path.dirname(file);;) {
        files.push(path.join(directory, 'global.json'));
        const parent = path.dirname(directory);
        if (parent === directory) {return files;}
        directory = parent;
    }
}

export function sdkConfigurationFiles(file: string): readonly string[] {
    return sdkConfigurationCandidates(file).map(normalizePath);
}

/** Share an SDK host only when its global.json search resolves to the same pin. */
export async function sdkContextGroups(files: readonly string[], signal?: AbortSignal): Promise<readonly { key: string; cwd: string; files: readonly string[] }[]> {
    const pins = new Map<string, Promise<string>>();
    const normalize = pathNormalizer();
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

/** Keep exact SDK contexts for execution; file unions are only for ownership. */
function buildContexts(projects: readonly Project[]): readonly Project[] {
    const contexts = new Map<string, Project>();
    for (const project of projects) {for (const context of project.contexts ?? [project]) {
        const id = contextId(context), previous = contexts.get(id);
        contexts.set(id, previous ? { ...context, entryPoint: previous.entryPoint || context.entryPoint } : context);
    }}
    return [...contexts.values()];
}

/** Visit context-specific project edges and explicit workspace binary producers. */
export function buildOrder(projects: readonly Project[], selected: ReadonlySet<string>): readonly Project[] {
    const contexts = buildContexts(projects);
    const byId = new Map(contexts.map(project => [contextId(project), project]));
    const byFile = new Map<string, Project[]>();
    const byAssembly = new Map<string, Project[]>();
    for (const project of contexts) {
        const targets = byFile.get(project.file) ?? []; targets.push(project); byFile.set(project.file, targets);
        const producers = byAssembly.get(project.assembly) ?? []; producers.push(project); byAssembly.set(project.assembly, producers);
    }
    const ordered: Project[] = [], complete = new Set<string>(), visiting = new Set<string>();
    const visit = (project: Project): void => {
        const id = contextId(project);
        if (complete.has(id)) {return;}
        if (visiting.has(id)) {throw new Error(`Project references form a cycle at ${project.file}.`);}
        visiting.add(id);
        const references = project.contextReferences
            ? project.contextReferences.map(reference => byId.get(reference)).filter((node): node is Project => !!node)
            : project.references.flatMap(file => byFile.get(file) ?? []);
        for (const assembly of project.binaryReferences ?? []) {
            const producers = byAssembly.get(assembly) ?? [];
            // Graphs without SDK context metadata use file-level planning.
            const producer = producers.find(node => node.entryPoint) ?? producers[0];
            if (producer) {references.push(...(project.contextId ? [producer] : byFile.get(producer.file) ?? []));}
        }
        for (const reference of references) {visit(reference);}
        visiting.delete(id); complete.add(id); ordered.push(project);
    };
    for (const file of selected) {for (const project of byFile.get(file) ?? []) {visit(project);}}
    return ordered;
}

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeMsbuild = (value: string): string => value.replace(/[%;,"$@'()*?]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const parallelism = (value: number): number => Math.max(1, Number.isFinite(value) ? Math.trunc(value) : 1);

/** Evaluate shared dependencies once, retaining each entry point's exact snapshot.
 * All files must select the SDK used by options.cwd (see sdkContextGroups). */
export async function evaluateProjects(dotnet: string, files: readonly string[], configuration: string, options: ProcessOptions, analyzer: string, concurrency = 1): Promise<ReadonlyMap<string, readonly Project[]>> {
    if (!files.length) {return new Map();}
    options.signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'testy-graph-'));
    try {
        const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.json'), query = path.join(directory, 'query.proj');
        await fs.writeFile(input, JSON.stringify({ files: [...new Set(files)], configuration, concurrency: parallelism(concurrency) }));
        await fs.writeFile(query, `<Project><UsingTask TaskName="Testy.Analysis.ProjectGraphTask" AssemblyFile="${xml(analyzer)}"/><Target Name="Inspect"><ProjectGraphTask RequestFile="${xml(input)}" OutputFile="${xml(output)}"/></Target></Project>`);
        requireSuccess(await runProcess(dotnet, ['msbuild', query, '-nologo', '-target:Inspect', `-maxcpucount:${parallelism(concurrency)}`], { ...options, output: undefined }), `Inspecting ${files.length} project${files.length === 1 ? '' : 's'}`);
        const graph = JSON.parse(await fs.readFile(output, { encoding: 'utf8', signal: options.signal })) as {
            projects: (Project & { isMtp: boolean })[];
            roots: { file: string; contexts: string[]; entryPoints: string[] }[];
        };
        const normalize = pathNormalizer();
        const projects = new Map(graph.projects.map(project => {
            if (project.isTestProject && !project.isMtp) {throw new Error(`${path.basename(project.file)} uses VSTest. Testy requires a Microsoft.Testing.Platform test project.`);}
            if (project.isTestProject && Number(/^net(\d+)\./.exec(project.framework)?.[1] ?? 0) < 10) {throw new Error(`${path.basename(project.file)} targets ${project.framework}. Testy requires test projects targeting .NET 10 or later.`);}
            const paths = (files: readonly string[]): string[] => [...new Set(files.map(normalize))];
            const analysisFiles = paths(project.sourceFiles);
            const normalized: Project = { ...project, file: normalize(project.file), assembly: normalize(project.assembly), runner: 'mtp',
                analysisFiles,
                sourceFiles: analysisFiles.filter(file => !isExcluded(file)),
                inputs: paths([...project.inputs ?? [], ...sdkConfigurationCandidates(project.file)]).filter(file => !isExcluded(file)),
                outputDirectories: paths(project.outputDirectories ?? []),
                references: paths(project.references), binaryReferences: paths(project.binaryReferences ?? []) };
            return [contextId(normalized), normalized] as const;
        }));
        const result = new Map<string, readonly Project[]>();
        for (const root of graph.roots) {
            const entries = new Set(root.entryPoints);
            result.set(normalize(root.file), root.contexts.map(id => {
                const project = projects.get(id);
                if (!project) {throw new Error(`Project inspection returned an unknown context: ${id}`);}
                return { ...project, entryPoint: entries.has(id) };
            }));
        }
        for (const file of files) {if (!result.has(normalize(file))) {throw new Error(`Project inspection omitted ${file}.`);}}
        return result;
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

/** Single-entry compatibility adapter used by callers with a narrow refresh. */
export async function evaluateProject(dotnet: string, file: string, configuration: string, options: ProcessOptions, analyzer: string): Promise<readonly Project[]> {
    return (await evaluateProjects(dotnet, [file], configuration, options, analyzer)).get(normalizePath(file))!;
}

async function runProjectBatch(dotnet: string, body: string, target: string, options: ProcessOptions, concurrency: number, description: string, properties: readonly string[] = []): Promise<void> {
    options.signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'testy-msbuild-'));
    try {
        const query = path.join(directory, 'batch.proj');
        await fs.writeFile(query, `<Project>${body}</Project>`);
        requireSuccess(await runProcess(dotnet, ['msbuild', query, '-nologo', `-target:${target}`, `-maxcpucount:${parallelism(concurrency)}`,
            '-property:NuGetInteractive=false', ...properties], options), description);
    } finally {await fs.rm(directory, { recursive: true, force: true });}
}

/** NuGet accepts explicit restore entry points and deduplicates their shared graph. */
export async function restoreProjects(dotnet: string, files: readonly string[], configuration: string, options: ProcessOptions, concurrency = 1): Promise<void> {
    if (!files.length) {return;}
    const items = [...new Set(files)].map(file => `<RestoreGraphProjectInputItems Include="${xml(escapeMsbuild(file))}"/>`).join('');
    await runProjectBatch(dotnet, `<ItemGroup>${items}</ItemGroup><Import Project="$(MSBuildToolsPath)/NuGet.targets"/>`, 'Restore', options, concurrency,
        `Restoring ${files.length} project${files.length === 1 ? '' : 's'}`, [`-property:Configuration=${escapeMsbuild(configuration)}`, '-property:RestoreBuildInParallel=true']);
}

/** Build compatible roots in one MSBuild session so common exact contexts are reused. */
export async function buildProjects(dotnet: string, projects: readonly Project[], configuration: string, options: ProcessOptions, concurrency = 1): Promise<void> {
    if (!projects.length) {return;}
    const items = projects.map(project => {
        const properties = { Configuration: configuration, TargetFramework: project.framework, ...project.properties };
        const values = Object.entries(properties).map(([key, value]) => `${key}=${escapeMsbuild(value)}`).join(';');
        return `<_TestyBuild Include="${xml(escapeMsbuild(project.file))}"><AdditionalProperties>${xml(values)}</AdditionalProperties></_TestyBuild>`;
    }).join('');
    await runProjectBatch(dotnet, `<ItemGroup>${items}</ItemGroup><Target Name="Build"><MSBuild Projects="@(_TestyBuild)" Targets="Build" BuildInParallel="true" StopOnFirstFailure="true"/></Target>`,
        'Build', options, concurrency, `Building ${projects.length} project${projects.length === 1 ? '' : 's'}`);
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

/** MSBuild follows exact project contexts; binary producers need explicit builds. */
export function buildRoots(projects: readonly Project[]): readonly Project[] {
    const contexts = buildContexts(projects);
    const byId = new Map(contexts.map(project => [contextId(project), project]));
    const byFile = new Map<string, Project[]>();
    for (const project of contexts) {
        const nodes = byFile.get(project.file) ?? []; nodes.push(project); byFile.set(project.file, nodes);
    }
    const references = (project: Project): readonly string[] => project.contextReferences
        ?? project.references.flatMap(file => (byFile.get(file) ?? []).map(contextId));
    const referenced = new Set(contexts.flatMap(project => [...references(project)]));
    const binaries = new Set(contexts.flatMap(project => [...project.binaryReferences ?? []]));
    const required = contexts.filter(project => binaries.has(project.assembly) || (project.isTestProject && project.entryPoint !== false));
    const roots = new Set(required.map(contextId)), coveredFiles = new Set<string>(), coveredContexts = new Set<string>();
    const cover = (root: Project): void => {
        const pending = [root];
        while (pending.length) {
            const project = pending.pop()!, id = contextId(project);
            if (coveredContexts.has(id)) {continue;}
            coveredContexts.add(id); coveredFiles.add(project.file);
            for (const reference of references(project)) {const node = byId.get(reference); if (node) {pending.push(node);}}
        }
    };
    required.forEach(cover);
    // A default workspace context is redundant when another selected root
    // builds that file with reference properties. Building both can overwrite
    // shared intermediate outputs before a binary consumer gets to use them.
    for (const project of contexts) {
        if (!referenced.has(contextId(project)) && !coveredFiles.has(project.file)) {roots.add(contextId(project)); cover(project);}
    }
    return contexts.filter(project => roots.has(contextId(project)));
}

const outputDirectories = (project: Project): readonly string[] => project.outputDirectories?.length
    ? project.outputDirectories : [path.dirname(project.assembly), path.join(path.dirname(project.file), 'obj')];
function outputOverlap(): (left: string, right: string) => boolean {
    const normalize = pathNormalizer();
    return (left, right) => {
        const a = normalize(left).replace(/\/$/, ''), b = normalize(right).replace(/\/$/, '');
        return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    };
}

/** Freeze a test binary before another context can overwrite any part of its output. */
export function buildSnapshotTargets(projects: readonly Project[], roots: readonly Project[] = buildRoots(projects)): ReadonlySet<string> {
    const contexts = buildContexts(projects);
    const overlaps = outputOverlap();
    return new Set(roots.filter(root => root.isTestProject && root.entryPoint !== false && contexts.some(project =>
        contextId(project) !== contextId(root) && outputDirectories(project).some(directory => overlaps(path.dirname(root.assembly), directory))))
        .map(root => testTargetKey(root.file, root.framework)));
}

/** Compatible roots share one MSBuild session. Order output conflicts and binary
 * consumers across waves so snapshots remain valid and binary inputs stay stable. */
export function buildWaves(projects: readonly Project[], roots: readonly Project[] = buildRoots(projects), sdkByFile?: ReadonlyMap<string, string>): readonly (readonly Project[])[] {
    const contexts = buildContexts(projects), byId = new Map(contexts.map(project => [contextId(project), project]));
    const overlaps = outputOverlap();
    const byFile = new Map<string, Project[]>(), byAssembly = new Map<string, Project[]>();
    for (const project of contexts) {
        const files = byFile.get(project.file) ?? []; files.push(project); byFile.set(project.file, files);
        const assemblies = byAssembly.get(project.assembly) ?? []; assemblies.push(project); byAssembly.set(project.assembly, assemblies);
    }
    const plans = roots.map(root => {
        const pending = [root], writes = new Map<string, Project>(), binaries = new Set<string>();
        while (pending.length) {
            const project = pending.pop()!, id = contextId(project);
            if (writes.has(id)) {continue;}
            writes.set(id, project);
            for (const assembly of project.binaryReferences ?? []) {binaries.add(assembly);}
            pending.push(...(project.contextReferences
                ? project.contextReferences.map(id => byId.get(id)).filter((node): node is Project => !!node)
                : project.references.flatMap(file => byFile.get(file) ?? [])));
        }
        return { root, writes: [...writes.values()], binaries, reads: [...binaries].map(assembly => path.dirname(assembly)) };
    });
    const predecessors = plans.map(() => new Set<number>());
    for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];
        for (const assembly of plan.binaries) {
            const producers = byAssembly.get(assembly) ?? [], producer = producers.find(project => project.entryPoint) ?? producers[0];
            if (!producer) {continue;}
            const dependency = plans.findIndex(candidate => contextId(candidate.root) === contextId(producer));
            if (dependency !== -1 && dependency !== index) {predecessors[index].add(dependency);}
        }
        for (let earlier = 0; earlier < index; earlier++) {
            const other = plans[earlier];
            const sameSdk = !sdkByFile || (sdkByFile.has(plan.root.file) && sdkByFile.has(other.root.file)
                && sdkByFile.get(plan.root.file) === sdkByFile.get(other.root.file));
            const competingWrites = plan.writes.some(a => other.writes.some(b =>
                !(sameSdk && contextId(a) === contextId(b)) && (a.file === b.file
                    || outputDirectories(a).some(left => outputDirectories(b).some(right => overlaps(left, right))))));
            const competingReads = plan.reads.some(read => other.writes.some(project => outputDirectories(project).some(write => overlaps(read, write))))
                || other.reads.some(read => plan.writes.some(project => outputDirectories(project).some(write => overlaps(read, write))));
            if (competingWrites || competingReads) {predecessors[index].add(earlier);}
        }
    }
    const complete = new Set<number>(), result: Project[][] = [];
    while (complete.size !== roots.length) {
        const ready = plans.map((_plan, index) => index).filter(index => !complete.has(index) && [...predecessors[index]].every(dependency => complete.has(dependency)));
        if (!ready.length) {throw new Error('Build roots have conflicting dependency order.');}
        result.push(ready.map(index => roots[index])); ready.forEach(index => complete.add(index));
    }
    return result;
}

/** Compare the evaluated information for each physical project independent of
 * serialization order and its entry-point role in a particular snapshot. */
function graphState(graph: readonly Project[]): ReadonlyMap<string, string> {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : value;
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

export function buildProperties(project: Project): string[] {
    const escape = (value: string): string => value.replace(/[%;,"]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return Object.entries(project.properties ?? {}).map(([key, value]) => `-property:${key}=${escape(value)}`);
}
