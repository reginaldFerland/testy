import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { configuration, Configuration } from './configuration';
import { BuildDiagnostic, diagnosticKey, LineSplitter, parseBuildDiagnostic } from './core/diagnostics';
import { escape } from 'minimatch';
import { InputIndex, InputSource } from './core/inputIndex';
import { TestFile } from './core/model';
import { contentHash, isInheritedConfiguration, isExcluded, isGeneratedSource, isInside, matchesPattern, normalizePath } from './core/paths';
import { ChangeBatch, Scheduler, SchedulerState } from './core/scheduler';
import { Selection } from './core/selection';
import { ManualSelection, RunPhase, RunScope, RunSummary, TestEngine } from './services/engine';
import { BaselineProgress } from './ui/baselineProgress';
import { CoverageView } from './ui/coverage';
import { exportCoverageFile } from './ui/exportCoverage';
import { errorMessage, isAbortError } from './core/errors';
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
// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

/** Known inputs and their directories, rebuilt only when the engine's inputs change. */
function inputIndex(owner: { inputs?: InputIndex }, engine: InputSource): InputIndex {
    return (owner.inputs ??= new InputIndex(engine)).refresh();
}

/** Startup and environment failures the user must fix; routine build and test failures stay in the status bar. */
export function environmentError(message: string): boolean {
    return /^Cannot find .+ on PATH|^Could not start |requires \.NET SDK 10|\.NET host could not be resolved|^testy\.\w+|^(Reading portable symbols|Analyzing [^\n]*) failed|time limit: analyzer|^No test project can run under Testy|did not connect to Testy/m.test(message);
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
    private readonly diagnostics = vscode.languages.createDiagnosticCollection('testy');
    private readonly disposables: vscode.Disposable[] = [];
    private readonly engine: TestEngine;
    private readonly tree: TestTree;
    private readonly coverage: CoverageView;
    private readonly baselineProgress = new BaselineProgress(() => this.scheduler.cancel());
    /** Whether the current run advances the baseline; manual runs do not. */
    private baselineRun = false;
    private readonly scheduler: Scheduler;
    private readonly runProfile: vscode.TestRunProfile;
    private readonly coverageProfile: vscode.TestRunProfile;
    private readonly debugProfile: vscode.TestRunProfile;
    /** Manual Run and Coverage profiles for `testy.additionalConfigurations`, and the configurations they were made for. */
    private configurationProfiles: vscode.TestRunProfile[] = [];
    private profileConfigurations: readonly string[] = [];
    config: Configuration;
    private pauseOverride: boolean | undefined;
    /** Active continuous runs; while any exists, automatic runs proceed even when paused. */
    private readonly continuous = new Set<RunScope>();
    /** Continuous runs started from a coverage profile; automatic runs then collect and show coverage. */
    private readonly continuousCoverage = new Set<RunScope>();
    /** Collect coverage in the current automatic run although `testy.runWithCoverage` is off. */
    private forceCoverage = false;
    /** Messages already shown as notifications this session. */
    private readonly notified = new Set<string>();
    /** The latest selection, for "Why was this selected?". */
    private lastSelection: Selection | undefined;
    /** The startup baseline waits for the user's answer, a save or a manual run; setting and folder changes do not start it. */
    private awaitingBaseline = false;
    private watchers: vscode.FileSystemWatcher[] = [];
    private watchSignature = '';
    inputs?: InputIndex;
    activeRun: vscode.TestRun | undefined;
    private activeRequest: vscode.TestRunRequest | undefined;
    private phase: RunPhase | undefined;
    private scheduling: SchedulerState = 'idle';
    private lastSummary: RunSummary | undefined;
    private lastError = '';
    private readonly lines = new LineSplitter();
    private buildDiagnostics = new Map<string, BuildDiagnostic>();
    /** Whether the current run reached, or completed, its build. */
    private build: 'none' | 'building' | 'built' = 'none';
    disposed = false;
    private disposal?: Promise<void>;
    readonly lifetime = new AbortController();

    constructor(private readonly context: vscode.ExtensionContext, public roots: readonly string[]) {
        this.config = configuration();
        this.pauseOverride = context.workspaceState.get<boolean>(pausedKey);
        const storage = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, contentHash(roots.join('\0')));
        this.engine = new TestEngine({
            roots, storage, tools: context.globalStorageUri.fsPath,
            analyzer: path.join(context.extensionPath, 'dist', 'analyzer', 'Testy.Analysis.dll'), configuration: () => this.forceCoverage ? { ...this.config, coverage: true } : this.config,
            events: {
                output: text => {
                    if (this.disposed) {return;}
                    this.log(this.lines.push(text));
                    this.activeRun?.appendOutput(text.replace(/\r?\n/g, '\r\n'));
                },
                phase: phase => {
                    this.phase = phase;
                    if (phase.kind === 'building') {this.build = 'building';} else if (this.build === 'building') {this.build = 'built';}
                    if (this.baselineRun) {this.baselineProgress.update(this.engine.baselineProgress);}
                    this.updateStatus();
                },
                inputsChanged: () => this.watch(),
                discovered: groups => this.updateTree(groups),
                selected: selection => {
                    this.lastSelection = selection;
                    this.output.info(`${selection.reason}: ${selection.groups.length} of ${this.engine.groups.length} test files.`);
                    this.tree.select(selection.groups);
                    for (const line of this.tree.explain(selection)) {this.output.info(line);}
                },
                started: (group, id) => this.tree.started(group, id),
                result: (group, result) => this.tree.publishResult(group, result),
                coverage: () => this.coverage.publish(),
                invalidated: files => this.scheduler.request(files),
                debug: processId => this.attachDebugger(processId)
            }
        });
        this.scheduler = new Scheduler({
            debounce: this.config.debounce,
            run: async (batch, signal) => { await this.execute(batch, signal, undefined, undefined, false, this.automaticScope()); },
            state: state => { this.scheduling = state; this.updateStatus(); }, error: error => this.reportError(error)
        });
        this.runProfile = this.controller.createRunProfile(l10n.t('Run'), vscode.TestRunProfileKind.Run,
            (request, token) => this.manual(request, token, false), true, undefined, true);
        this.coverageProfile = this.controller.createRunProfile(l10n.t('Run with coverage'), vscode.TestRunProfileKind.Coverage,
            (request, token) => this.manual(request, token, true), true, undefined, true);
        this.debugProfile = this.controller.createRunProfile(l10n.t('Debug'), vscode.TestRunProfileKind.Debug,
            (request, token) => this.debug(request, token), true);
        this.tree = new TestTree(this.controller, this.engine, this);
        this.coverage = new CoverageView(context.extensionUri, this.controller, this.coverageProfile, this.engine, this.tree.items, this);
        this.syncConfigurationProfiles();
        // Test Explorer's refresh rediscovers; it does not run the suite.
        this.controller.refreshHandler = async token => {
            const abort = this.bindCancellation(token);
            try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, undefined, { all: true, groups: new Set(), discoverOnly: true }), abort.controller.signal); }
            catch (error) { this.reportError(error); }
            finally { abort.dispose(); }
        };
        const refreshAll = async (): Promise<void> => {
            try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal, undefined, undefined, true, undefined, l10n.t('Testy · refresh and run all')), undefined, true); }
            catch (error) { this.reportError(error); }
        };
        this.disposables.push(
            this.output, this.diagnostics,
            vscode.commands.registerCommand('testy.refreshTests', refreshAll),
            vscode.commands.registerCommand('testy.toggleAutoRun', () => this.setPaused(!this.scheduler.isPaused)),
            vscode.commands.registerCommand('testy.pause', () => this.setPaused(true)),
            vscode.commands.registerCommand('testy.resume', () => this.setPaused(false)),
            vscode.commands.registerCommand('testy.runAffected', () => this.runAffected()),
            vscode.commands.registerCommand('testy.cancelRun', () => this.scheduler.cancel()),
            vscode.commands.registerCommand('testy.clearCoverage', () => this.clearCoverage()),
            vscode.commands.registerCommand('testy.exportCoverage', () => this.exportCoverage()),
            vscode.commands.registerCommand('testy.resetCaches', () => this.resetCaches()),
            vscode.commands.registerCommand('testy.showOutput', () => this.output.show()),
            vscode.commands.registerCommand('testy.showMenu', () => this.showMenu(refreshAll)),
            vscode.commands.registerCommand('testy.explainSelection', (item?: vscode.TestItem) => this.explain(item)),
            vscode.commands.registerCommand('testy.excludeProject', (item?: vscode.TestItem) => this.excludeProject(item)),
            vscode.commands.registerCommand('testy.runFile', (uri?: vscode.Uri, uris?: readonly vscode.Uri[]) => this.runFiles(uris?.length ? uris : uri ? [uri] : [])),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (this.config.trigger === 'save') {void this.changed(document.uri).catch((error: unknown) => this.reportError(error));}
            }),
            vscode.workspace.onDidDeleteFiles(event => { for (const uri of event.files) {void this.changed(uri, undefined, true).catch((error: unknown) => this.reportError(error));} }),
            vscode.workspace.onDidRenameFiles(event => { for (const file of event.files) { void this.changed(file.oldUri, undefined, true).catch((error: unknown) => this.reportError(error)); void this.changed(file.newUri, undefined, true).catch((error: unknown) => this.reportError(error)); } }),
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
                    this.watch(); this.coverage.queue(vscode.window.visibleTextEditors);
                    if (['runMode', 'runWithCoverage', 'buildConfiguration', 'dotnetPath', 'testArguments', 'exclude', 'coverageToolPath', 'solution', 'projects'].some(key => event.affectsConfiguration(`testy.${key}`)) && !this.awaitingBaseline) {this.scheduler.request([], true);}
                } catch (error) { this.reportError(error, true); }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                try {
                    this.roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
                    // Folder-level settings depend on the folder list.
                    this.config = configuration(); this.warnFolderConflicts(); this.syncConfigurationProfiles();
                    this.engine.setRoots(this.roots); this.watch(); if (!this.awaitingBaseline) {this.scheduler.request([], true);}
                } catch (error) { this.reportError(error, true); }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.coverage.queue(vscode.window.visibleTextEditors)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.contentChanges.length) {this.coverage.queue(vscode.window.visibleTextEditors.filter(editor => editor.document === event.document));}
            })
        );
        setContext('testy.active', true);
        this.warnFolderConflicts();
    }

    async start(): Promise<void> {
        await this.engine.restore(this.lifetime.signal);
        if (this.disposed) {return;}
        this.watch(); this.scheduler.setPaused((this.pauseOverride ?? !this.config.enabled) && !this.continuous.size);
        const consent = this.context.workspaceState.get<string>(baselineConsentKey);
        // Workspaces with retained coverage, or whose user already agreed, continue as before;
        // a paused workspace keeps the request queued until the user resumes.
        if (consent === 'always' || this.engine.coverage.traces.size || this.userPaused) {this.scheduler.request([], true);}
        else if (consent !== 'manual') {this.askForBaseline();}
        else {this.awaitingBaseline = true; this.output.info('Waiting for a save or a manual run before establishing the baseline.');}
        this.noticeDevKit();
    }

    /** First open of a workspace: building and running every test is the user's call. */
    private askForBaseline(): void {
        this.awaitingBaseline = true;
        this.output.info('Waiting for permission to establish the baseline; a save or a manual run also starts it.');
        const run = l10n.t('Run Now'), later = l10n.t('Not Now'), never = l10n.t('Don\'t Ask Again');
        void Promise.resolve(vscode.window.showInformationMessage(
            l10n.t('Testy can build this workspace and run every C# test once to learn which tests cover which code. Start the baseline now?'), run, later, never))
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
            running: this.scheduler.isRunning, paused: this.scheduler.isPaused, phase: this.phase ? describePhase(this.phase) : '',
            error: this.lastError, summary: this.lastSummary, awaitingBaseline: this.awaitingBaseline,
            groups: this.engine.displayGroups, baseline: this.engine.baselineProgress, coverage: this.engine.coverage.summarize(this.engine.hashes),
            status: this.statusBar.text, outcomes: Object.fromEntries(this.tree.outcomes),
            diagnostics: [...this.buildDiagnostics.values()]
        };
    }

    /** The user's pause choice, before continuous runs override it. */
    private get userPaused(): boolean { return this.pauseOverride ?? !this.config.enabled; }

    private storePause(paused: boolean | undefined): void {
        this.pauseOverride = paused;
        void Promise.resolve(this.context.workspaceState.update(pausedKey, paused)).catch((error: unknown) => this.reportError(error));
    }

    private applyPause(): void {
        this.scheduler.setPaused(this.userPaused && !this.continuous.size);
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
        const scopes = [...this.continuous];
        if (scopes.some(scope => scope.all && !scope.exclude)) {return undefined;}
        if (scopes.length === 1) {return scopes[0];}
        return {
            all: scopes.some(scope => scope.all), groups: new Set(scopes.flatMap(scope => [...scope.groups])),
            projects: new Set(scopes.flatMap(scope => [...scope.projects ?? []])),
            tests: new Map(scopes.flatMap(scope => [...scope.tests ?? []]).map(([group, ids]) => [group, new Set(ids)]))
        };
    }

    private async runAffected(): Promise<void> {
        const batch = this.scheduler.pendingBatch;
        try { await this.scheduler.runManual(signal => this.execute(batch, signal, undefined, undefined, false, undefined, l10n.t('Testy · run affected')), undefined, true); }
        catch (error) { this.reportError(error); }
    }

    /** Run the tests affected by files, as if they had been saved. */
    private async runFiles(uris: readonly vscode.Uri[]): Promise<void> {
        const active = vscode.window.activeTextEditor?.document.uri;
        const files = (uris.length ? uris : active ? [active] : []).filter(uri => uri.scheme === 'file').map(uri => normalizePath(uri.fsPath));
        if (!files.length) {return;}
        try { await this.scheduler.runManual(signal => this.execute({ files, full: false }, signal, undefined, undefined, false, undefined, l10n.t('Testy · run file: {0}', fileNames(files)))); }
        catch (error) { this.reportError(error); }
    }

    /** "Why was this selected?" for a Test Explorer item. */
    private explain(item: vscode.TestItem | undefined): void {
        if (!item) {return;}
        void Promise.resolve(vscode.window.showInformationMessage(explainItem(this.lastSelection, this.tree.testIds, item.id, item.label))).catch(() => undefined);
    }

    /** Add a project to `testy.projects.exclude`, at folder level in a multi-root workspace. */
    private async excludeProject(item: vscode.TestItem | undefined): Promise<void> {
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
            this.output.info(`Excluded ${project} through testy.projects.exclude (${pattern}).`);
            void Promise.resolve(vscode.window.showInformationMessage(l10n.t('{0} is excluded from Testy. Remove it from testy.projects.exclude to include it again.', item.label))).catch(() => undefined);
        } catch (error) { this.reportError(error); }
    }

    private clearCoverage(): void {
        this.coverage.hide(); this.updateStatus();
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
                this.diagnostics.clear(); this.buildDiagnostics.clear(); this.tree.clearBuildFailures();
                await this.engine.reset(signal);
            });
            this.scheduler.request([], true);
        } catch (error) { this.reportError(error); }
    }

    private showMenu(refreshAll: () => Promise<void>): Promise<void> {
        return showMenu({ paused: this.scheduler.isPaused, running: this.scheduler.isRunning, lastError: this.lastError, placeHolder: this.statusBar.tooltip }, {
            setPaused: paused => this.setPaused(paused), runAffected: () => this.runAffected(), refreshAll, cancel: () => this.scheduler.cancel(),
            clearCoverage: () => this.clearCoverage(), exportCoverage: () => this.exportCoverage(), resetCaches: () => this.resetCaches(), showOutput: () => this.output.show()
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

    private watch(): void {
        // Saves need no filesystem plan, regardless of workspace size.
        const signature = JSON.stringify([this.config.trigger, this.config.pattern, this.roots, this.engine.inputVersion]);
        if (signature === this.watchSignature) {return;}
        this.watchSignature = signature;
        this.watchers.forEach(watcher => {watcher.dispose();}); this.watchers = [];
        if (this.config.trigger !== 'fileSystem') {return;}
        const index = inputIndex(this, this.engine), inputs = index.files;
        const external: string[] = [];
        for (const directory of index.sourceDirectories.filter(directory => !this.roots.some(root => isInside(directory, root)))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))) {
            if (!external.some(parent => isInside(directory, parent))) {external.push(directory);}
        }
        const inputDirectories = [...new Set(inputs.filter(file => !matchesPattern(file, this.config.pattern, this.roots)
            || (isInheritedConfiguration(file) && !this.roots.some(root => isInside(file, root)))).map(file => path.dirname(file)))];
        for (const pattern of [this.config.pattern, ...external.map(directory => new vscode.RelativePattern(directory, this.config.pattern)),
            ...inputDirectories.map(directory => new vscode.RelativePattern(directory, '*'))]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(uri => {void this.changed(uri).catch((error: unknown) => this.reportError(error));});
            watcher.onDidCreate(uri => {void this.changed(uri, undefined, true).catch((error: unknown) => this.reportError(error));});
            watcher.onDidDelete(uri => {void this.changed(uri, undefined, true).catch((error: unknown) => this.reportError(error));});
            this.watchers.push(watcher);
        }
    }

    private async changed(uri: vscode.Uri, content?: string | Buffer, directoryEvent = false): Promise<void> {
        if (this.disposed || uri.scheme !== 'file') {return;}
        const file = normalizePath(uri.fsPath);
        const index = inputIndex(this, this.engine);
        if (!this.roots.some(root => isInside(file, root)) && !index.has(file) && !index.descendants(file).length && !index.inSourceDirectory(file)) {return;}
        if (isExcluded(file, this.config.excludes, this.roots)) {return;}
        const descendants = directoryEvent ? index.descendants(file) : [];
        let directory = descendants.length > 0;
        if (directoryEvent && !directory) {try {directory = (await fs.stat(file)).isDirectory();} catch { /* Deleted path. */ }}
        if (directoryEvent && isExcluded(`${file}/`, this.config.excludes, this.roots)) {return;}
        if (!directory && !index.has(file) && !matchesPattern(file, this.config.pattern, this.roots)) {return;}
        if (!directory && /\.cs$/i.test(file)) {
            if (content === undefined) {
                let handle: fs.FileHandle | undefined;
                try {handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer); content = buffer.subarray(0, bytesRead);}
                catch { /* Deleted file. */ } finally {await handle?.close();}
            }
            if (content !== undefined) {
                const generated = isGeneratedSource(file, content);
                this.engine.sources.observeGenerated(file, generated);
                if (generated) {return;}
            } else if (this.engine.sources.isGenerated(file)) {return;}
        }
        // Disposal can happen during the awaits above.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.disposed) {return;}
        const files = [...descendants, file];
        this.scheduler.request(files, directory);
        // Preserve historical outcomes until analysis identifies the actual
        // selection. Conservative invalidation cannot be undone in Test Explorer.
        await this.engine.markChanged(files);
    }

    private async updateTree(groups: readonly TestFile[]): Promise<void> {
        if (this.disposed) {return;}
        this.coverage.productionSources = new Set(this.engine.projects.filter(project => !project.isTestProject).flatMap(project => [...project.sourceFiles]));
        this.watch();
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
            const run = this.controller.createRunProfile(l10n.t('Run ({0})', name), vscode.TestRunProfileKind.Run,
                (request, token) => this.manual(request, token, false, false, name), false);
            const coverage = this.controller.createRunProfile(l10n.t('Run with coverage ({0})', name), vscode.TestRunProfileKind.Coverage,
                (request, token) => this.manual(request, token, true, false, name), false);
            const debug = this.controller.createRunProfile(l10n.t('Debug ({0})', name), vscode.TestRunProfileKind.Debug,
                (request, token) => this.debug(request, token, name), false);
            this.coverage.bind(coverage);
            return [run, coverage, debug];
        });
        this.profileConfigurations = [...wanted];
    }

    private async manual(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean, debug = false, configuration?: string): Promise<void> {
        if (request.continuous) {return this.continuousRun(request, token, coverage);}
        const selection: ManualSelection = { ...requestScope(this.tree.testIds, request), coverage, ...(debug ? { debug } : {}), ...(configuration ? { configuration } : {}) };
        const abort = this.bindCancellation(token);
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, request, selection), abort.controller.signal); }
        catch (error) { this.reportError(error); }
        finally { abort.dispose(); }
    }

    /** A continuous run keeps automatic testing on for its items until cancelled. */
    private async continuousRun(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean): Promise<void> {
        const scope = requestScope(this.tree.testIds, request);
        this.continuous.add(scope); if (coverage) {this.continuousCoverage.add(scope);} this.applyPause();
        try {
            await new Promise<void>(resolve => {
                if (token.isCancellationRequested) {resolve(); return;}
                const registration = token.onCancellationRequested(() => { registration.dispose(); resolve(); });
            });
        } finally {this.continuous.delete(scope); this.continuousCoverage.delete(scope); if (!this.disposed) {this.applyPause();}}
    }

    /** Test Explorer names runs by what started them. */
    private runName(batch: ChangeBatch, request: vscode.TestRunRequest | undefined, manual: ManualSelection | undefined, label: string | undefined): string {
        if (request) {return manual?.configuration ? l10n.t('Testy · manual ({0})', manual.configuration) : l10n.t('Testy · manual');}
        if (manual?.discoverOnly) {return l10n.t('Testy · discover tests');}
        if (label) {return label;}
        if (!batch.files.length) {return this.engine.coverage.traces.size ? l10n.t('Testy · workspace refresh') : l10n.t('Testy · baseline');}
        return this.config.trigger === 'save' ? l10n.t('Testy · on save: {0}', fileNames(batch.files)) : l10n.t('Testy · on change: {0}', fileNames(batch.files));
    }

    private async execute(batch: ChangeBatch, signal: AbortSignal, request?: vscode.TestRunRequest, manual?: ManualSelection, manualOperation = false, scope?: RunScope, label?: string): Promise<void> {
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {cancel();}
        // Any run, automatic or manual, settles the open baseline question for this session.
        this.awaitingBaseline = false;
        // Automatic runs collect coverage while a continuous run from a coverage profile is active.
        this.forceCoverage = !manual && !!this.continuousCoverage.size;
        const profile = manual?.debug ? this.debugProfile : (manual ? manual.coverage : this.config.coverage || this.forceCoverage) ? this.coverageProfile : this.runProfile;
        // Results persist so outcomes of tests a later incremental run skips survive a reload;
        // retained coverage does not depend on it (CoverageView republishes it from the cache).
        const run = this.controller.createTestRun(request ?? new vscode.TestRunRequest(undefined, undefined, profile), this.runName(batch, request, manual, label), !manual?.discoverOnly);
        const cancellation = run.token.onCancellationRequested(cancel);
        this.activeRun = run; this.activeRequest = request; this.coverage.beginRun(); this.lastError = '';
        this.build = 'none'; this.buildDiagnostics = new Map(); this.baselineRun = !manual;
        try {
            this.lastSummary = await this.engine.run(batch, abort.signal, manual, manualOperation, scope);
            const { passed, failed, skipped, duration, failedBatches } = this.lastSummary;
            this.output.info(`${passed} passed, ${failed} failed, ${skipped} skipped in ${(duration / 1000).toFixed(1)}s.`);
            if (failedBatches) {this.output.warn(`${failedBatches} test batch${failedBatches === 1 ? '' : 'es'} could not run; their tests are reported as errored.`);}
        } catch (error) {
            if (!abort.signal.aborted && (error as Error).name !== 'AbortError') {
                run.appendOutput(`${String(error)}\r\n`);
                this.reportError(error);
            }
            throw error;
        } finally {
            cancellation.dispose(); signal.removeEventListener('abort', cancel);
            this.log(this.lines.flush());
            // A build that finished, or failed, replaces the previous diagnostics; a cancelled build does not.
            // (Phase events update the build state while the engine runs.)
            const build = this.build as Testy['build'];
            const buildFailed = build === 'building' && !!this.lastError && !abort.signal.aborted;
            if (build === 'built' || buildFailed) {this.publishDiagnostics();}
            // A successful build also covers projects whose earlier build failed: their changes stayed pending.
            if (build === 'built') {this.tree.clearBuildFailures();} else if (buildFailed) {this.tree.showBuildFailures(this.buildDiagnostics.values(), this.lastError);}
            this.forceCoverage = false; this.baselineRun = false; this.baselineProgress.end(); this.tree.restoreDescriptions(); run.end(); this.activeRun = undefined; this.activeRequest = undefined; this.phase = undefined; this.updateStatus();
        }
    }

    /** Log complete output lines at the level their content implies, collecting build diagnostics. */
    private log(lines: readonly string[]): void {
        for (const line of lines) {
            const diagnostic = parseBuildDiagnostic(line);
            if (diagnostic) {this.buildDiagnostics.set(diagnosticKey(diagnostic), diagnostic);}
            if (diagnostic?.severity === 'error') {this.output.error(line);}
            else if (diagnostic?.severity === 'warning') {this.output.warn(line);}
            else if (line.trim()) {this.output.info(line);}
        }
    }

    private publishDiagnostics(): void {
        const byFile = new Map<string, vscode.Diagnostic[]>();
        for (const item of this.buildDiagnostics.values()) {
            const start = new vscode.Position(Math.max(0, item.line - 1), Math.max(0, item.column - 1));
            const end = item.endLine ? new vscode.Position(Math.max(0, item.endLine - 1), Math.max(0, item.endColumn! - 1)) : start;
            const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), item.message,
                item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            diagnostic.code = item.code; diagnostic.source = 'Testy build';
            const file = path.isAbsolute(item.file) ? item.file : path.resolve(item.project ? path.dirname(item.project) : this.roots[0] ?? '', item.file);
            const list = byFile.get(file) ?? []; list.push(diagnostic); byFile.set(file, list);
        }
        this.diagnostics.clear();
        for (const [file, list] of byFile) {this.diagnostics.set(vscode.Uri.file(file), list);}
    }

    updateStatus(): void {
        // Engine and tree callbacks can report status while the constructor is still assigning the views.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.disposed || !this.coverage) {return;}
        this.statusBar.update({
            paused: this.scheduler.isPaused, running: this.scheduler.isRunning, scheduling: this.scheduling, phase: this.phase,
            lastError: this.lastError, lastSummary: this.lastSummary, passed: this.tree.passed, failed: this.tree.failed,
            hasTests: !!this.engine.groups.length, coverageSuffix: this.coverage.suffix, continuousOverride: !!this.continuous.size && this.userPaused
        });
    }

    /** Log an error and show it in the status bar. Startup and environment errors (or `notify`) are also shown once per session as a notification. */
    reportError(error: unknown, notify = false): void {
        if (isAbortError(error) || this.disposed) {return;}
        this.lastError = errorMessage(error);
        this.output.error(this.lastError); this.updateStatus();
        if (notify || environmentError(this.lastError)) {this.notify(this.lastError, 'error');}
    }

    private notify(message: string, severity: 'error' | 'warning'): void {
        const summary = (message.split(/\r?\n/, 1)[0] ?? '').trim();
        if (this.notified.has(summary)) {return;}
        this.notified.add(summary);
        const output = l10n.t('Show Output'), settings = l10n.t('Open Settings');
        const text = l10n.t('Testy: {0}', summary);
        void Promise.resolve(severity === 'error' ? vscode.window.showErrorMessage(text, output, settings) : vscode.window.showWarningMessage(text, output, settings)).then(async choice => {
            if (choice === output) {this.output.show();}
            else if (choice === settings) {await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:reginaldFerland.testy');}
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
        this.disposed = true; this.baselineProgress.dispose(); this.scheduler.dispose(); this.watchers.forEach(watcher => {watcher.dispose();});
        this.disposal = this.engine.dispose();
        // Subscription disposal is synchronous; deactivate also awaits this work.
        void this.disposal.catch((error: unknown) => console.error('Testy prepared-output cleanup failed.', error));
        this.disposables.forEach(disposable => {disposable.dispose();});
        this.coverage.dispose();
        this.activeRun?.end(); this.controller.dispose(); this.statusBar.dispose();
        for (const key of ['testy.active', 'testy.paused', 'testy.running']) {setContext(key, false);}
        return this.disposal;
    }
}
