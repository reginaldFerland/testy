import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { configuration, Configuration } from './configuration';
import { CoverageSummary } from './core/coverage';
import { TestFile, TestResult } from './core/model';
import { contentHash, isExcluded, isInside, matchesPattern, normalizePath } from './core/paths';
import { ChangeBatch, Scheduler, SchedulerState } from './core/scheduler';
import { selectTests } from './core/selection';
import { ManualSelection, RunSummary, TestEngine } from './services/engine';

export async function activate(context: vscode.ExtensionContext): Promise<{ snapshot: () => unknown } | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
    if (!roots.length || !vscode.workspace.isTrusted) {return;}
    const extension = new Testy(context, roots);
    context.subscriptions.push(extension);
    await extension.start();
    return { snapshot: () => extension.snapshot() };
}

class Testy implements vscode.Disposable {
    private readonly controller = vscode.tests.createTestController('testy', 'Testy');
    private readonly output = vscode.window.createOutputChannel('Testy');
    private readonly status = vscode.window.createStatusBarItem('testy.status', vscode.StatusBarAlignment.Left, 10);
    private readonly disposables: vscode.Disposable[] = [];
    private readonly items = new Map<string, vscode.TestItem>();
    private readonly testIds = new Map<string, { group: string; test: string }>();
    private readonly details = new WeakMap<vscode.FileCoverage, CoverageSummary>();
    private readonly outcomes = new Map<string, string>();
    private readonly decorations: Record<'covered' | 'uncovered' | 'stale', vscode.TextEditorDecorationType>;
    private readonly engine: TestEngine;
    private readonly scheduler: Scheduler;
    private readonly runProfile: vscode.TestRunProfile;
    private readonly coverageProfile: vscode.TestRunProfile;
    private config: Configuration;
    private watcher: vscode.FileSystemWatcher | undefined;
    private activeRun: vscode.TestRun | undefined;
    private phase = '';
    private scheduling: SchedulerState = 'idle';
    private lastSummary: RunSummary | undefined;
    private lastError = '';
    private disposed = false;

    constructor(private readonly context: vscode.ExtensionContext, private readonly roots: readonly string[]) {
        this.config = configuration();
        this.decorations = Object.fromEntries(['covered', 'uncovered', 'stale'].map(kind => [kind, vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `${kind}.svg`), gutterIconSize: 'contain'
        })])) as typeof this.decorations;
        const storage = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, contentHash(roots.join('\0')));
        this.engine = new TestEngine({
            roots, storage, tools: context.globalStorageUri.fsPath,
            analyzer: path.join(context.extensionPath, 'dist', 'analyzer', 'Testy.Analysis.dll'), configuration: () => this.config,
            events: {
                output: text => { this.output.append(text); this.activeRun?.appendOutput(text.replace(/\r?\n/g, '\r\n')); },
                phase: phase => { this.phase = phase; this.updateStatus(); },
                discovered: groups => this.updateTree(groups),
                selected: selection => {
                    this.output.appendLine(`${selection.reason}: ${selection.groups.length} of ${this.engine.groups.length} test files.`);
                    for (const group of selection.groups) {for (const test of group.tests) {
                        const item = this.items.get(`${group.id}:${test.id}`);
                        if (item) {this.outcomes.delete(item.id); this.activeRun?.enqueued(item);}
                    }}
                },
                started: (group, id) => { const item = this.items.get(`${group.id}:${id}`); if (item) {this.activeRun?.started(item);} },
                result: (group, result) => this.publishResult(group, result),
                coverage: () => this.publishCoverage(),
                invalidated: files => this.scheduler.request(files)
            }
        });
        this.scheduler = new Scheduler({
            debounce: this.config.debounce,
            run: async (batch, signal) => { await this.execute(batch, signal); },
            state: state => { this.scheduling = state; this.updateStatus(); }, error: error => this.reportError(error)
        });
        this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
            (request, token) => this.manual(request, token, false), true);
        this.coverageProfile = this.controller.createRunProfile('Run with coverage', vscode.TestRunProfileKind.Coverage,
            (request, token) => this.manual(request, token, true), true);
        this.coverageProfile.loadDetailedCoverage = async (_run, coverage) =>
            (this.details.get(coverage)?.lines ?? []).map(line => new vscode.StatementCoverage(line.hits, new vscode.Position(line.line - 1, 0)));
        this.controller.refreshHandler = async token => {
            const abort = this.bindCancellation(token);
            try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal), abort.controller.signal, true); }
            catch (error) { this.reportError(error); }
            finally { abort.dispose(); }
        };
        this.status.name = 'Testy'; this.status.command = 'testy.toggleAutoRun'; this.status.show();
        this.disposables.push(
            vscode.commands.registerCommand('testy.refreshTests', async () => {
                try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal), undefined, true); }
                catch (error) { this.reportError(error); }
            }),
            vscode.commands.registerCommand('testy.toggleAutoRun', async () => {
                await vscode.workspace.getConfiguration('testy').update('autoRun', !this.config.enabled, vscode.ConfigurationTarget.Workspace);
            }),
            vscode.commands.registerCommand('testy.showOutput', () => this.output.show()),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (this.config.trigger === 'save') {void this.changed(document.uri, document.getText());}
            }),
            vscode.workspace.onDidDeleteFiles(event => { for (const uri of event.files) {void this.changed(uri);} }),
            vscode.workspace.onDidRenameFiles(event => { for (const file of event.files) { void this.changed(file.oldUri); void this.changed(file.newUri); } }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('testy')) {return;}
                try {
                    this.config = configuration();
                    this.scheduler.setDebounce(this.config.debounce);
                    this.scheduler.setPaused(!this.config.enabled);
                    this.watch(); this.decorate();
                    if (['runMode', 'runWithCoverage', 'buildConfiguration', 'dotnetPath', 'testArguments', 'exclude', 'coverageToolPath'].some(key => event.affectsConfiguration(`testy.${key}`))) {this.scheduler.request([], true);}
                } catch (error) { this.reportError(error); }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
            vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) {this.decorate();} })
        );
    }

    async start(): Promise<void> {
        await this.engine.restore();
        if (this.disposed) {return;}
        this.watch(); this.scheduler.setPaused(!this.config.enabled);
        this.scheduler.request([], true);
    }

    snapshot(): unknown {
        return {
            running: this.scheduler.isRunning, paused: this.scheduler.isPaused, phase: this.phase,
            error: this.lastError, summary: this.lastSummary,
            groups: this.engine.groups, coverage: this.engine.coverage.summarize(this.engine.hashes),
            status: this.status.text, outcomes: Object.fromEntries(this.outcomes)
        };
    }

    private watch(): void {
        this.watcher?.dispose();
        this.watcher = undefined;
        if (this.config.trigger !== 'fileSystem') {return;}
        this.watcher = vscode.workspace.createFileSystemWatcher(this.config.pattern);
        this.watcher.onDidChange(uri => { void this.changed(uri); });
        this.watcher.onDidCreate(uri => { void this.changed(uri); });
        this.watcher.onDidDelete(uri => { void this.changed(uri); });
    }

    private async changed(uri: vscode.Uri, content?: string): Promise<void> {
        if (this.disposed || uri.scheme !== 'file') {return;}
        const file = normalizePath(uri.fsPath);
        if (!this.roots.some(root => isInside(file, root)) && !this.engine.projects.some(project => project.sourceFiles.includes(file))) {return;}
        if (isExcluded(file, this.config.excludes, this.roots) || !matchesPattern(file, this.config.pattern, this.roots)) {return;}
        if (file.endsWith('.cs')) {
            try { content ??= (await fs.readFile(file, 'utf8')).slice(0, 2048); } catch { /* Deleted file. */ }
            if (/<auto-generated\b/i.test(content?.slice(0, 2048) ?? '')) {return;}
        }
        const selection = selectTests(this.engine.groups, this.engine.projects, this.engine.coverage.traces, [file], this.config.mode);
        const stale = selection.groups.flatMap(group => group.tests.map(test => this.items.get(`${group.id}:${test.id}`))).filter((item): item is vscode.TestItem => !!item);
        this.controller.invalidateTestResults(stale);
        for (const item of stale) { this.outcomes.delete(item.id); }
        this.scheduler.request([file]);
        try { await this.engine.markChanged(); } catch (error) { this.reportError(error); }
    }

    private updateTree(groups: readonly TestFile[]): void {
        const live = new Set<string>();
        const projects = new Map<string, vscode.TestItem[]>();
        this.testIds.clear();
        for (const group of groups) {
            const projectId = `project:${group.project}`;
            const project = this.item(projectId, path.basename(group.project, '.csproj'), group.project);
            live.add(projectId);
            const files = projects.get(projectId) ?? [];
            const file = this.item(`file:${group.id}`, `${path.basename(group.file ?? 'Other tests')} · ${group.framework}`, group.file);
            live.add(file.id); files.push(file); projects.set(projectId, files);
            const children = group.tests.map(test => {
                const id = `${group.id}:${test.id}`;
                const item = this.item(id, test.name, test.file);
                if (test.file) {item.range = new vscode.Range(Math.max(0, test.line - 1), 0, Math.max(0, test.line - 1), 0);}
                live.add(id); this.testIds.set(id, { group: group.id, test: test.id });
                return item;
            });
            file.children.replace(children);
            project.description = `${groups.filter(item => item.project === group.project).reduce((total, item) => total + item.tests.length, 0)} tests`;
        }
        for (const [id, files] of projects) {this.items.get(id)!.children.replace(files);}
        this.controller.items.replace([...projects.keys()].map(id => this.items.get(id)!));
        for (const id of this.items.keys()) {if (!live.has(id)) { this.items.delete(id); this.outcomes.delete(id); }}
        this.updateStatus();
    }

    private item(id: string, label: string, file?: string): vscode.TestItem {
        const existing = this.items.get(id);
        if (existing) { existing.label = label; return existing; }
        const item = this.controller.createTestItem(id, label, file ? vscode.Uri.file(file) : undefined);
        this.items.set(id, item); return item;
    }

    private async manual(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean): Promise<void> {
        const tests = new Map<string, Set<string>>();
        const collect = (item: vscode.TestItem, remove = false): void => {
            const identity = this.testIds.get(item.id);
            if (identity) {
                const ids = tests.get(identity.group) ?? new Set<string>();
                if (remove) {ids.delete(identity.test);} else {ids.add(identity.test);}
                tests.set(identity.group, ids);
            }
            item.children.forEach(child => collect(child, remove));
        };
        if (request.include) {request.include.forEach(item => collect(item));} else {this.controller.items.forEach(item => collect(item));}
        request.exclude?.forEach(item => collect(item, true));
        const selection: ManualSelection = { groups: new Set([...tests].filter(([, ids]) => ids.size).map(([id]) => id)), tests, coverage };
        const abort = this.bindCancellation(token);
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, request, selection), abort.controller.signal); }
        catch (error) { this.reportError(error); }
        finally { abort.dispose(); }
    }

    private async execute(batch: ChangeBatch, signal: AbortSignal, request?: vscode.TestRunRequest, manual?: ManualSelection): Promise<void> {
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {cancel();}
        const run = this.controller.createTestRun(request ?? new vscode.TestRunRequest(undefined, undefined, this.config.coverage ? this.coverageProfile : this.runProfile), request ? 'Testy · manual' : 'Testy', true);
        const cancellation = run.token.onCancellationRequested(cancel);
        this.activeRun = run; this.lastError = '';
        try {
            this.lastSummary = await this.engine.run(batch, abort.signal, manual);
            this.output.appendLine(`${this.lastSummary.passed} passed, ${this.lastSummary.failed} failed, ${this.lastSummary.skipped} skipped in ${(this.lastSummary.duration / 1000).toFixed(1)}s.\n`);
        } catch (error) {
            if (!abort.signal.aborted && (error as Error).name !== 'AbortError') {
                run.appendOutput(`${String(error)}\r\n`);
                this.reportError(error);
            }
            throw error;
        } finally {
            cancellation.dispose(); signal.removeEventListener('abort', cancel);
            run.end(); this.activeRun = undefined; this.phase = ''; this.updateStatus();
        }
    }

    private publishResult(group: TestFile, result: TestResult): void {
        const id = `${group.id}:${result.id}`;
        let item = this.items.get(id);
        if (!item) {
            item = this.item(id, result.name, group.file);
            this.items.get(`file:${group.id}`)?.children.add(item);
        }
        this.outcomes.set(id, result.outcome);
        if (result.outcome === 'passed') {this.activeRun?.passed(item, result.duration);}
        else if (result.outcome === 'skipped') {this.activeRun?.skipped(item);}
        else {
            const message = new vscode.TestMessage([result.message ?? 'The test did not complete successfully.', result.stack].filter(Boolean).join('\n\n'));
            if (item.uri && item.range) {message.location = new vscode.Location(item.uri, item.range);}
            if (result.outcome === 'failed') {this.activeRun?.failed(item, message, result.duration);}
            else {this.activeRun?.errored(item, message, result.duration);}
        }
        if (result.output) {this.activeRun?.appendOutput(result.output.replace(/\r?\n/g, '\r\n'), undefined, item);}
        this.updateStatus();
    }

    private publishCoverage(): void {
        for (const summary of this.engine.coverage.summarize(this.engine.hashes)) {
            if (summary.stale) {continue;}
            const coverage = new vscode.FileCoverage(vscode.Uri.file(summary.file), { covered: summary.covered, total: summary.total });
            this.details.set(coverage, summary); this.activeRun?.addCoverage(coverage);
        }
        this.decorate(); this.updateStatus();
    }

    private decorate(): void {
        const summaries = new Map(this.engine.coverage.summarize(this.engine.hashes).map(summary => [summary.file, summary]));
        for (const editor of vscode.window.visibleTextEditors) {
            const entries: Record<'covered' | 'uncovered' | 'stale', vscode.DecorationOptions[]> = { covered: [], uncovered: [], stale: [] };
            const summary = this.config.showCoverage ? summaries.get(normalizePath(editor.document.uri.fsPath)) : undefined;
            if (summary) {for (const line of summary.lines) {
                if (line.line > editor.document.lineCount) {continue;}
                const stale = summary.stale || editor.document.isDirty;
                const kind = stale ? 'stale' : line.hits > 0 ? 'covered' : 'uncovered';
                entries[kind].push({
                    range: new vscode.Range(line.line - 1, 0, line.line - 1, 0),
                    hoverMessage: stale ? 'Testy: coverage is out of date. It will refresh after the affected tests finish.' : line.hits > 0 ? 'Testy: covered by tests.' : 'Testy: not covered by tests.'
                });
            }}
            for (const kind of ['covered', 'uncovered', 'stale'] as const) {editor.setDecorations(this.decorations[kind], entries[kind]);}
        }
    }

    private updateStatus(): void {
        if (this.disposed || !this.engine || !this.scheduler) {return;}
        const failed = [...this.outcomes.values()].filter(outcome => outcome === 'failed' || outcome === 'errored').length;
        const passed = [...this.outcomes.values()].filter(outcome => outcome === 'passed').length;
        const productionSources = new Set(this.engine.projects.filter(project => !project.isTestProject).flatMap(project => [...project.sourceFiles]));
        const coverage = this.engine.coverage.summarize(this.engine.hashes).filter(file => !file.stale && productionSources.has(file.file));
        const total = coverage.reduce((sum, file) => sum + file.total, 0);
        const covered = coverage.reduce((sum, file) => sum + file.covered, 0);
        const suffix = total ? ` · ${Math.round(covered / total * 100)}%` : '';
        this.status.text = this.scheduler.isPaused ? '$(debug-pause) Testy: paused'
            : this.lastError ? '$(warning) Testy: needs attention'
            : this.phase ? `$(sync~spin) Testy: ${this.phase}`
            : this.scheduling === 'waiting' ? '$(watch) Testy: waiting for changes to settle'
            : `$(beaker) ${failed ? `${failed} failed` : passed ? `${passed} passed` : this.lastSummary && !this.engine.groups.length ? 'Testy: no C# tests found' : 'Testy'}${suffix}`;
        this.status.command = this.lastError ? 'testy.showOutput' : 'testy.toggleAutoRun';
        this.status.backgroundColor = this.lastError || failed ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        this.status.tooltip = [this.lastError || `${passed} passed · ${failed} failed`, this.lastSummary ? `Last run: ${this.lastSummary.files} test files in ${(this.lastSummary.duration / 1000).toFixed(1)}s` : '',
            this.lastSummary && !this.lastSummary.coverageAvailable ? 'Coverage unavailable or disabled; selection uses project fallback.' : '',
            this.lastError ? 'Click to view the error.' : this.scheduler.isPaused ? 'Click to resume automatic testing.' : 'Click to pause automatic testing.', 'Use “Testy: Show Output” for details.'].filter(Boolean).join('\n');
        void vscode.commands.executeCommand('setContext', 'testy.paused', this.scheduler.isPaused);
    }

    private reportError(error: unknown): void {
        if ((error as Error)?.name === 'AbortError' || this.disposed) {return;}
        this.lastError = error instanceof Error ? error.message : String(error);
        this.output.appendLine(this.lastError); this.updateStatus();
    }

    private bindCancellation(token: vscode.CancellationToken): { controller: AbortController; dispose(): void } {
        const controller = new AbortController();
        const registration = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) {controller.abort();}
        return { controller, dispose: () => registration.dispose() };
    }

    dispose(): void {
        this.disposed = true; this.scheduler.dispose(); this.watcher?.dispose();
        this.disposables.forEach(disposable => disposable.dispose());
        Object.values(this.decorations).forEach(decoration => decoration.dispose());
        this.activeRun?.end(); this.controller.dispose(); this.output.dispose(); this.status.dispose();
    }
}
