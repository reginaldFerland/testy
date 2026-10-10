import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineConfiguration } from './services/engine';
import { additionalConfigurations } from './core/buildConfigurations';
import { defaultExcludes } from './core/paths';

export interface Configuration extends EngineConfiguration {
    readonly enabled: boolean;
    readonly trigger: 'save' | 'fileSystem';
    readonly debounce: number;
    readonly pattern: string;
    readonly showCoverage: boolean;
    /** Extra build configurations offered as manual Run and Coverage profiles. */
    readonly additionalConfigurations: readonly string[];
}

export const defaultWatcherPattern = '**/*.{cs,csproj,sln,slnx,slnf,props,targets,runsettings,json,config,resx,editorconfig,globalconfig,ruleset}';

/** One engine serves every workspace folder, so settings are window-scoped (see
 * package.json) and read without a resource. A relative `testy.solution` resolves
 * against the first folder; `${workspaceFolder}` and `${workspaceFolder:name}` are expanded. */
export function configuration(): Configuration {
    const settings = vscode.workspace.getConfiguration('testy');
    const args = settings.get<string[]>('testArguments', []);
    return {
        enabled: settings.get('autoRun', true), trigger: settings.get('trigger', 'save'),
        debounce: Math.max(0, settings.get('debounceTime', 500)),
        pattern: settings.get('fileWatcherPattern', defaultWatcherPattern),
        showCoverage: settings.get('showCoverage', false),
        additionalConfigurations: additionalConfigurations(settings.get<string[]>('additionalConfigurations', []), settings.get('buildConfiguration', 'Debug')),
        dotnet: settings.get('dotnetPath', 'dotnet'), configuration: settings.get('buildConfiguration', 'Debug'),
        mode: settings.get('runMode', 'affected'), coverage: settings.get('runWithCoverage', true),
        maxParallelProjects: settings.get('maxParallelProjects', 0),
        maxParallelTestFiles: settings.get('maxParallelTestFiles', 0),
        excludes: [...defaultExcludes, ...settings.get<string[]>('exclude', [])],
        testArguments: args, timeout: Math.max(10, settings.get('timeoutSeconds', 600)) * 1000,
        coverageTool: settings.get<string>('coverageToolPath') || undefined,
        solution: resolveSolution(settings.get<string>('solution', '')),
        projects: { include: settings.get<string[]>('projects.include', []), exclude: settings.get<string[]>('projects.exclude', []) }
    };
}

function resolveSolution(value: string): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const expanded = value.trim().replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (match, name?: string) => {
        const folder = name ? folders.find(candidate => candidate.name === name) : folders[0];
        return folder?.uri.fsPath ?? match;
    });
    if (!expanded) {return undefined;}
    return path.isAbsolute(expanded) || !folders.length ? expanded : path.join(folders[0].uri.fsPath, expanded);
}
