import * as path from 'node:path';
import * as vscode from 'vscode';
import { escape } from 'minimatch';
import { EngineConfiguration } from './core/model';
import { additionalConfigurations } from './core/buildConfigurations';
import { defaultExcludes, normalizePath } from './core/paths';

export interface Configuration extends EngineConfiguration {
    readonly enabled: boolean;
    readonly trigger: 'save' | 'fileSystem';
    readonly debounce: number;
    readonly pattern: string;
    readonly showCoverage: boolean;
    /** Extra build configurations offered as manual Run and Coverage profiles. */
    readonly additionalConfigurations: readonly string[];
    /** Resource-scoped settings whose folder-level values differ; one engine applies the workspace value. */
    readonly folderConflicts: readonly string[];
}

export const defaultWatcherPattern = '**/*.{cs,csproj,sln,slnx,slnf,props,targets,runsettings,json,config,resx,editorconfig,globalconfig,ruleset}';

interface Folder { readonly root: string; readonly name: string; readonly settings: vscode.WorkspaceConfiguration }

/** A glob limited to one folder: relative patterns are anchored at its root. */
function anchored(root: string, pattern: string): string {
    if (path.isAbsolute(pattern) || /^[a-z]:/i.test(pattern)) {return pattern;}
    return `${escape(root.replace(/\\/g, '/'), { windowsPathsNoEscape: true, magicalBraces: true })}/${pattern.replace(/^\.?\//, '')}`;
}

/**
 * One engine serves every workspace folder. Path settings (`solution`, `exclude`,
 * `projects.*`) are resource-scoped: in a multi-root workspace a folder-level value applies
 * to that folder's projects, with relative paths and globs resolved against it. Folder-level
 * `exclude`/`projects.exclude` add to the workspace patterns; folder-level `solution` and
 * `projects.include` replace the inherited value for that folder. `buildConfiguration` and
 * `testArguments` apply to the whole run, so differing folder values are reported and the
 * workspace value is used. `${workspaceFolder}` and `${workspaceFolder:name}` are expanded.
 */
export function configuration(): Configuration {
    const settings = vscode.workspace.getConfiguration('testy');
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const folders: Folder[] = workspaceFolders.length > 1
        ? workspaceFolders.map(folder => ({ root: normalizePath(folder.uri.fsPath), name: folder.name, settings: vscode.workspace.getConfiguration('testy', folder.uri) })) : [];
    const own = <T>(folder: Folder, key: string): T | undefined => folder.settings.inspect<T>(key)?.workspaceFolderValue;
    const conflicts: string[] = [];
    const uniform = <T>(key: string, fallback: T): T => {
        const base = settings.get<T>(key, fallback);
        const values = folders.map(folder => own<T>(folder, key) ?? base);
        if (!values.length || values.every(value => JSON.stringify(value) === JSON.stringify(values[0]))) {return values[0] ?? base;}
        conflicts.push(`testy.${key}`); return base;
    };
    const additive = (key: string): string[] => [...settings.get<string[]>(key, []),
        ...folders.flatMap(folder => (own<string[]>(folder, key) ?? []).map(pattern => anchored(folder.root, pattern)))];
    const include = (): string[] => {
        const base = settings.get<string[]>('projects.include', []);
        if (!folders.some(folder => own(folder, 'projects.include') !== undefined)) {return base;}
        // A folder without include patterns keeps all of its projects.
        return folders.flatMap(folder => {
            const patterns = own<string[]>(folder, 'projects.include') ?? base;
            return patterns.length ? patterns.map(pattern => anchored(folder.root, pattern)) : [anchored(folder.root, '**')];
        });
    };
    const base = settings.get<string>('solution', '');
    const scopedSolutions = folders.some(folder => own(folder, 'solution') !== undefined);
    const buildConfiguration = uniform('buildConfiguration', 'Debug');
    return {
        enabled: settings.get('autoRun', true), trigger: settings.get('trigger', 'save'),
        debounce: Math.max(0, settings.get('debounceTime', 500)),
        pattern: settings.get('fileWatcherPattern', defaultWatcherPattern),
        showCoverage: settings.get('showCoverage', false),
        additionalConfigurations: additionalConfigurations(settings.get<string[]>('additionalConfigurations', []), buildConfiguration),
        dotnet: settings.get('dotnetPath', 'dotnet'), configuration: buildConfiguration,
        mode: settings.get('runMode', 'affected'), coverage: settings.get('runWithCoverage', true),
        maxParallelProjects: settings.get('maxParallelProjects', 0),
        maxParallelTestFiles: settings.get('maxParallelTestFiles', 0),
        excludes: [...defaultExcludes, ...additive('exclude')],
        testArguments: uniform<string[]>('testArguments', []), timeout: Math.max(10, settings.get('timeoutSeconds', 600)) * 1000,
        coverageTool: settings.get<string>('coverageToolPath') || undefined,
        solution: scopedSolutions ? undefined : resolveSolution(base),
        solutions: scopedSolutions ? folders.flatMap(folder => {
            const value = own<string>(folder, 'solution');
            const file = value === undefined ? resolveSolution(base) : resolveSolution(value, folder);
            return file ? [{ file, root: folder.root }] : [];
        }) : undefined,
        projects: { include: include(), exclude: additive('projects.exclude') },
        folderConflicts: conflicts
    };
}

/** Relative paths resolve against the owning folder, or the first folder for workspace-level values. */
function resolveSolution(value: string, owner?: Folder): string | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const root = owner?.root ?? folders[0]?.uri.fsPath;
    const expanded = value.trim().replace(/\$\{workspaceFolder(?::([^}]+))?\}/g, (match, name?: string) => {
        const folder = name ? folders.find(candidate => candidate.name === name)?.uri.fsPath : root;
        return folder ?? match;
    });
    if (!expanded) {return undefined;}
    return path.isAbsolute(expanded) || !root ? expanded : path.join(root, expanded);
}
