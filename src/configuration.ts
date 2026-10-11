import * as path from 'node:path';
import * as vscode from 'vscode';
import { escape } from 'minimatch';
import { EngineConfiguration } from './core/model';
import { additionalConfigurations } from './core/buildConfigurations';
import { defaultExcludes, defaultWatcherPattern, normalizePath } from './core/paths';
import type { BuildDiagnosticsMode } from './diagnosticsPublisher';
import type { InlineResultsMode } from './ui/inlineStatus';

export interface Configuration extends EngineConfiguration {
    readonly enabled: boolean;
    readonly trigger: 'save' | 'fileSystem';
    readonly debounce: number;
    readonly pattern: string;
    readonly showCoverage: boolean;
    /** Pass/fail gutter markers and hovers on covered lines (`testy.inlineResults`). */
    readonly inlineResults: InlineResultsMode;
    /** Whether build errors are published to the Problems panel (`testy.problems.publishBuildDiagnostics`). */
    readonly buildDiagnostics: BuildDiagnosticsMode;
    /** Extra build configurations offered as manual Run and Coverage profiles. */
    readonly additionalConfigurations: readonly string[];
    /** After an affected run, which unselected test files to run once the editor is quiet (`testy.safetyNet`). */
    readonly safetyNet: 'off' | 'related' | 'all';
    /** Priority of the processes Testy starts (`testy.processPriority`). */
    readonly processPriority: 'belowNormal' | 'normal';
    /** Milliseconds an automatic run that a save supersedes may take to finish the test processes the save cannot affect
     * (`testy.finishRunningTests`, in seconds); 0 cancels it at once. */
    readonly finishRunningTests: number;
    /** Resource-scoped settings whose folder-level values differ; one engine applies the workspace value. */
    readonly folderConflicts: readonly string[];
}

export { defaultWatcherPattern };

/** Default `testy.debounceTime` for each trigger, when it is not set. */
export const saveDebounce = 50, fileSystemDebounce = 500;

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
    const trigger = settings.get<'save' | 'fileSystem'>('trigger', 'save'), debounce = settings.inspect<number>('debounceTime');
    const traitList = (key: string): string[] => settings.get<string[]>(key, []).map(trait => trait.trim()).filter(Boolean);
    return {
        enabled: settings.get('autoRun', true), trigger,
        // A save is deliberate, and Save All writes its files together; file-system events arrive in bursts.
        debounce: Math.max(0, debounce?.workspaceValue ?? debounce?.globalValue ?? (trigger === 'fileSystem' ? fileSystemDebounce : saveDebounce)),
        pattern: settings.get('fileWatcherPattern', defaultWatcherPattern),
        showCoverage: settings.get('showCoverage', false), inlineResults: settings.get<InlineResultsMode>('inlineResults', 'gutterAndHover'),
        buildDiagnostics: settings.get<BuildDiagnosticsMode>('problems.publishBuildDiagnostics', 'auto'),
        safetyNet: settings.get<'off' | 'related' | 'all'>('safetyNet', 'off'),
        finishRunningTests: Math.max(0, settings.get<number>('finishRunningTests', 5)) * 1000,
        processPriority: settings.get<'belowNormal' | 'normal'>('processPriority', 'belowNormal') === 'normal' ? 'normal' : 'belowNormal',
        additionalConfigurations: additionalConfigurations(settings.get<string[]>('additionalConfigurations', []), buildConfiguration),
        dotnet: settings.get('dotnetPath', 'dotnet'), configuration: buildConfiguration,
        mode: settings.get('runMode', 'affected'), granularity: settings.get('selectionGranularity', 'method'), excludeTraits: traitList('excludeTraits'), coverage: settings.get('runWithCoverage', true),
        exclusiveTraits: traitList('exclusiveTraits'), serialTraits: traitList('serialTraits'), isolatedTraits: traitList('isolatedTraits'),
        inclusiveTraits: traitList('inclusiveTraits'), workerTraits: settings.get<Record<string, number>>('workerTraits', {}),
        testProcessMemoryLimit: Math.max(0, settings.get<number>('testProcessMemoryLimit', 0)) * 1024 * 1024,
        alwaysRunFailing: settings.get('alwaysRunFailing', false), reuseTestHosts: settings.get('reuseTestHosts', true), splitLongTestFiles: settings.get('splitLongTestFiles', true),
        maxParallelProjects: settings.get('maxParallelProjects', 0),
        maxParallelTestFiles: settings.get('maxParallelTestFiles', 0),
        excludes: [...defaultExcludes, ...additive('exclude')],
        testArguments: uniform<string[]>('testArguments', []), timeout: Math.max(10, settings.get('timeoutSeconds', 600)) * 1000,
        testTimeout: Math.max(0, settings.get<number>('testTimeoutSeconds', 120)) * 1000,
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
