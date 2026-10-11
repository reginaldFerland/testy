import * as vscode from 'vscode';
import { RunPhase, RunSummary } from '../services/engine';
import { SchedulerState } from '../core/scheduler';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;
const contextValues = new Map<string, boolean | readonly string[]>();

/** Context keys drive menus and command enablement; only changes are sent. */
export function setContext(key: string, value: boolean | readonly string[]): void {
    const previous = contextValues.get(key);
    if (previous === value || (Array.isArray(previous) && Array.isArray(value) && previous.length === value.length && previous.every((item, index) => item === value[index]))) {return;}
    contextValues.set(key, value);
    void Promise.resolve(vscode.commands.executeCommand('setContext', key, value)).catch(() => undefined);
}

/** Localized status text for an engine phase. */
export function describePhase(phase: RunPhase): string {
    const { completed = 0, total, active = 0 } = phase;
    switch (phase.kind) {
        case 'preparingProjects': return l10n.t('Preparing projects');
        case 'building': return l10n.t('Building');
        case 'preparingTests': return total === undefined ? l10n.t('Preparing tests') : l10n.t('Preparing tests {0}/{1} · {2} active', completed, total, active);
        case 'testing': {
            const counts = total === undefined ? l10n.t('Testing') : l10n.t('Testing {0}/{1} · {2} active', completed, total, active);
            const progress = phase.remaining ? `${counts} · ${l10n.t('about {0} left', formatRemaining(phase.remaining))}` : counts;
            return phase.learned === undefined ? progress : `${progress} · ${l10n.t('{0}/{1} files learned', phase.learned, phase.learnedTotal ?? 0)}`;
        }
        case 'settingUpCoverage': return l10n.t('Setting up coverage');
    }
}

/** A short localized duration such as `45s` or `3m 20s`, rounded up to whole seconds. */
export function formatRemaining(milliseconds: number): string {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    return seconds < 60 ? l10n.t('{0}s', seconds) : l10n.t('{0}m {1}s', Math.floor(seconds / 60), seconds % 60);
}

/** Everything the status bar shows. */
export interface StatusModel {
    readonly paused: boolean;
    readonly running: boolean;
    readonly scheduling: SchedulerState;
    readonly phase: RunPhase | undefined;
    readonly lastError: string;
    readonly lastSummary: RunSummary | undefined;
    readonly passed: number;
    readonly failed: number;
    /** Whether any test file is known. */
    readonly hasTests: boolean;
    readonly coverageSuffix: string;
    /** A continuous run keeps automatic testing on although the user paused it. */
    readonly continuousOverride: boolean;
    /** Whether this workspace's pause or resume, or the `testy.autoRun` setting, decides automatic testing. */
    readonly pauseSource?: PauseSource;
    /** The `testy.autoRun` setting. */
    readonly autoRunSetting?: boolean;
}

export type PauseSource = 'workspace' | 'setting';

/** Which source paused or resumed automatic testing, when that is not simply the setting's default; nothing otherwise. */
export function pauseReason(paused: boolean, source: PauseSource | undefined, autoRunSetting = true): string {
    if (paused) {return source === 'setting' ? l10n.t('Disabled by testy.autoRun.') : source === 'workspace' ? l10n.t('Paused for this workspace.') : '';}
    return source === 'workspace' && !autoRunSetting ? l10n.t('Resumed for this workspace although testy.autoRun is off.') : '';
}

/** Status text without `$(icon)` references. */
export function plainText(text: string): string { return text.replace(/\$\([^)]*\)\s*/g, '').trim(); }

function sentence(text: string): string { return /[.!?…]$/.test(text) ? text : `${text}.`; }

export class StatusBar {
    private readonly item = vscode.window.createStatusBarItem('testy.status', vscode.StatusBarAlignment.Left, 10);

    constructor() {
        this.item.name = 'Testy'; this.item.command = 'testy.showMenu'; this.item.show();
    }

    get text(): string { return this.item.text; }

    get tooltip(): string | undefined {
        const tooltip = this.item.tooltip;
        return typeof tooltip === 'string' ? tooltip : tooltip?.value;
    }

    update(model: StatusModel): void {
        const { passed, failed, lastSummary, lastError, phase } = model;
        const failedBatches = lastSummary?.failedBatches ?? 0;
        const batches = failedBatches ? ` · ${l10n.t('{0} batch errors', failedBatches)}` : '';
        this.item.text = model.paused ? `$(debug-pause) ${l10n.t('Testy: paused')}`
            : lastError ? `$(warning) ${l10n.t('Testy: needs attention')}`
            : phase ? `$(sync~spin) ${l10n.t('Testy: {0}', describePhase(phase))}`
            : model.scheduling === 'waiting' ? `$(watch) ${l10n.t('Testy: waiting for changes to settle')}`
            : `$(beaker) ${failed ? l10n.t('{0} failed', failed) : passed ? l10n.t('{0} passed', passed) : lastSummary && !model.hasTests ? l10n.t('Testy: no C# tests found') : 'Testy'}${batches}${model.coverageSuffix}`;
        this.item.backgroundColor = lastError || failed || failedBatches ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        const details = [lastError || l10n.t('{0} passed · {1} failed', passed, failed),
            lastSummary ? l10n.t('Last run: {0} test files in {1}s', lastSummary.files, (lastSummary.duration / 1000).toFixed(1)) : '',
            failedBatches ? l10n.t('{0} test batches could not run; see Output.', failedBatches) : '',
            lastSummary && !lastSummary.coverageAvailable ? l10n.t('Coverage unavailable or disabled; selection uses project fallback.') : '',
            pauseReason(model.paused, model.pauseSource, model.autoRunSetting),
            model.continuousOverride ? l10n.t('A continuous run keeps automatic testing on.') : '',
            l10n.t('Click for Testy actions.')].filter(Boolean);
        this.item.tooltip = details.join('\n');
        // Screen readers announce the state without codicon names, then the details.
        this.item.accessibilityInformation = { label: [plainText(this.item.text), ...details].map(sentence).join(' '), role: 'button' };
        setContext('testy.paused', model.paused);
        setContext('testy.running', model.running);
    }

    dispose(): void { this.item.dispose(); }
}

/** Shown instead of Testy in Restricted Mode: nothing runs until the workspace is trusted. */
export function restrictedStatus(): vscode.Disposable {
    const item = vscode.window.createStatusBarItem('testy.restricted', vscode.StatusBarAlignment.Left, 10);
    const text = l10n.t('Testy: Restricted Mode');
    item.name = 'Testy'; item.text = `$(shield) ${text}`; item.command = 'workbench.trust.manage';
    item.tooltip = l10n.t('Testy builds and runs workspace code, so it waits until you trust this workspace. Click to manage Workspace Trust.');
    item.accessibilityInformation = { label: `${text}. ${item.tooltip}`, role: 'button' };
    item.show();
    return item;
}

/** The commands offered by the status bar menu. */
export interface MenuActions {
    setPaused(paused: boolean): unknown;
    runAffected(): unknown;
    refreshAll(): unknown;
    cancel(): unknown;
    clearCoverage(): unknown;
    exportCoverage(): unknown;
    exportTimeline(): unknown;
    showSlowestTests(): unknown;
    resetCaches(): unknown;
    showOutput(): unknown;
    openSettings(): unknown;
}

export async function showMenu(state: { readonly paused: boolean; readonly running: boolean; readonly lastError: string; readonly placeHolder: string | undefined; readonly pauseSource?: PauseSource }, actions: MenuActions): Promise<void> {
    type Action = vscode.QuickPickItem & { readonly run: () => unknown };
    const items: Action[] = [
        ...state.lastError ? [{ label: `$(warning) ${l10n.t('Show Error Details')}`, detail: state.lastError, run: () => actions.showOutput() }] : [],
        state.paused ? { label: `$(debug-start) ${l10n.t('Resume Automatic Testing')}`, description: pauseReason(true, state.pauseSource), run: () => actions.setPaused(false) }
            : { label: `$(debug-pause) ${l10n.t('Pause Automatic Testing')}`, run: () => actions.setPaused(true) },
        { label: `$(play) ${l10n.t('Run Affected Tests Now')}`, run: () => actions.runAffected() },
        { label: `$(run-all) ${l10n.t('Rebuild and Run All C# Tests')}`, run: () => actions.refreshAll() },
        ...state.running ? [{ label: `$(debug-stop) ${l10n.t('Cancel Current Run')}`, run: () => actions.cancel() }] : [],
        { label: `$(clear-all) ${l10n.t('Clear Coverage')}`, run: () => actions.clearCoverage() },
        { label: `$(export) ${l10n.t('Export Coverage…')}`, run: () => actions.exportCoverage() },
        { label: `$(watch) ${l10n.t('Show Slowest Test Files')}`, run: () => actions.showSlowestTests() },
        { label: `$(graph-line) ${l10n.t('Export Timeline…')}`, run: () => actions.exportTimeline() },
        { label: `$(trash) ${l10n.t('Reset Caches and Baseline')}`, run: () => actions.resetCaches() },
        { label: `$(output) ${l10n.t('Show Output')}`, run: () => actions.showOutput() },
        { label: `$(settings-gear) ${l10n.t('Open Testy Settings')}`, run: () => actions.openSettings() }
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Testy', ...state.placeHolder ? { placeHolder: state.placeHolder } : {} });
    await choice?.run();
}
