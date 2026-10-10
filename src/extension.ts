import * as vscode from 'vscode';
import { Testy } from './controller';
import { normalizePath } from './core/paths';

let activeExtension: Testy | undefined;

export function activate(context: vscode.ExtensionContext): { snapshot: () => unknown } | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
    if (!roots.length || !vscode.workspace.isTrusted) {return;}
    const extension = new Testy(context, roots);
    activeExtension = extension;
    context.subscriptions.push(extension);
    // Restoring the coverage cache can take a while; activation does not wait for it.
    void extension.start().catch(error => extension.reportError(error));
    return { snapshot: () => extension.snapshot() };
}

export async function deactivate(): Promise<void> {
    try {await activeExtension?.dispose();}
    finally {activeExtension = undefined;}
}
