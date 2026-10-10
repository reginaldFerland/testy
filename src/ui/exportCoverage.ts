import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { CoverageSummary } from '../core/coverage';
import { CoverageFormat, coverageExportFile, exportCoverage } from '../core/coverageExport';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** Ask for a format and location, then write the current, non-stale merged coverage. Resolves to the written file. */
export async function exportCoverageFile(summaries: () => readonly CoverageSummary[], roots: readonly string[], log: (message: string) => void): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { readonly format: CoverageFormat }>([
        { label: 'LCOV', description: '.lcov', format: 'lcov' }, { label: 'Cobertura XML', description: '.cobertura.xml', format: 'cobertura' }
    ], { title: l10n.t('Export Coverage'), placeHolder: l10n.t('Choose a coverage format') });
    if (!choice) {return undefined;}
    const { format } = choice;
    const current = summaries().filter(summary => !summary.stale && summary.lines.length);
    if (!current.length) {
        void vscode.window.showWarningMessage(l10n.t('There is no current coverage to export. Run tests with coverage first.'));
        return undefined;
    }
    const folder = roots[0] ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const target = await vscode.window.showSaveDialog({
        title: l10n.t('Export Coverage'), saveLabel: l10n.t('Export'),
        defaultUri: folder ? vscode.Uri.file(path.join(folder, 'coverage', coverageExportFile[format])) : undefined,
        filters: format === 'lcov' ? { LCOV: ['lcov', 'info'] } : { 'Cobertura XML': ['xml'] }
    });
    if (!target) {return undefined;}
    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    await fs.writeFile(target.fsPath, exportCoverage(format, current, roots), 'utf8');
    log(`Exported coverage for ${current.length} files to ${target.fsPath}.`);
    void vscode.window.showInformationMessage(l10n.t('Exported coverage for {0} files to {1}.', current.length, target.fsPath));
    return target.fsPath;
}
