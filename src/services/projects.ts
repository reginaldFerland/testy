import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../core/model';
import { defaultExcludes, isExcluded, normalizePath } from '../core/paths';
import { ProcessOptions, requireSuccess, runProcess } from './process';

export async function findProjects(roots: readonly string[], excludes: readonly string[] = defaultExcludes): Promise<readonly string[]> {
    const result = new Set<string>();
    async function visit(directory: string): Promise<void> {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (isExcluded(entry.isDirectory() ? `${file}/` : file, excludes, roots)) {continue;}
            if (entry.isDirectory()) {await visit(file);}
            else if (entry.isFile() && entry.name.endsWith('.csproj')) {result.add(normalizePath(file));}
        }
    }
    for (const root of roots) {await visit(root);}
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

interface Evaluation {
    readonly Properties: Record<string, string>;
    readonly Items: Record<string, readonly { readonly FullPath: string; readonly HintPath?: string }[]>;
}

export async function evaluateProject(dotnet: string, file: string, configuration: string, options: ProcessOptions, framework?: string): Promise<readonly Project[]> {
    const result = requireSuccess(await runProcess(dotnet, ['msbuild', file, '-nologo',
        `-property:Configuration=${configuration}`, ...framework ? [`-property:TargetFramework=${framework}`] : [],
        '-getProperty:TargetPath,TargetFramework,TargetFrameworks,IsTestProject,IsTestingPlatformApplication', '-getItem:Compile,ProjectReference,Reference'
    ], { ...options, output: undefined }), `Inspecting ${path.basename(file)}`);
    let parsed: Evaluation;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error(`MSBuild did not return project information for ${file}.\n${result.stdout}`); }
    const p = parsed.Properties;
    if (!p || !parsed.Items) {throw new Error(`Incomplete project information for ${file}.`);}
    const frameworks = p.TargetFrameworks?.split(';').filter(Boolean) ?? [];
    if (!framework && frameworks.length) {
        const targets: Project[] = [];
        for (const target of frameworks) {targets.push(...await evaluateProject(dotnet, file, configuration, options, target));}
        return targets;
    }
    const isTestProject = p.IsTestProject?.toLowerCase() === 'true' || p.IsTestingPlatformApplication?.toLowerCase() === 'true';
    if (isTestProject && p.IsTestingPlatformApplication?.toLowerCase() !== 'true') {throw new Error(`${path.basename(file)} uses VSTest. Testy 1.0 requires a Microsoft.Testing.Platform test project targeting .NET 10 or later.`);}
    if (isTestProject && Number(/^net(\d+)\./.exec(p.TargetFramework)?.[1] ?? 0) < 10) {throw new Error(`${path.basename(file)} targets ${p.TargetFramework}. Testy requires test projects targeting .NET 10 or later.`);}
    return [{
        file: normalizePath(file), framework: p.TargetFramework, assembly: p.TargetPath ? normalizePath(p.TargetPath) : '',
        isTestProject, runner: 'mtp',
        sourceFiles: (parsed.Items.Compile ?? []).map(item => normalizePath(item.FullPath)).filter(file => !isExcluded(file)),
        references: (parsed.Items.ProjectReference ?? []).map(item => normalizePath(item.FullPath)),
        binaryReferences: (parsed.Items.Reference ?? []).filter(item => item.HintPath).map(item => normalizePath(path.resolve(path.dirname(file), item.HintPath!)))
    }];
}
