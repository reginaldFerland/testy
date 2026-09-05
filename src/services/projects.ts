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

interface Evaluation {
    readonly Properties: Record<string, string>;
    readonly Items: Record<string, readonly { readonly FullPath: string }[]>;
}

export async function evaluateProject(dotnet: string, file: string, configuration: string, options: ProcessOptions, framework?: string): Promise<readonly Project[]> {
    const result = requireSuccess(await runProcess(dotnet, ['msbuild', file, '-nologo',
        `-property:Configuration=${configuration}`, ...framework ? [`-property:TargetFramework=${framework}`] : [],
        '-getProperty:TargetPath,TargetFramework,TargetFrameworks,IsTestProject,IsTestingPlatformApplication', '-getItem:Compile,ProjectReference'
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
    const isTestProject = p.IsTestProject === 'true' || p.IsTestingPlatformApplication === 'true';
    if (isTestProject && p.IsTestingPlatformApplication !== 'true') {throw new Error(`${path.basename(file)} uses VSTest. Testy 1.0 requires a Microsoft.Testing.Platform test project targeting .NET 10 or later.`);}
    if (isTestProject && Number(/^net(\d+)\./.exec(p.TargetFramework)?.[1] ?? 0) < 10) {throw new Error(`${path.basename(file)} targets ${p.TargetFramework}. Testy requires test projects targeting .NET 10 or later.`);}
    return [{
        file: normalizePath(file), framework: p.TargetFramework, assembly: p.TargetPath ? normalizePath(p.TargetPath) : '',
        isTestProject, runner: 'mtp',
        sourceFiles: (parsed.Items.Compile ?? []).map(item => normalizePath(item.FullPath)).filter(file => !isExcluded(file)),
        references: (parsed.Items.ProjectReference ?? []).map(item => normalizePath(item.FullPath))
    }];
}
