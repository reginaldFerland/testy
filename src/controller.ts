import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { configuration, Configuration } from './configuration';
import { TestFile } from './core/model';
import { contentHash, isInside, normalizePath, normalizePathAsync } from './core/paths';
import { ChangeBatch, Scheduler, SchedulerState } from './core/scheduler';
import { Selection } from './core/selection';
import { ManualSelection, RunPhase, RunScope, RunSummary, TestEngine } from './services/engine';
import { ChangeWatcher } from './changeWatcher';
import { BackgroundSweep } from './core/backgroundSweep';
import { excludeProject, registerCommands } from './commands';
import { DiagnosticsPublisher } from './diagnosticsPublisher';
import { BaselineProgress } from './ui/baselineProgress';
import { CoverageView } from './ui/coverage';
import { InlineResults } from './ui/inlineResults';
import { exportCoverageFile } from './ui/exportCoverage';
import { EnvironmentErrorCode, errorMessage, isAbortError, isEnvironmentError } from './core/errors';
import { explainItem } from './ui/selectionCause';
import { describePhase, setContext, showMenu, StatusBar } from './ui/statusBar';
import { requestScope, TestTree } from './ui/testTree';

const csharpExtension = 'ms-dotnettools.csharp';
const devKitExtension = 'ms-dotnettools.csdevkit';
/** Workspace-local pause state. The `testy.autoRun` setting is only the default. */
const pausedKey = 'testy.paused';
const devKitNoticeKey = 'testy.devKitNotice.dismissed';
/** Whether opening this workspace may build and run the baseline: `always`, `manual` (only after a save or manual run), or unset (ask). */
const baselineConsentKey = 'testy.baselineConsent';
/** The Settings editor filtered to Testy's settings. */
const extensionSettings = '@ext:reginaldFerland.testy';
// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** Startup and environment failures the user must fix; routine build and test failures stay in the status bar. */
export function environmentError(error: unknown): boolean {return isEnvironmentError(error);}

/** The localized notification for an environment failure; its detailed (English) message stays in Output. */
export function environmentSummary(code: EnvironmentErrorCode): string {
    switch (code) {
        case 'dotnet-missing': return l10n.t('The .NET CLI could not be found. Install the .NET 10 SDK or set testy.dotnetPath to an absolute path.');
        case 'dotnet-start': return l10n.t('A .NET process could not be started. See the output for details.');
        case 'sdk-unsupported': return l10n.t('Testy requires the .NET 10 SDK or later. Check the global.json that applies to the workspace.');
        case 'analyzer': return l10n.t('Testy\'s C# source analysis failed. See the output for details.');
        case 'configuration': return l10n.t('A Testy setting is invalid. See the output for details.');
        case 'no-test-project': return l10n.t('No test project can run under Testy. Testy needs .NET 10+ test projects that use Microsoft.Testing.Platform.');
        case 'not-mtp': return l10n.t('The test application did not connect to Testy. Use a .NET 10+ Microsoft.Testing.Platform project.');
        case 'host-unresolved': return l10n.t('The configured .NET host could not be resolved. Check testy.dotnetPath.');
    }
}

/** Settings shown by a profile's configure action. */
const profileSettings = {
    run: '@id:testy.additionalConfigurations,testy.buildConfiguration,testy.testArguments',
    coverage: '@id:testy.runWithCoverage,testy.showCoverage,testy.additionalConfigurations',
    debug: '@id:testy.debugConfiguration,testy.additionalConfigurations'
};

function configureProfile(profile: vscode.TestRunProfile, settings: string): vscode.TestRunProfile {
    profile.configureHandler = () => {void Promise.resolve(vscode.commands.executeCommand('workbench.action.openSettings', settings)).catch(() => undefined);};
    return profile;
}

/** The attach configuration: `testy.debugConfiguration` is merged in, but the request and process are Testy's. */
export function attachConfiguration(custom: unknown, processId: number, name: string): vscode.DebugConfiguration {
    const extra = custom && typeof custom === 'object' && !Array.isArray(custom) ? custom as Record<string, unknown> : {};
    return { type: 'coreclr', name, ...extra, request: 'attach', processId: String(processId) };
}

/** First file name, and how many others the run covers. */
function fileNames(files: readonly string[]): string {
    if (!files[0]) {return '';}
    const first = path.basename(files[0]);
    return files.length > 1 ? l10n.t('{0} and {1} more', first, files.length - 1) : first;
}

/** Wires the engine, scheduler and editor integrations together. */
export class Testy implements vscode.Disposable {
    private readonly controller = vscode.tests.createTestController('testy', 'Testy');
    private readonly output = vscode.window.createOutputChannel('Testy', { log: true });
    private readonly statusBar = new StatusBar();
    private readonly diagnostics = new DiagnosticsPublisher(this.output, () => this.roots, () => this.config.buildDiagnostics);
    private readonly changes = new ChangeWatcher(this);
    /** Catches changes whose watcher events were dropped, after incremental `fileSystem` runs; see BackgroundSweep. */
    private readonly sweep = new BackgroundSweep({
        sweep: signal => this.engine.sources.sweep(signal),
        changed: async files => {
            this.output.info(`Testy found ${files.length} changed input${files.length === 1 ? '' : 's'} without a file event: ${fileNames(files)}.`);
            await this.engine.markChanged(files); this.scheduler.request(files);
        },
        error: error => this.reportError(error)
    });
    private readonly disposables: vscode.Disposable[] = [];
    readonly engine: TestEngine;
    private readonly tree: TestTree;
    private readonly coverage: CoverageView;
    private readonly inline: InlineResults;
    private readonly baselineProgress = new BaselineProgress(() => this.scheduler.cancel());
    /** Whether the current run advances the baseline; manual runs do not. */
    private baselineRun = false;
    readonly scheduler: Scheduler;
    private readonly runProfile: vscode.TestRunProfile;
    private readonly coverageProfile: vscode.TestRunProfile;
    private readonly debugProfile: vscode.TestRunProfile;
    /** Manual Run and Coverage profiles for `testy.additionalConfigurations`, and the configurations they were made for. */
    private configurationProfiles: vscode.TestRunProfile[] = [];
    private profileConfigurations: readonly string[] = [];
    config: Configuration;
    private pauseOverride: boolean | undefined;
    /** Active continuous runs and their requests; while any exists, automatic runs proceed even when paused. */
    private readonly continuous = new Map<RunScope, vscode.TestRunRequest>();
    /** Continuous runs started from a coverage profile; automatic runs then collect and show coverage. */
    private readonly continuousCoverage = new Set<RunScope>();
    /** Messages already shown as notifications this session. */
    private readonly notified = new Set<string>();
    /** The latest selection, for "Why was this selected?". */
    private lastSelection: Selection | undefined;
    /** The startup baseline waits for the user's answer, a save or a manual run; setting and folder changes do not start it. */
    private awaitingBaseline = true;
    /** Set once startup has restored state and applied the pause and consent; until then the scheduler only collects requests. */
    private started = false;
    /** Errors already reported, so one failure is logged once however many layers see it. */
    private readonly reported = new WeakSet<object>();
    activeRun: vscode.TestRun | undefined;
    private activeRequest: vscode.TestRunRequest | undefined;
    private phase: RunPhase | undefined;
    private scheduling: SchedulerState = 'idle';
    private lastSummary: RunSummary | undefined;
    private lastError = '';
    /** Whether the current run reached, or completed, its build. */
    private build: 'none' | 'building' | 'built' = 'none';
    /** Whether the current run only rediscovers; Test Explorer shows the projects as busy meanwhile. */
    private discovering = false;
    disposed = false;
    private disposal?: Promise<void>;
    readonly lifetime = new AbortController();

    constructor(private readonly context: vscode.ExtensionContext, public roots: readonly string[]) {
        this.config = configuration();
        this.pauseOverride = context.workspaceState.get<boolean>(pausedKey);
        const storage = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, contentHash(roots.join('\0')));
        this.engine = new TestEngine({
            roots, storage, tools: context.globalStorageUri.fsPath,
            analyzer: path.join(context.extensionPath, 'dist', 'analyzer', 'Testy.Analysis.dll'), configuration: () => this.config,
            events: {
                output: text => {
                    if (this.disposed) {return;}
                    this.diagnostics.push(text);
                    this.activeRun?.appendOutput(text.replace(/\r?\n/g, '\r\n'));
                },
                phase: phase => {
                    this.phase = phase; this.tree.setBusy(this.discovering || phase.kind === 'preparingProjects');
                    if (phase.kind === 'building') {this.build = 'building';} else if (this.build === 'building') {this.build = 'built';}
                    if (this.baselineRun) {this.baselineProgress.update(this.engine.baselineProgress);}
                    this.updateStatus();
                },
                inputsChanged: () => this.changes.watch(),
                restored: () => {this.tree.restore(this.engine.outcomes); this.updateStatus(); this.inline.refresh();},
                discovered: groups => {if (groups.length) {setContext('testy.noTestProjects', false);} return this.updateTree(groups);},
                selected: selection => {
                    this.lastSelection = selection;
                    this.output.info(`${selection.reason}: ${selection.groups.length} of ${this.engine.groups.length} test files.`);
                    this.tree.select(selection.groups);
                    for (const line of this.tree.explain(selection)) {this.output.info(line);}
                },
                started: (group, id) => this.tree.started(group, id),
                result: (group, result) => {this.tree.publishResult(group, result); this.inline.refresh();},
                coverage: () => {this.coverage.publish(); this.inline.refresh();},
                invalidated: files => this.scheduler.request(files),
                // The engine continues without coverage when the collector cannot be installed or started.
                coverageUnavailable: () => {if (!this.disposed) {this.coverageUnavailable();}},
                debug: processId => this.attachDebugger(processId)
            }
        });
        this.scheduler = new Scheduler({
            debounce: this.config.debounce,
            run: async (batch, signal) => {
                const fromSweep = this.sweep.runStarting(batch.files);
                await this.execute(batch, signal, { scope: this.automaticScope() });
                // An incremental fileSystem run read only the reported files; sweep the rest in the background.
                if (this.config.trigger === 'fileSystem' && !batch.full && !fromSweep && !signal.aborted) {this.sweep.start();}
            },
            // A background sweep must not delay the source refresh of any run, automatic or manual.
            state: state => { if (state === 'running') {this.sweep.stop();} this.scheduling = state; this.updateStatus(); }, error: error => this.reportError(error)
        });
        this.scheduler.setPaused(true);
        this.runProfile = configureProfile(this.controller.createRunProfile(l10n.t('Run'), vscode.TestRunProfileKind.Run,
            (request, token) => this.manual(request, token, false), true, undefined, true), profileSettings.run);
        this.coverageProfile = configureProfile(this.controller.createRunProfile(l10n.t('Run with coverage'), vscode.TestRunProfileKind.Coverage,
            (request, token) => this.manual(request, token, true), true, undefined, true), profileSettings.coverage);
        this.debugProfile = configureProfile(this.controller.createRunProfile(l10n.t('Debug'), vscode.TestRunProfileKind.Debug,
            (request, token) => this.debug(request, token), true), profileSettings.debug);
        this.tree = new TestTree(this.controller, this.engine, this);
        this.coverage = new CoverageView(context.extensionUri, this.controller, this.coverageProfile, this.engine, this.tree.items, this);
        this.inline = new InlineResults(context.extensionUri, this.engine, this.coverage, this.tree, this);
        this.syncConfigurationProfiles();
        // Test Explorer's refresh rediscovers; it does not run the suite.
        this.controller.refreshHandler = async token => {
            const abort = this.bindCancellation(token);
            try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, { manual: { all: true, groups: new Set(), discoverOnly: true } }), abort.controller.signal); }
            catch (error) { this.reportError(error); }
            finally { abort.dispose(); }
        };
        this.disposables.push(
            this.output, this.diagnostics,
            ...registerCommands({
                refreshTests: () => this.refreshAll(), toggleAutoRun: () => this.setPaused(!this.userPaused), pause: () => this.setPaused(true), resume: () => this.setPaused(false),
                runAffected: () => this.runAffected(), cancelRun: () => this.scheduler.cancel(), clearCoverage: () => this.clearCoverage(), exportCoverage: () => this.exportCoverage(),
                resetCaches: () => this.resetCaches(), showOutput: () => this.output.show(), showMenu: () => this.showMenu(() => this.refreshAll()),
                explainSelection: item => this.explain(item), excludeProject: item => this.excludeProject(item), runCoveringTests: target => this.runCoveringTests(target),
                showTest: id => this.showTest(id), runFile: uris => this.runFiles(uris)
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (this.config.trigger === 'save') {void this.changes.changed(document.uri).catch((error: unknown) => this.reportError(error));}
            }),
            vscode.workspace.onDidDeleteFiles(event => { for (const uri of event.files) {void this.changes.changed(uri, undefined, true).catch((error: unknown) => this.reportError(error));} }),
            vscode.workspace.onDidRenameFiles(event => { for (const file of event.files) { void this.changes.changed(file.oldUri, undefined, true).catch((error: unknown) => this.reportError(error)); void this.changes.changed(file.newUri, undefined, true).catch((error: unknown) => this.reportError(error)); } }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('testy')) {return;}
                try {
                    this.config = configuration();
                    this.warnFolderConflicts();
                    this.syncConfigurationProfiles();
                    this.scheduler.setDebounce(this.config.debounce);
                    // Changing the setting is an explicit choice that replaces a local pause or resume.
                    if (event.affectsConfiguration('testy.autoRun')) {this.storePause(undefined);}
                    this.applyPause();
                    this.changes.watch(); this.coverage.queue(vscode.window.visibleTextEditors); this.inline.refresh();
                    if (event.affectsConfiguration('testy.problems') && !this.scheduler.isRunning) {this.diagnostics.publish();}
                    // Settings that choose what runs refresh discovery at once; the engine decides at run start whether
                    // learned coverage still applies or a new baseline starts.
                    const structural = ['runMode', 'runWithCoverage', 'buildConfiguration', 'dotnetPath', 'testArguments', 'exclude', 'coverageToolPath', 'solution', 'projects']
                        .some(key => event.affectsConfiguration(`testy.${key}`));
                    if ((structural || this.engine.configurationChanged()) && !this.awaitingBaseline) {this.scheduler.request([], true);}
                } catch (error) { this.reportError(error, true); }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                try {
                    this.roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
                    // Folder-level settings depend on the folder list.
                    this.config = configuration(); this.warnFolderConflicts(); this.syncConfigurationProfiles();
                    this.engine.setRoots(this.roots); this.changes.watch(); if (!this.awaitingBaseline) {this.scheduler.request([], true);}
                } catch (error) { this.reportError(error, true); }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => {this.coverage.queue(vscode.window.visibleTextEditors); this.inline.refresh();}),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (!event.contentChanges.length) {return;}
                const editors = vscode.window.visibleTextEditors.filter(editor => editor.document === event.document);
                this.coverage.queue(editors); this.inline.queue(editors);
            })
        );
        setContext('testy.active', true);
        this.warnFolderConflicts();
    }

    async start(): Promise<void> {
        // A failed restore is reported but must not skip the pause, consent and watchers below.
        try {await this.engine.restore(this.lifetime.signal);}
        catch (error) {if (isAbortError(error)) {throw error;} this.reportError(error, true);}
        if (this.disposed) {return;}
        this.started = true;
        this.changes.watch(); this.applyPause();
        const consent = this.context.workspaceState.get<string>(baselineConsentKey);
        // Workspaces with retained coverage, or whose user already agreed, continue as before;
        // a paused workspace keeps the request queued until the user resumes.
        if (consent === 'always' || this.engine.coverage.traces.size || this.userPaused) {this.awaitingBaseline = false; this.scheduler.request([], true);}
        else if (consent !== 'manual') {this.askForBaseline();}
        else {this.awaitingBaseline = true; this.output.info('Waiting for a save or a manual run before establishing the baseline.');}
        this.noticeDevKit();
    }

    /** First open of a workspace: building and running every test is the user's call. */
    private askForBaseline(): void {
        this.awaitingBaseline = true;
        this.output.info('Waiting for permission to establish the baseline; a save or a manual run also starts it.');
        const run = l10n.t('Run Now'), later = l10n.t('Not Now'), never = l10n.t('Don\'t Ask Again');
        // The first coverage run downloads the collector, so say so before the user agrees.
        const message = this.config.coverage && !this.config.coverageTool
            ? l10n.t('Testy can build this workspace and run every C# test once to learn which tests cover which code. Coverage uses Microsoft\'s dotnet-coverage tool, downloaded from NuGet on first use. Start the baseline now?')
            : l10n.t('Testy can build this workspace and run every C# test once to learn which tests cover which code. Start the baseline now?');
        void Promise.resolve(vscode.window.showInformationMessage(message, run, later, never))
            .then(async choice => {
                if (!this.awaitingBaseline || this.disposed) {return;}
                if (choice === run) {
                    this.awaitingBaseline = false; this.scheduler.request([], true);
                    await this.context.workspaceState.update(baselineConsentKey, 'always');
                } else if (choice === never) {
                    this.awaitingBaseline = false;
                    await this.context.workspaceState.update(baselineConsentKey, 'manual');
                }
            })
            .catch((error: unknown) => this.reportError(error));
    }

    /** Settings that cannot differ between workspace folders are reported once per value. */
    private warnFolderConflicts(): void {
        const conflicts = this.config.folderConflicts;
        if (!conflicts.length) {return;}
        const message = l10n.t('{0} differ between workspace folders. Testy runs every folder with the workspace value.', conflicts.join(', '));
        this.output.warn(message); this.notify(message, 'warning');
    }

    snapshot(): unknown {
        return {
            running: this.scheduler.isRunning, paused: this.paused, phase: this.phase ? describePhase(this.phase) : '',
            error: this.lastError, summary: this.lastSummary, awaitingBaseline: this.awaitingBaseline,
            groups: this.engine.displayGroups, baseline: this.engine.baselineProgress, coverage: this.engine.coverage.summarize(this.engine.hashes),
            status: this.statusBar.text, outcomes: Object.fromEntries(this.tree.outcomes),
            diagnostics: [...this.diagnostics.values]
        };
    }

    /** The user's pause choice, before continuous runs override it. */
    private get userPaused(): boolean { return this.pauseOverride ?? !this.config.enabled; }

    /** Which of the two sources decides whether automatic testing is on: this workspace's pause or resume, or `testy.autoRun`. */
    private get pauseSource(): 'workspace' | 'setting' { return this.pauseOverride === undefined ? 'setting' : 'workspace'; }

    /** Whether automatic runs are paused; startup's hold is not shown as a pause. */
    private get paused(): boolean { return this.started && this.scheduler.isPaused; }

    private storePause(paused: boolean | undefined): void {
        this.pauseOverride = paused;
        void Promise.resolve(this.context.workspaceState.update(pausedKey, paused)).catch((error: unknown) => this.reportError(error));
    }

    private applyPause(): void {
        this.scheduler.setPaused(!this.started || (this.userPaused && !this.continuous.size));
        this.updateStatus();
    }

    private setPaused(paused: boolean): void {
        // Matching the setting needs no override; the setting then applies again.
        this.storePause(paused === !this.config.enabled ? undefined : paused);
        this.applyPause();
    }

    /** Continuous runs of specific items limit automatic runs only while automation is paused. */
    private automaticScope(): RunScope | undefined {
        if (!this.userPaused || !this.continuous.size) {return undefined;}
        const scopes = [...this.continuous.keys()];
        if (scopes.some(scope => scope.all && !scope.exclude)) {return undefined;}
        if (scopes.length === 1) {return scopes[0];}
        return {
            all: scopes.some(scope => scope.all), groups: new Set(scopes.flatMap(scope => [...scope.groups])),
            projects: new Set(scopes.flatMap(scope => [...scope.projects ?? []])),
            tests: new Map(scopes.flatMap(scope => [...scope.tests ?? []]).map(([group, ids]) => [group, new Set(ids)]))
        };
    }

    private async refreshAll(): Promise<void> {
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal, { manualOperation: true, label: l10n.t('Testy · rebuild and run all') }), undefined, true); }
        catch (error) { this.reportError(error); }
    }

    private async runAffected(): Promise<void> {
        const batch = this.scheduler.pendingBatch;
        try { await this.scheduler.runManual(signal => this.execute(batch, signal, { label: l10n.t('Testy · run affected') }), undefined, true); }
        catch (error) { this.reportError(error); }
    }

    /** Run the tests affected by files, as if they had been saved. A project or folder stands for the C# sources Testy knows in it. */
    private async runFiles(uris: readonly vscode.Uri[]): Promise<void> {
        const active = vscode.window.activeTextEditor?.document.uri;
        const chosen = await Promise.all((uris.length ? uris : active ? [active] : []).filter(uri => uri.scheme === 'file').map(uri => normalizePathAsync(uri.fsPath)));
        if (!chosen.length) {return;}
        const files = [...new Set((await Promise.all(chosen.map(file => this.sourcesOf(file)))).flat())];
        if (!files.length) {void Promise.resolve(vscode.window.showInformationMessage(l10n.t('Testy knows no C# source files in {0}.', fileNames(chosen)))).catch(() => undefined); return;}
        try { await this.scheduler.runManual(signal => this.execute({ files, full: false }, signal, { label: l10n.t('Testy · run file: {0}', fileNames(chosen)) })); }
        catch (error) { this.reportError(error); }
    }

    /** A file itself; a known project's source files; a folder's known source files. */
    private async sourcesOf(file: string): Promise<readonly string[]> {
        const projects = this.engine.projects;
        if (/\.csproj$/i.test(file)) {
            const owned = projects.filter(project => project.file === file).flatMap(project => project.sourceFiles);
            return owned.length ? owned : [file];
        }
        let directory = false;
        try {directory = (await fs.stat(file)).isDirectory();} catch { /* Deleted file: run as a change. */ }
        if (!directory) {return [file];}
        return [...new Set(projects.flatMap(project => project.sourceFiles.filter(source => source !== file && isInside(source, file))))];
    }

    /** Run the test files whose retained coverage hits a line (1-based): the given one, or the cursor line. */
    private async runCoveringTests(target?: { readonly uri: vscode.Uri; readonly line: number }): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const { uri, line } = target ?? (editor ? { uri: editor.document.uri, line: editor.selection.active.line + 1 } : { uri: undefined, line: 0 });
        if (uri?.scheme !== 'file') {return;}
        const groups = this.coverage.covering(await normalizePathAsync(uri.fsPath), line);
        if (!groups.length) {void Promise.resolve(vscode.window.showInformationMessage(l10n.t('No retained test coverage hits this line.'))).catch(() => undefined); return;}
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, { manual: { groups: new Set(groups) }, label: l10n.t('Testy · run tests covering {0}:{1}', path.basename(uri.fsPath), line) })); }
        catch (error) { this.reportError(error); }
    }

    /** Reveal a test, file or project in Test Explorer. */
    private async showTest(id: string): Promise<void> {
        const item = this.tree.items.get(id);
        if (item) {await vscode.commands.executeCommand('vscode.revealTestInExplorer', item);}
    }

    /** "Why was this selected?" for a Test Explorer item. */
    private explain(item: vscode.TestItem | undefined): void {
        if (!item) {return;}
        void Promise.resolve(vscode.window.showInformationMessage(explainItem(this.lastSelection, this.tree.testIds, item.id, item.label))).catch(() => undefined);
    }

    private excludeProject(item: vscode.TestItem | undefined): Promise<void> {
        return excludeProject(item, this.output, error => this.reportError(error));
    }

    private clearCoverage(): void {
        this.coverage.hide(); this.inline.refresh(); this.updateStatus();
        void Promise.resolve(vscode.commands.executeCommand('testing.coverage.close')).catch(() => undefined);
        this.output.info('Coverage display cleared; the next run shows coverage again.');
    }

    private async exportCoverage(): Promise<void> {
        try {await exportCoverageFile(() => this.engine.coverage.summarize(this.engine.hashes), this.roots, message => this.output.info(message));}
        catch (error) {this.reportError(error);}
    }

    private async resetCaches(): Promise<void> {
        const reset = l10n.t('Reset');
        const choice = await vscode.window.showWarningMessage(l10n.t('Reset Testy caches?'), {
            modal: true, detail: l10n.t('Learned coverage, saved project evaluations and prepared test outputs are deleted. The next run establishes a new baseline.')
        }, reset);
        if (choice !== reset) {return;}
        try {
            await this.scheduler.runManual(async signal => {
                this.diagnostics.clear(); this.tree.clearBuildFailures();
                await this.engine.reset(signal);
            });
            this.inline.refresh();
            this.scheduler.request([], true);
        } catch (error) { this.reportError(error); }
    }

    private showMenu(refreshAll: () => Promise<void>): Promise<void> {
        return showMenu({ paused: this.paused, running: this.scheduler.isRunning, lastError: this.lastError, placeHolder: this.statusBar.tooltip, pauseSource: this.pauseSource }, {
            setPaused: paused => this.setPaused(paused), runAffected: () => this.runAffected(), refreshAll, cancel: () => this.scheduler.cancel(),
            clearCoverage: () => this.clearCoverage(), exportCoverage: () => this.exportCoverage(), resetCaches: () => this.resetCaches(), showOutput: () => this.output.show(),
            openSettings: () => vscode.commands.executeCommand('workbench.action.openSettings', extensionSettings)
        });
    }

    private noticeDevKit(): void {
        if (!vscode.extensions.getExtension(devKitExtension) || this.context.globalState.get<boolean>(devKitNoticeKey)) {return;}
        const dismiss = l10n.t('Don\'t Show Again');
        void Promise.resolve(vscode.window.showInformationMessage(
            l10n.t('C# Dev Kit is also installed. Its Test Explorer entries and builds run alongside Testy\'s, so tests can appear twice. You can disable C# Dev Kit\'s testing support for this workspace if you prefer Testy\'s.'), dismiss))
            .then(async choice => { if (choice === dismiss) {await this.context.globalState.update(devKitNoticeKey, true);} })
            .catch((error: unknown) => this.reportError(error));
    }

    /** The workspace folder containing the debugged tests; the first folder when the run is not limited to items. */
    private debugFolder(): vscode.WorkspaceFolder | undefined {
        for (const item of this.activeRequest?.include ?? []) {
            for (let current: vscode.TestItem | undefined = item; current; current = current.parent) {
                const folder = current.uri && vscode.workspace.getWorkspaceFolder(current.uri);
                if (folder) {return folder;}
            }
        }
        return vscode.workspace.workspaceFolders?.[0];
    }

    private async attachDebugger(processId: number): Promise<void> {
        const folder = this.debugFolder();
        const custom = vscode.workspace.getConfiguration('testy', folder?.uri).get<unknown>('debugConfiguration', {});
        const started = await vscode.debug.startDebugging(folder, attachConfiguration(custom, processId, l10n.t('Testy: Debug tests')), this.activeRun && { testRun: this.activeRun });
        if (!started) {throw new Error(l10n.t('The debugger could not attach to test process {0}.', processId));}
    }

    private async debug(request: vscode.TestRunRequest, token: vscode.CancellationToken, configuration?: string): Promise<void> {
        if (!vscode.extensions.getExtension(csharpExtension)) {
            const install = l10n.t('Install C# Extension');
            const choice = await vscode.window.showErrorMessage(l10n.t('Debugging C# tests requires the C# extension ({0}).', csharpExtension), install);
            if (choice === install) {await vscode.commands.executeCommand('workbench.extensions.installExtension', csharpExtension);}
            return;
        }
        await this.manual(request, token, false, true, configuration);
    }

    private async updateTree(groups: readonly TestFile[]): Promise<void> {
        if (this.disposed) {return;}
        this.coverage.productionSources = new Set(this.engine.projects.filter(project => !project.isTestProject).flatMap(project => [...project.sourceFiles]));
        this.changes.watch();
        const owners = await this.tree.update(groups);
        if (!owners) {return;}
        this.coverage.owners = owners;
        this.updateStatus();
    }

    /** Extra profiles run or debug manual selections with another build configuration. Automatic runs always use `testy.buildConfiguration`. */
    private syncConfigurationProfiles(): void {
        const wanted = this.config.additionalConfigurations;
        if (wanted.length === this.profileConfigurations.length && wanted.every((name, index) => name === this.profileConfigurations[index])) {return;}
        for (const profile of this.configurationProfiles) {profile.dispose();}
        this.configurationProfiles = wanted.flatMap(name => {
            const run = configureProfile(this.controller.createRunProfile(l10n.t('Run ({0})', name), vscode.TestRunProfileKind.Run,
                (request, token) => this.manual(request, token, false, false, name), false), profileSettings.run);
            const coverage = configureProfile(this.controller.createRunProfile(l10n.t('Run with coverage ({0})', name), vscode.TestRunProfileKind.Coverage,
                (request, token) => this.manual(request, token, true, false, name), false), profileSettings.coverage);
            const debug = configureProfile(this.controller.createRunProfile(l10n.t('Debug ({0})', name), vscode.TestRunProfileKind.Debug,
                (request, token) => this.debug(request, token, name), false), profileSettings.debug);
            this.coverage.bind(coverage);
            return [run, coverage, debug];
        });
        this.profileConfigurations = [...wanted];
    }

    private async manual(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean, debug = false, configuration?: string): Promise<void> {
        if (request.continuous) {return this.continuousRun(request, token, coverage);}
        const selection: ManualSelection = { ...requestScope(this.tree.testIds, request), coverage, ...(debug ? { debug } : {}), ...(configuration ? { configuration } : {}) };
        const abort = this.bindCancellation(token);
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, { request, manual: selection }), abort.controller.signal); }
        catch (error) { this.reportError(error); }
        finally { abort.dispose(); }
    }

    /** A continuous run keeps automatic testing on for its items until cancelled. */
    private async continuousRun(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean): Promise<void> {
        const scope = requestScope(this.tree.testIds, request);
        this.continuous.set(scope, request); if (coverage) {this.continuousCoverage.add(scope);} this.applyPause();
        try {
            await new Promise<void>(resolve => {
                if (token.isCancellationRequested) {resolve(); return;}
                const registration = token.onCancellationRequested(() => { registration.dispose(); resolve(); });
            });
        } finally {this.continuous.delete(scope); this.continuousCoverage.delete(scope); if (!this.disposed) {this.applyPause();}}
    }

    /** The continuous run that automatic results report into; Test Explorer then ties them to it. Only a run from the profile kind
     * the automatic run needs qualifies: coverage published into a Run-profile request would have no line detail (only the
     * coverage profile loads it), and skipping collection for it would override testy.runWithCoverage and leave traces stale.
     * Without a match, the automatic run gets its own request, as without any continuous run. */
    private continuousRequest(coverage: boolean): vscode.TestRunRequest | undefined {
        const kind = coverage ? vscode.TestRunProfileKind.Coverage : vscode.TestRunProfileKind.Run;
        return [...this.continuous.values()].findLast(request => request.profile?.kind === kind);
    }

    /** Test Explorer names runs by what started them. */
    private runName(batch: ChangeBatch, request: vscode.TestRunRequest | undefined, manual: ManualSelection | undefined, label: string | undefined): string {
        if (request) {return manual?.configuration ? l10n.t('Testy · manual ({0})', manual.configuration) : l10n.t('Testy · manual');}
        if (manual?.discoverOnly) {return l10n.t('Testy · discover tests');}
        if (label) {return label;}
        if (!batch.files.length) {return this.engine.coverage.traces.size ? l10n.t('Testy · workspace refresh') : l10n.t('Testy · baseline');}
        return this.config.trigger === 'save' ? l10n.t('Testy · on save: {0}', fileNames(batch.files)) : l10n.t('Testy · on change: {0}', fileNames(batch.files));
    }

    private async execute(batch: ChangeBatch, signal: AbortSignal, { request, manual, manualOperation = false, scope, label }: {
        request?: vscode.TestRunRequest; manual?: ManualSelection; manualOperation?: boolean; scope?: RunScope | undefined; label?: string;
    } = {}): Promise<void> {
        // File events are coalesced; mark them before the run reads sources.
        await this.changes.flush();
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {cancel();}
        // Any run that tests, automatic or manual, settles the open baseline question for this session; rediscovery does not.
        if (!manual?.discoverOnly) {this.awaitingBaseline = false;}
        // Automatic runs collect coverage while a continuous run from a coverage profile is active.
        const automaticCoverage = !manual && (this.config.coverage || !!this.continuousCoverage.size);
        const profile = manual?.debug ? this.debugProfile : (manual ? manual.coverage : automaticCoverage) ? this.coverageProfile : this.runProfile;
        // Results persist so outcomes of tests a later incremental run skips survive a reload;
        // retained coverage does not depend on it (CoverageView republishes it from the cache).
        const run = this.controller.createTestRun(request ?? (manual ? undefined : this.continuousRequest(automaticCoverage)) ?? new vscode.TestRunRequest(undefined, undefined, profile),
            this.runName(batch, request, manual, label), !manual?.discoverOnly);
        const cancellation = run.token.onCancellationRequested(cancel);
        this.activeRun = run; this.activeRequest = request; this.coverage.beginRun(); this.lastError = '';
        this.build = 'none'; this.diagnostics.begin(); this.baselineRun = !manual;
        this.discovering = !!manual?.discoverOnly; this.tree.setBusy(this.discovering);
        try {
            this.lastSummary = await this.engine.run(batch, abort.signal, manual, manualOperation, scope, manual ? undefined : automaticCoverage);
            const { passed, failed, skipped, duration, failedBatches } = this.lastSummary;
            this.output.info(`${passed} passed, ${failed} failed, ${skipped} skipped in ${(duration / 1000).toFixed(1)}s.`);
            if (failedBatches) {this.output.warn(`${failedBatches} test batch${failedBatches === 1 ? '' : 'es'} could not run; their tests are reported as errored.`);}
        } catch (error) {
            if (!abort.signal.aborted && !isAbortError(error)) {
                run.appendOutput(`${String(error)}\r\n`);
                this.reportError(error);
            }
            throw error;
        } finally {
            cancellation.dispose(); signal.removeEventListener('abort', cancel);
            this.diagnostics.flush();
            // A build that finished, or failed, replaces the previous diagnostics; a cancelled build does not.
            // (Phase events update the build state while the engine runs.)
            const build = this.build as Testy['build'];
            const buildFailed = build === 'building' && !!this.lastError && !abort.signal.aborted;
            if (build === 'built' || buildFailed) {this.diagnostics.publish();}
            // A successful build also covers projects whose earlier build failed: their changes stayed pending.
            if (build === 'built') {this.tree.clearBuildFailures();} else if (buildFailed) {this.tree.showBuildFailures(this.diagnostics.values, this.lastError);}
            this.discovering = false; this.tree.setBusy(false);
            this.baselineRun = false; this.baselineProgress.end(); this.tree.restoreDescriptions(); run.end(); this.activeRun = undefined; this.activeRequest = undefined; this.phase = undefined; this.updateStatus();
        }
    }

    updateStatus(): void {
        // Engine and tree callbacks can report status while the constructor is still assigning the views.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.disposed || !this.coverage) {return;}
        this.statusBar.update({
            paused: this.paused, running: this.scheduler.isRunning, scheduling: this.scheduling, phase: this.phase,
            lastError: this.lastError, lastSummary: this.lastSummary, passed: this.tree.passed, failed: this.tree.failed,
            hasTests: !!this.engine.groups.length, coverageSuffix: this.coverage.suffix, continuousOverride: !!this.continuous.size && this.userPaused,
            pauseSource: this.pauseSource, autoRunSetting: this.config.enabled
        });
    }

    /** Log an error and show it in the status bar. Startup and environment errors (or `notify`) are also shown once per session as a notification. */
    reportError(error: unknown, notify = false): void {
        if (isAbortError(error) || this.disposed) {return;}
        if (typeof error === 'object' && error) {if (this.reported.has(error)) {return;} this.reported.add(error);}
        this.lastError = errorMessage(error);
        this.output.error(this.lastError); this.updateStatus();
        if (isEnvironmentError(error) && error.code === 'no-test-project') {setContext('testy.noTestProjects', true);}
        if (notify || environmentError(error)) {this.notify(this.lastError, 'error', isEnvironmentError(error) ? environmentSummary(error.code) : undefined);}
    }

    /** Coverage setup failed: usually NuGet is unreachable (offline, or a proxy) or testy.coverageToolPath is wrong. */
    private coverageUnavailable(): void {
        const message = this.config.coverageTool
            ? l10n.t('Coverage is unavailable: the dotnet-coverage tool set in testy.coverageToolPath could not be used. Tests run with project-wide selection. See the output for details.')
            : l10n.t('Coverage is unavailable: Microsoft\'s dotnet-coverage tool could not be installed from NuGet. Offline or behind a proxy? Install dotnet-coverage and set testy.coverageToolPath to it. Tests run with project-wide selection meanwhile.');
        this.notify(message, 'warning', undefined, '@id:testy.coverageToolPath');
    }

    /** Shows the first line of `message` once per session, or `shown` (localized) in its place; Open Settings opens `settings`. */
    private notify(message: string, severity: 'error' | 'warning', shown?: string, settingsQuery = extensionSettings): void {
        const summary = (message.split(/\r?\n/, 1)[0] ?? '').trim();
        if (this.notified.has(summary)) {return;}
        this.notified.add(summary);
        const output = l10n.t('Show Output'), settings = l10n.t('Open Settings');
        const text = l10n.t('Testy: {0}', shown ?? summary);
        void Promise.resolve(severity === 'error' ? vscode.window.showErrorMessage(text, output, settings) : vscode.window.showWarningMessage(text, output, settings)).then(async choice => {
            if (choice === output) {this.output.show();}
            else if (choice === settings) {await vscode.commands.executeCommand('workbench.action.openSettings', settingsQuery);}
        }).catch(() => undefined);
    }

    private bindCancellation(token: vscode.CancellationToken): { controller: AbortController; dispose(): void } {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) {controller.abort();}
        return { controller, dispose: () => {registration.dispose();} };
    }

    dispose(): Promise<void> {
        if (this.disposal) {return this.disposal;}
        this.lifetime.abort();
        this.changes.dispose(); this.sweep.dispose();
        this.disposed = true; this.baselineProgress.dispose(); this.scheduler.dispose();
        this.disposal = this.engine.dispose();
        // Subscription disposal is synchronous; deactivate also awaits this work.
        void this.disposal.catch((error: unknown) => console.error('Testy prepared-output cleanup failed.', error));
        this.disposables.forEach(disposable => {disposable.dispose();});
        this.coverage.dispose(); this.inline.dispose();
        this.activeRun?.end(); this.controller.dispose(); this.statusBar.dispose();
        for (const key of ['testy.active', 'testy.paused', 'testy.running', 'testy.noTestProjects']) {setContext(key, false);}
        return this.disposal;
    }
}
