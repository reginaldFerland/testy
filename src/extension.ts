import * as vscode from 'vscode';
import { registerInactiveCommands } from './commands';
import { Testy } from './controller';
import { normalizePath } from './core/paths';
import { restrictedStatus } from './ui/statusBar';

let activeExtension: Testy | undefined;
/** Upper bound on deactivation; remaining cleanup finishes in the background or is reclaimed on the next start. */
const shutdownTimeout = 3000;

export function activate(context: vscode.ExtensionContext): { snapshot: () => unknown } | undefined {
    if (!vscode.workspace.workspaceFolders?.length) {context.subscriptions.push(registerInactiveCommands('noFolder')); return;}
    let inactive: vscode.Disposable | undefined;
    const start = (): void => {
        if (activeExtension) {return;}
        // The full registration replaces the explanatory commands.
        inactive?.dispose(); inactive = undefined;
        const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
        const extension = new Testy(context, roots);
        activeExtension = extension;
        context.subscriptions.push(extension);
        // Restoring the coverage cache can take a while; activation does not wait for it.
        void extension.start().catch((error: unknown) => extension.reportError(error, true));
    };
    if (vscode.workspace.isTrusted) {start();}
    else {
        // Restricted Mode: nothing is built, restored or executed until the user trusts the workspace.
        const notice = restrictedStatus();
        inactive = registerInactiveCommands('restricted');
        context.subscriptions.push(notice, { dispose: () => {inactive?.dispose();} }, vscode.workspace.onDidGrantWorkspaceTrust(() => {
            notice.dispose();
            try {start();} catch (error) {void vscode.window.showErrorMessage(vscode.l10n.t('Testy: {0}', error instanceof Error ? error.message : String(error)));}
        }));
    }
    // The state snapshot exists for the extension tests only.
    return context.extensionMode === vscode.ExtensionMode.Test ? { snapshot: () => activeExtension?.snapshot() ?? { restricted: true } } : undefined;
}

export async function deactivate(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {await Promise.race([activeExtension?.dispose(), new Promise<void>(resolve => {timer = setTimeout(resolve, shutdownTimeout);})]);}
    finally {clearTimeout(timer); activeExtension = undefined;}
}
