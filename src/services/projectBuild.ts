import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Project } from '../core/model';
import { pathNormalizer, preparePathNormalizer, testTargetKey } from '../core/paths';
import { ProcessOptions, ProcessResult, requireSuccess, runProcess } from './process';
import { buildContexts, contextId, escapeMsbuild, parallelism, xml } from './projectGraph';

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

async function runProjectBatch(dotnet: string, body: string, target: string, options: ProcessOptions, concurrency: number, description: string, properties: readonly string[] = []): Promise<void> {
    options.signal?.throwIfAborted();
    const ended = options.track?.(description, 'build', { target });
    try {await runProjectBatchNow(dotnet, body, target, options, concurrency, description, properties); ended?.({ succeeded: true });}
    catch (error) {ended?.({ succeeded: false }); throw error;}
}

async function runProjectBatchNow(dotnet: string, body: string, target: string, options: ProcessOptions, concurrency: number, description: string, properties: readonly string[]): Promise<void> {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'testy-msbuild-'));
    try {
        const query = path.join(directory, 'batch.proj');
        await fs.writeFile(query, `<Project>${body}</Project>`);
        const build = (env: ProcessOptions['env']): Promise<ProcessResult> => runProcess(dotnet, ['msbuild', query, '-nologo', `-target:${target}`,
            `-maxcpucount:${parallelism(concurrency)}`, '-property:NuGetInteractive=false', ...properties], { ...options, env });
        let result = await build(options.env);
        // A failure that reports no diagnostic can come from the MSBuild server itself, for example when it is busy or exits
        // mid-build; the same build without it is authoritative. Build errors are reported as they are.
        if (result.code !== 0 && options.env?.DOTNET_CLI_USE_MSBUILD_SERVER === '1' && !/\b(?:error|warning) [A-Z]+\d+/i.test(result.stdout + result.stderr)) {
            options.signal?.throwIfAborted();
            options.output?.('The MSBuild server build failed without a diagnostic; building again without the server.\n');
            result = await build({ ...options.env, DOTNET_CLI_USE_MSBUILD_SERVER: '0' });
        }
        requireSuccess(result, description);
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
        // A graph context's global properties are exactly those MSBuild builds it with when another project references it; they name a
        // TargetFramework only for a multi-targeting project's inner build. Adding one to a single-targeting project would make a second
        // instance of it in this session, building into the same outputs in parallel with the referenced one.
        const properties = project.properties ? { Configuration: configuration, ...project.properties } : { Configuration: configuration, TargetFramework: project.framework };
        const values = Object.entries(properties).map(([key, value]) => `${key}=${escapeMsbuild(value)}`).join(';');
        return `<_TestyBuild Include="${xml(escapeMsbuild(project.file))}"><AdditionalProperties>${xml(values)}</AdditionalProperties></_TestyBuild>`;
    }).join('');
    await runProjectBatch(dotnet, `<ItemGroup>${items}</ItemGroup><Target Name="Build"><MSBuild Projects="@(_TestyBuild)" Targets="Build" BuildInParallel="true" StopOnFirstFailure="true"/></Target>`,
        'Build', { ...options, env: buildServerEnvironment(options.env) }, concurrency, `Building ${projects.length} project${projects.length === 1 ? '' : 's'}`);
}

/** Every save builds again, so builds keep MSBuild's entry node alive between them (the MSBuild server), the way the compiler
 * server already is: an incremental build then skips process start and warms nothing up again. A value the user set wins. */
export function buildServerEnvironment(env: NodeJS.ProcessEnv | undefined, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return env?.DOTNET_CLI_USE_MSBUILD_SERVER !== undefined || inherited.DOTNET_CLI_USE_MSBUILD_SERVER !== undefined ? { ...env } : { ...env, DOTNET_CLI_USE_MSBUILD_SERVER: '1' };
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
function outputOverlap(normalize: (file: string) => string): (left: string, right: string) => boolean {
    return (left, right) => {
        const a = normalize(left).replace(/\/$/, ''), b = normalize(right).replace(/\/$/, '');
        return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    };
}

/** Proper ancestors of a normalized directory, nearest first. */
function ancestors(directory: string): string[] {
    const result: string[] = [];
    for (let index = directory.lastIndexOf('/'); index > 0; index = directory.lastIndexOf('/', index - 1)) {result.push(directory.slice(0, index));}
    return result;
}

/** Finds entries whose directory equals, contains, or lies inside a queried directory,
 * in time proportional to path depth rather than the number of entries. */
class DirectoryIndex<T> {
    private readonly exact = new Map<string, T[]>();
    private readonly below = new Map<string, T[]>();
    add(directory: string, value: T): void {
        const add = (map: Map<string, T[]>, key: string): void => {const values = map.get(key); if (values) {values.push(value);} else {map.set(key, [value]);}};
        add(this.exact, directory);
        for (const ancestor of ancestors(directory)) {add(this.below, ancestor);}
    }
    *overlapping(directory: string): Generator<T> {
        yield* this.exact.get(directory) ?? [];
        yield* this.below.get(directory) ?? [];
        for (const ancestor of ancestors(directory)) {yield* this.exact.get(ancestor) ?? [];}
    }
}

/** The output and binary directories buildSnapshotTargets and buildWaves compare, resolved
 * asynchronously. Without it both resolve them with synchronous filesystem calls. */
export async function prepareBuildPaths(projects: readonly Project[], signal?: AbortSignal): Promise<(file: string) => string> {
    return preparePathNormalizer(buildContexts(projects).flatMap(project => [...outputDirectories(project), path.dirname(project.assembly),
        ...(project.binaryReferences ?? []).map(assembly => path.dirname(assembly))]), signal);
}

/** Freeze a test binary before another context can overwrite any part of its output. */
export function buildSnapshotTargets(projects: readonly Project[], roots: readonly Project[] = buildRoots(projects), normalize = pathNormalizer()): ReadonlySet<string> {
    const contexts = buildContexts(projects);
    const overlaps = outputOverlap(normalize);
    return new Set(roots.filter(root => root.isTestProject && root.entryPoint !== false && contexts.some(project =>
        contextId(project) !== contextId(root) && outputDirectories(project).some(directory => overlaps(path.dirname(root.assembly), directory))))
        .map(root => testTargetKey(root.file, root.framework)));
}

/** Compatible roots share one MSBuild session. Order output conflicts and binary
 * consumers across waves so snapshots remain valid and binary inputs stay stable. */
export function buildWaves(projects: readonly Project[], roots: readonly Project[] = buildRoots(projects), sdkByFile?: ReadonlyMap<string, string>,
    normalize = pathNormalizer()): readonly (readonly Project[])[] {
    const contexts = buildContexts(projects), byId = new Map(contexts.map(project => [contextId(project), project]));
    const directory = (value: string): string => normalize(value).replace(/\/$/, '');
    const written = new Map<string, readonly string[]>();
    const writes = (project: Project): readonly string[] => {
        const id = contextId(project);
        let directories = written.get(id);
        if (!directories) {directories = [...new Set(outputDirectories(project).map(directory))]; written.set(id, directories);}
        return directories;
    };
    const byFile = new Map<string, Project[]>(), byAssembly = new Map<string, Project[]>();
    for (const project of contexts) {
        const files = byFile.get(project.file) ?? []; files.push(project); byFile.set(project.file, files);
        const assemblies = byAssembly.get(project.assembly) ?? []; assemblies.push(project); byAssembly.set(project.assembly, assemblies);
    }
    interface Plan {
        readonly root: Project; readonly index: number; readonly predecessors: Set<Plan>;
        readonly writes: readonly Project[]; readonly binaries: ReadonlySet<string>; readonly reads: readonly string[];
    }
    const plans = roots.map((root, index): Plan => {
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
        return { root, index, predecessors: new Set<Plan>(), writes: [...writes.values()], binaries, reads: [...new Set([...binaries].map(assembly => directory(path.dirname(assembly))))] };
    });
    const rootPlan = new Map(plans.map(plan => [contextId(plan.root), plan]));
    // Index every plan's writes and reads once, then look up only overlapping entries.
    interface Write { readonly plan: Plan; readonly context: string; }
    const writesByDirectory = new DirectoryIndex<Write>(), readsByDirectory = new DirectoryIndex<Plan>();
    const writesByFile = new Map<string, Write[]>();
    for (const plan of plans) {
        for (const project of plan.writes) {
            const write = { plan, context: contextId(project) };
            for (const output of writes(project)) {writesByDirectory.add(output, write);}
            const files = writesByFile.get(project.file) ?? []; files.push(write); writesByFile.set(project.file, files);
        }
        for (const read of plan.reads) {readsByDirectory.add(read, plan);}
    }
    const sameSdk = (left: Plan, right: Plan): boolean => !sdkByFile || (sdkByFile.has(left.root.file) && sdkByFile.has(right.root.file)
        && sdkByFile.get(left.root.file) === sdkByFile.get(right.root.file));
    // The later root waits for the earlier one.
    const order = (left: Plan, right: Plan): void => {
        if (left === right) {return;}
        if (left.index < right.index) {right.predecessors.add(left);} else {left.predecessors.add(right);}
    };
    for (const plan of plans) {
        for (const assembly of plan.binaries) {
            const producers = byAssembly.get(assembly) ?? [], producer = producers.find(project => project.entryPoint) ?? producers[0];
            if (!producer) {continue;}
            const dependency = rootPlan.get(contextId(producer));
            if (dependency !== undefined && dependency !== plan) {plan.predecessors.add(dependency);}
        }
        for (const project of plan.writes) {
            const context = contextId(project);
            // The same exact context under the same SDK is one shared build, not a conflict.
            const competing = (other: Write): boolean => other.plan !== plan && !(sameSdk(plan, other.plan) && other.context === context);
            for (const other of writesByFile.get(project.file) ?? []) {if (competing(other)) {order(plan, other.plan);}}
            for (const output of writes(project)) {
                for (const other of writesByDirectory.overlapping(output)) {if (competing(other)) {order(plan, other.plan);}}
                // A plan reading a binary output must not overlap a build that writes it.
                for (const reader of readsByDirectory.overlapping(output)) {order(plan, reader);}
            }
        }
    }
    const complete = new Set<Plan>(), result: Project[][] = [];
    while (complete.size !== plans.length) {
        const ready = plans.filter(plan => !complete.has(plan) && [...plan.predecessors].every(dependency => complete.has(dependency)));
        if (!ready.length) {throw new Error('Build roots have conflicting dependency order.');}
        result.push(ready.map(plan => plan.root)); ready.forEach(plan => complete.add(plan));
    }
    return result;
}
