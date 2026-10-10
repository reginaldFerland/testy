import * as vscode from 'vscode';
import * as path from 'node:path';
import { TestFile } from '../core/model';
import { Selection, SelectionCause } from '../core/selection';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** Files listed per run in the Output channel and run output before the rest are summarized. */
const maxLines = 500;
/** A run-wide cause shared by more files than this is summarized in one line. */
const maxUniformLines = 200;

/** One selected test file and why it runs. */
export interface Explanation { readonly group: TestFile; readonly text: string; }

export function groupName(group: TestFile): string {
    return group.file ? path.basename(group.file) : group.runtimeOnly ? l10n.t('Unmapped runtime tests') : path.basename(group.project);
}

function fileList(cause: SelectionCause): string {
    const names = cause.files.map(file => path.basename(file)).join(', ');
    return cause.more > 0 ? l10n.t('{0} and {1} more', names, cause.more) : names;
}

/** A short, localized reason a group was selected. */
export function describeCause(cause: SelectionCause): string {
    switch (cause.kind) {
        case 'covers': return l10n.t('covers {0} (changed)', fileList(cause));
        case 'edited': return l10n.t('its own file changed');
        case 'baseline': return l10n.t('baseline: learning coverage');
        case 'manual': return l10n.t('manual run');
        case 'all': return l10n.t('run all mode');
        case 'fallback':
            switch (cause.reason) {
                case 'configuration': return l10n.t('project fallback: configuration change ({0})', fileList(cause));
                case 'unanalyzed': return l10n.t('project fallback: {0} could not be analyzed precisely', fileList(cause));
                case 'unmapped': return l10n.t('project fallback: no coverage trace covers {0}', fileList(cause));
                case 'unobserved': return l10n.t('project fallback: {0} may affect code that was never observed', fileList(cause));
                case 'untraced': case undefined: default: return l10n.t('project fallback: no reliable coverage trace yet ({0})', fileList(cause));
            }
    }
}

/** "Why was this selected?" for a Test Explorer item: a test, file or project item id from the tree. */
export function explainItem(selection: Selection | undefined, testIds: ReadonlyMap<string, { readonly group: string }>, itemId: string, label: string): string {
    if (!selection) {return l10n.t('{0}: no Testy run has selected tests in this session yet.', label);}
    if (itemId.startsWith('project:')) {
        const project = itemId.slice('project:'.length);
        const selected = selection.groups.filter(group => group.project === project);
        const [first] = selected;
        if (!first) {return l10n.t('{0} was not selected in the latest run ({1}).', label, selection.reason);}
        const cause = selection.causes?.get(first.id);
        return l10n.t('{0}: {1} test files were selected in the latest run. {2}: {3}', label, selected.length, groupName(first), cause ? describeCause(cause) : selection.reason);
    }
    const id = testIds.get(itemId)?.group ?? (itemId.startsWith('file:') ? itemId.slice('file:'.length) : undefined);
    const group = id === undefined ? undefined : selection.groups.find(candidate => candidate.id === id);
    if (!group) {return l10n.t('{0} was not selected in the latest run ({1}).', label, selection.reason);}
    const cause = selection.causes?.get(group.id);
    return l10n.t('{0} was selected in the latest run. {1}: {2}', label, groupName(group), cause ? describeCause(cause) : selection.reason);
}

/** An output line, attached to a file's item when it is about one file. */
export interface ExplanationLine { readonly text: string; readonly group?: TestFile; }

/** The cause of every selected group, and the output lines announcing them (capped for large selections). */
export function explainSelection(selection: Selection): { readonly explanations: readonly Explanation[]; readonly lines: readonly ExplanationLine[] } {
    const { causes, groups } = selection;
    if (!causes) {
        // Selections without per-group causes (provider runtime expansion) carry only a reason.
        const lines: ExplanationLine[] = groups.slice(0, maxLines).map(group => ({ text: l10n.t('Selected {0}: {1}', groupName(group), selection.reason), group }));
        if (groups.length > maxLines) {lines.push({ text: l10n.t('…and {0} more selected test files', groups.length - maxLines) });}
        return { explanations: [], lines };
    }
    const explanations: Explanation[] = [];
    for (const group of groups) {
        const cause = causes.get(group.id);
        if (cause) {explanations.push({ group, text: describeCause(cause) });}
    }
    const [first] = explanations;
    if (first && explanations.length > maxUniformLines && explanations.every(({ group }) => !causes.get(group.id)?.files.length)) {
        return { explanations, lines: [{ text: l10n.t('Selected {0} test files: {1}', explanations.length, first.text) }] };
    }
    const lines: ExplanationLine[] = explanations.slice(0, maxLines).map(({ group, text }) => ({ text: l10n.t('Selected {0}: {1}', groupName(group), text), group }));
    if (explanations.length > maxLines) {lines.push({ text: l10n.t('…and {0} more selected test files', explanations.length - maxLines) });}
    return { explanations, lines };
}
