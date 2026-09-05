import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../core/model';
import { defaultExcludes, isExcluded, normalizePath } from '../core/paths';
import { ProcessOptions, requireSuccess, runProcess } from './process';

export async function findProjects(roots: readonly string[], excludes: readonly string[] = defaultExcludes, signal?: AbortSignal): Promise<readonly string[]> {
    const result = new Set<string>();
    async function visit(directory: string): Promise<void> {
        signal?.throwIfAborted();
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            signal?.throwIfAborted();
            const file = path.join(directory, entry.name);
            if (isExcluded(entry.isDirectory() ? `${file}/` : file, excludes, roots)) {continue;}
            if (entry.isDirectory()) {await visit(file);}
            else if (entry.isFile() && entry.name.endsWith('.csproj')) {result.add(normalizePath(file));}
        }
    }
    for (const root of roots) {await visit(root);}
    signal?.throwIfAborted();
    return [...result].sort();
}

const contextId = (project: Project): string => project.contextId ?? `${project.file}\0${project.framework}`;

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

/** Preserve reference property contexts by asking the selected SDK to evaluate its graph. */
export async function evaluateProject(dotnet: string, file: string, configuration: string, options: ProcessOptions, analyzer: string): Promise<readonly Project[]> {
    const directory = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'testy-graph-'));
    const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    try {
        const input = path.join(directory, 'input.json'), output = path.join(directory, 'output.json'), query = path.join(directory, 'query.proj');
        await fs.writeFile(input, JSON.stringify({ file, configuration }));
        await fs.writeFile(query, `<Project><UsingTask TaskName="Testy.Analysis.ProjectGraphTask" AssemblyFile="${xml(analyzer)}"/><Target Name="Inspect"><ProjectGraphTask RequestFile="${xml(input)}" OutputFile="${xml(output)}"/></Target></Project>`);
        requireSuccess(await runProcess(dotnet, ['msbuild', query, '-nologo', '-target:Inspect'], { ...options, output: undefined }), `Inspecting ${path.basename(file)}`);
        const graph = JSON.parse(await fs.readFile(output, { encoding: 'utf8', signal: options.signal })) as (Project & { isMtp: boolean })[];
        return graph.map(project => {
            if (project.isTestProject && !project.isMtp) {throw new Error(`${path.basename(project.file)} uses VSTest. Testy requires a Microsoft.Testing.Platform test project.`);}
            if (project.isTestProject && Number(/^net(\d+)\./.exec(project.framework)?.[1] ?? 0) < 10) {throw new Error(`${path.basename(project.file)} targets ${project.framework}. Testy requires test projects targeting .NET 10 or later.`);}
            const paths = (files: readonly string[]): string[] => [...new Set(files.map(normalizePath))];
            return { ...project, file: normalizePath(project.file), assembly: normalizePath(project.assembly), runner: 'mtp',
                analysisFiles: paths(project.sourceFiles),
                sourceFiles: paths(project.sourceFiles).filter(file => !isExcluded(file)), inputs: paths(project.inputs ?? []).filter(file => !isExcluded(file)),
                references: paths(project.references), binaryReferences: paths(project.binaryReferences ?? []) };
        });
    } finally {await fs.rm(directory, { recursive: true, force: true });}
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
    const live = new Set(entryPoints);
    const next = new Map([...previous].filter(([file]) => live.has(file)));
    const queue = selected ? selected.filter(file => live.has(file)) : [...entryPoints];
    const seen = new Set<string>(), touched = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
        const file = queue[index]; if (seen.has(file)) {continue;} seen.add(file);
        const graph = await evaluate(file);
        const before = graphState(previous.get(file) ?? []), after = graphState(graph);
        for (const file of new Set([...before.keys(), ...after.keys()])) {
            if (before.get(file) !== after.get(file)) {touched.add(file);}
        }
        next.set(file, graph);
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
