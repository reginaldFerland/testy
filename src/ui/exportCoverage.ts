import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CoverageSummary } from '../core/coverage';
import { CoverageFormat, coverageExportFile, exportCoverage } from '../core/coverageExport';
import { isInside } from '../core/paths';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** In a multi-root workspace, export one folder (its files, relative to it) or every folder. */
async function chooseRoots(roots: readonly string[]): Promise<readonly string[] | undefined> {
    if (roots.length < 2) {return roots;}
    const all = { label: l10n.t('All workspace folders'), description: l10n.t('Paths relative to the folder that contains each file'), roots };
    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { readonly roots: readonly string[] }>([
        ...roots.map(root => ({ label: path.basename(root), description: root, roots: [root] })), all
    ], { title: l10n.t('Export Coverage'), placeHolder: l10n.t('Choose the workspace folder to export') });
    return choice?.roots;
}

/** Ask for a format, folder and location, then write the current, non-stale merged coverage. Resolves to the written file. */
export async function exportCoverageFile(summaries: () => readonly CoverageSummary[], roots: readonly string[], log: (message: string) => void): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { readonly format: CoverageFormat }>([
        { label: 'LCOV', description: '.lcov', format: 'lcov' }, { label: 'Cobertura XML', description: '.cobertura.xml', format: 'cobertura' }
    ], { title: l10n.t('Export Coverage'), placeHolder: l10n.t('Choose a coverage format') });
    if (!choice) {return undefined;}
    const { format } = choice;
    const chosen = await chooseRoots(roots);
    if (!chosen) {return undefined;}
    // A single chosen folder of several exports only the files inside it.
    const only = roots.length < 2 ? undefined : chosen.length === 1 ? chosen[0] : undefined;
    const current = summaries().filter(summary => !summary.stale && summary.lines.length && (only === undefined || isInside(summary.file, only)));
    if (!current.length) {
        void vscode.window.showWarningMessage(l10n.t('There is no current coverage to export. Run tests with coverage first.'));
        return undefined;
    }
    const folder = chosen[0] ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const target = await vscode.window.showSaveDialog({
        title: l10n.t('Export Coverage'), saveLabel: l10n.t('Export'),
        ...folder ? { defaultUri: vscode.Uri.file(path.join(folder, 'coverage', coverageExportFile[format])) } : {},
        filters: format === 'lcov' ? { LCOV: ['lcov', 'info'] } : { 'Cobertura XML': ['xml'] }
    });
    if (!target) {return undefined;}
    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await fs.writeFile(target.fsPath, exportCoverage(format, current, chosen), 'utf8');
    log(`Exported coverage for ${current.length} files to ${target.fsPath}.`);
    void vscode.window.showInformationMessage(l10n.t('Exported coverage for {0} files to {1}.', current.length, target.fsPath));
    return target.fsPath;
}
