import * as vscode from 'vscode';
import * as path from 'node:path';
import { escape } from 'minimatch';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** What each `testy.*` command does; the controller supplies the behavior. */
export interface CommandHandlers {
    refreshTests(): Promise<void>;
    toggleAutoRun(): void;
    pause(): void;
    resume(): void;
    runAffected(): Promise<void>;
    cancelRun(): void;
    clearCoverage(): void;
    exportCoverage(): Promise<void>;
    resetCaches(): Promise<void>;
    showOutput(): void;
    showMenu(): Promise<void>;
    explainSelection(item?: vscode.TestItem): void;
    excludeProject(item?: vscode.TestItem): Promise<void>;
    runCoveringTests(): Promise<void>;
    runFile(uris: readonly vscode.Uri[]): Promise<void>;
}

export function registerCommands(handlers: CommandHandlers): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('testy.refreshTests', () => handlers.refreshTests()),
        vscode.commands.registerCommand('testy.toggleAutoRun', () => handlers.toggleAutoRun()),
        vscode.commands.registerCommand('testy.pause', () => handlers.pause()),
        vscode.commands.registerCommand('testy.resume', () => handlers.resume()),
        vscode.commands.registerCommand('testy.runAffected', () => handlers.runAffected()),
        vscode.commands.registerCommand('testy.cancelRun', () => handlers.cancelRun()),
        vscode.commands.registerCommand('testy.clearCoverage', () => handlers.clearCoverage()),
        vscode.commands.registerCommand('testy.exportCoverage', () => handlers.exportCoverage()),
        vscode.commands.registerCommand('testy.resetCaches', () => handlers.resetCaches()),
        vscode.commands.registerCommand('testy.showOutput', () => handlers.showOutput()),
        vscode.commands.registerCommand('testy.showMenu', () => handlers.showMenu()),
        vscode.commands.registerCommand('testy.explainSelection', (item?: vscode.TestItem) => handlers.explainSelection(item)),
        vscode.commands.registerCommand('testy.excludeProject', (item?: vscode.TestItem) => handlers.excludeProject(item)),
        vscode.commands.registerCommand('testy.runCoveringTests', () => handlers.runCoveringTests()),
        vscode.commands.registerCommand('testy.runFile', (uri?: vscode.Uri, uris?: readonly vscode.Uri[]) => handlers.runFile(uris?.length ? uris : uri ? [uri] : []))
    ];
}

/** Add a project to `testy.projects.exclude`, at folder level in a multi-root workspace. */
export async function excludeProject(item: vscode.TestItem | undefined, output: vscode.LogOutputChannel, reportError: (error: unknown) => void): Promise<void> {
    if (!item?.id.startsWith('project:')) {return;}
    const project = item.id.slice('project:'.length);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project));
    const perFolder = !!folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const settings = vscode.workspace.getConfiguration('testy', folder?.uri);
    const values = settings.inspect<string[]>('projects.exclude');
    const current = (perFolder ? values?.workspaceFolderValue : values?.workspaceValue) ?? [];
    const relative = folder ? path.relative(folder.uri.fsPath, project) : '';
    const pattern = escape((relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : project).replace(/\\/g, '/'), { windowsPathsNoEscape: true, magicalBraces: true });
    if (current.includes(pattern)) {return;}
    try {
        await settings.update('projects.exclude', [...current, pattern], perFolder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace);
        output.info(`Excluded ${project} through testy.projects.exclude (${pattern}).`);
        void Promise.resolve(vscode.window.showInformationMessage(l10n.t('{0} is excluded from Testy. Remove it from testy.projects.exclude to include it again.', item.label))).catch(() => undefined);
    } catch (error) { reportError(error); }
}
