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

/** Build each project once, with both project and workspace binary inputs ready. */
export function buildOrder(projects: readonly Project[], selected: ReadonlySet<string>): readonly Project[] {
    const byFile = new Map<string, Project[]>();
    const byAssembly = new Map(projects.map(project => [project.assembly, project.file]));
    for (const project of projects) {const targets = byFile.get(project.file) ?? []; targets.push(project); byFile.set(project.file, targets);}
    const ordered: Project[] = [], complete = new Set<string>(), visiting = new Set<string>();
    const visit = (file: string): void => {
        if (complete.has(file)) {return;}
        if (visiting.has(file)) {throw new Error(`Project references form a cycle at ${file}.`);}
        visiting.add(file);
        for (const project of byFile.get(file) ?? []) {
            for (const reference of [...project.references, ...(project.binaryReferences ?? []).map(assembly => byAssembly.get(assembly)).filter((file): file is string => !!file)]) {visit(reference);}
        }
        visiting.delete(file); complete.add(file); ordered.push(...byFile.get(file) ?? []);
    };
    for (const file of selected) {visit(file);}
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
            assemblies: union(previous.assemblies ?? [previous.assembly], project.assemblies ?? [project.assembly]),
            sourceFiles: union(previous.sourceFiles, project.sourceFiles), inputs: union(previous.inputs ?? [], project.inputs ?? []),
            references: union(previous.references, project.references), binaryReferences: union(previous.binaryReferences ?? [], project.binaryReferences ?? []) });
    }
    return [...merged.values()];
}

/** MSBuild builds project edges in their proper property contexts. Binary edges still need explicit producers. */
export function buildRoots(projects: readonly Project[]): readonly Project[] {
    const referenced = new Set(projects.flatMap(project => [...project.references]));
    const binaries = new Set(projects.flatMap(project => [...project.binaryReferences ?? []]));
    return projects.filter(project => !referenced.has(project.file) || binaries.has(project.assembly) || (project.isTestProject && project.entryPoint !== false));
}
