import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { configuration, Configuration } from './configuration';
import { CoverageSummary } from './core/coverage';
import { TestFile, TestResult } from './core/model';
import { contentHash, isExcluded, isInside, matchesPattern, normalizePath } from './core/paths';
import { ChangeBatch, Scheduler, SchedulerState } from './core/scheduler';
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
    private watchers: vscode.FileSystemWatcher[] = [];
    private watchSignature = '';
    private readonly publishedCoverage = new Map<string, CoverageSummary>();
    private renderTimer: NodeJS.Timeout | undefined;
    private readonly pendingEditors = new Set<vscode.TextEditor>();
    private productionSources = new Set<string>();
    private coverageSuffix = '';
    private passed = 0;
    private failed = 0;
    private activeRun: vscode.TestRun | undefined;
    private phase = '';
    private scheduling: SchedulerState = 'idle';
    private lastSummary: RunSummary | undefined;
    private lastError = '';
    private disposed = false;
    private readonly lifetime = new AbortController();

    constructor(private readonly context: vscode.ExtensionContext, private roots: readonly string[]) {
        this.config = configuration();
        this.decorations = Object.fromEntries(['covered', 'uncovered', 'stale'].map(kind => [kind, vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', `${kind}.svg`), gutterIconSize: 'contain'
        })])) as typeof this.decorations;
        const storage = context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, contentHash(roots.join('\0')));
        this.engine = new TestEngine({
            roots, storage, tools: context.globalStorageUri.fsPath,
            analyzer: path.join(context.extensionPath, 'dist', 'analyzer', 'Testy.Analysis.dll'), configuration: () => this.config,
            events: {
                output: text => { if (this.disposed) {return;} this.output.append(text); this.activeRun?.appendOutput(text.replace(/\r?\n/g, '\r\n')); },
                phase: phase => { this.phase = phase; this.updateStatus(); },
                discovered: groups => this.updateTree(groups),
                selected: selection => {
                    this.output.appendLine(`${selection.reason}: ${selection.groups.length} of ${this.engine.groups.length} test files.`);
                    const invalidated: vscode.TestItem[] = [];
                    for (const group of selection.groups) {for (const test of this.engine.knownTests(group)) {
                        const item = this.items.get(`${group.id}:${test.id}`);
                        if (item) {invalidated.push(item); this.setOutcome(item.id); this.activeRun?.enqueued(item);}
                    }}
                    this.controller.invalidateTestResults(invalidated);
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
            try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal, undefined, undefined, true), abort.controller.signal, true); }
            catch (error) { this.reportError(error); }
            finally { abort.dispose(); }
        };
        this.status.name = 'Testy'; this.status.command = 'testy.toggleAutoRun'; this.status.show();
        this.disposables.push(
            vscode.commands.registerCommand('testy.refreshTests', async () => {
                try { await this.scheduler.runManual(signal => this.execute({ files: [], full: true }, signal, undefined, undefined, true), undefined, true); }
                catch (error) { this.reportError(error); }
            }),
            vscode.commands.registerCommand('testy.toggleAutoRun', async () => {
                await vscode.workspace.getConfiguration('testy').update('autoRun', !this.config.enabled, vscode.ConfigurationTarget.Workspace);
            }),
            vscode.commands.registerCommand('testy.showOutput', () => this.output.show()),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (this.config.trigger === 'save') {void this.changed(document.uri, document.getText());}
            }),
            vscode.workspace.onDidDeleteFiles(event => { for (const uri of event.files) {void this.changed(uri, undefined, true);} }),
            vscode.workspace.onDidRenameFiles(event => { for (const file of event.files) { void this.changed(file.oldUri, undefined, true); void this.changed(file.newUri, undefined, true); } }),
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
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
                this.engine.setRoots(this.roots); this.watch(); this.scheduler.request([], true);
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.queueDecorations(vscode.window.visibleTextEditors)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.contentChanges.length) {this.queueDecorations(vscode.window.visibleTextEditors.filter(editor => editor.document === event.document));}
            })
        );
    }

    async start(): Promise<void> {
        await this.engine.restore(this.lifetime.signal);
        if (this.disposed) {return;}
        this.watch(); this.scheduler.setPaused(!this.config.enabled);
        this.scheduler.request([], true);
    }

    snapshot(): unknown {
        return {
            running: this.scheduler.isRunning, paused: this.scheduler.isPaused, phase: this.phase,
            error: this.lastError, summary: this.lastSummary,
            groups: this.engine.groups, baseline: this.engine.baselineProgress, coverage: this.engine.coverage.summarize(this.engine.hashes),
            status: this.status.text, outcomes: Object.fromEntries(this.outcomes)
        };
    }

    private watch(): void {
        const external: string[] = [];
        for (const directory of this.engine.directories.filter(directory => !this.roots.some(root => isInside(directory, root)))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))) {
            if (!external.some(parent => isInside(directory, parent))) {external.push(directory);}
        }
        const inputDirectories = [...new Set(this.engine.knownFiles.filter(file => !matchesPattern(file, this.config.pattern, this.roots)).map(file => path.dirname(file)))];
        const signature = JSON.stringify([this.config.trigger, this.config.pattern, this.roots, external, inputDirectories]);
        if (signature === this.watchSignature) {return;}
        this.watchSignature = signature;
        this.watchers.forEach(watcher => watcher.dispose()); this.watchers = [];
        if (this.config.trigger !== 'fileSystem') {return;}
        for (const pattern of [this.config.pattern, ...external.map(directory => new vscode.RelativePattern(directory, this.config.pattern)),
            ...inputDirectories.map(directory => new vscode.RelativePattern(directory, '*'))]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(uri => {void this.changed(uri);});
            watcher.onDidCreate(uri => {void this.changed(uri, undefined, true);});
            watcher.onDidDelete(uri => {void this.changed(uri, undefined, true);});
            this.watchers.push(watcher);
        }
    }

    private async changed(uri: vscode.Uri, content?: string, directoryEvent = false): Promise<void> {
        if (this.disposed || uri.scheme !== 'file') {return;}
        const file = normalizePath(uri.fsPath);
        if (!this.roots.some(root => isInside(file, root)) && !this.engine.knownFiles.includes(file)
            && !this.engine.knownFiles.some(known => isInside(known, file))
            && !this.engine.directories.some(directory => isInside(file, directory))) {return;}
        if (isExcluded(file, this.config.excludes, this.roots)) {return;}
        const descendants = directoryEvent ? this.engine.knownFiles.filter(known => known !== file && isInside(known, file)) : [];
        let directory = descendants.length > 0;
        if (directoryEvent && !directory) {try {directory = (await fs.stat(file)).isDirectory();} catch { /* Deleted path. */ }}
        if (!directory && !this.engine.knownFiles.includes(file) && !matchesPattern(file, this.config.pattern, this.roots)) {return;}
        if (!directory && file.endsWith('.cs')) {
            if (content === undefined) {
                let handle: fs.FileHandle | undefined;
                try {handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer); content = buffer.toString('utf8', 0, bytesRead);}
                catch { /* Deleted file. */ } finally {await handle?.close();}
            }
            if (/<auto-generated\b/i.test(content?.slice(0, 2048) ?? '')) {return;}
        }
        if (this.disposed) {return;}
        const files = [...descendants, file];
        this.scheduler.request(files, directory);
        // Preserve historical outcomes until analysis identifies the actual
        // selection. Conservative invalidation cannot be undone in Test Explorer.
        await this.engine.markChanged(files);
    }

    private setOutcome(id: string, outcome?: string): void {
        const previous = this.outcomes.get(id);
        if (previous === 'passed') {this.passed--;}
        if (previous === 'failed' || previous === 'errored') {this.failed--;}
        if (outcome) {this.outcomes.set(id, outcome);} else {this.outcomes.delete(id);}
        if (outcome === 'passed') {this.passed++;}
        if (outcome === 'failed' || outcome === 'errored') {this.failed++;}
    }

    private updateTree(groups: readonly TestFile[]): void {
        if (this.disposed) {return;}
        this.productionSources = new Set(this.engine.projects.filter(project => !project.isTestProject).flatMap(project => [...project.sourceFiles]));
        this.watch();
        const projectCounts = new Map<string, number>();
        for (const group of groups) {projectCounts.set(group.project, (projectCounts.get(group.project) ?? 0) + this.engine.knownTests(group).length);}
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
            const children = this.engine.knownTests(group).map(test => {
                const id = `${group.id}:${test.id}`;
                const item = this.item(id, test.name, test.file);
                if (test.file) {item.range = new vscode.Range(Math.max(0, test.line - 1), 0, Math.max(0, test.line - 1), 0);}
                live.add(id); this.testIds.set(id, { group: group.id, test: test.id });
                return item;
            });
            file.children.replace(children);
            project.description = `${projectCounts.get(group.project)} tests`;
        }
        for (const [id, files] of projects) {this.items.get(id)!.children.replace(files);}
        this.controller.items.replace([...projects.keys()].map(id => this.items.get(id)!));
        for (const id of this.items.keys()) {if (!live.has(id)) { this.items.delete(id); this.setOutcome(id); }}
        this.updateStatus();
    }

    private item(id: string, label: string, file?: string): vscode.TestItem {
        const existing = this.items.get(id);
        if (existing) { existing.label = label; return existing; }
        const item = this.controller.createTestItem(id, label, file ? vscode.Uri.file(file) : undefined);
        this.items.set(id, item); return item;
    }

    private async manual(request: vscode.TestRunRequest, token: vscode.CancellationToken, coverage: boolean): Promise<void> {
        const scope = (items: readonly vscode.TestItem[] | undefined, all = false): ManualSelection => {
            const groups = new Set<string>(), projects = new Set<string>(), tests = new Map<string, Set<string>>();
            for (const item of items ?? []) {
                const identity = this.testIds.get(item.id);
                if (identity) {
                    const ids = tests.get(identity.group) ?? new Set<string>(); ids.add(identity.test); tests.set(identity.group, ids); groups.add(identity.group);
                } else if (item.id.startsWith('project:')) {projects.add(item.id.slice('project:'.length));}
                else if (item.id.startsWith('file:')) {groups.add(item.id.slice('file:'.length));}
            }
            // Container selection wins when VS Code also includes a child.
            for (const item of items ?? []) {if (item.id.startsWith('file:')) {tests.delete(item.id.slice('file:'.length));}}
            return { all, projects, groups, tests };
        };
        const selection: ManualSelection = { ...scope(request.include, !request.include),
            exclude: request.exclude?.length ? scope(request.exclude) : undefined, coverage };
        const abort = this.bindCancellation(token);
        try { await this.scheduler.runManual(signal => this.execute({ files: [], full: false }, signal, request, selection), abort.controller.signal); }
        catch (error) { this.reportError(error); }
        finally { abort.dispose(); }
    }

    private async execute(batch: ChangeBatch, signal: AbortSignal, request?: vscode.TestRunRequest, manual?: ManualSelection, manualOperation = false): Promise<void> {
        const abort = new AbortController();
        const cancel = (): void => abort.abort();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {cancel();}
        const run = this.controller.createTestRun(request ?? new vscode.TestRunRequest(undefined, undefined, this.config.coverage ? this.coverageProfile : this.runProfile), request ? 'Testy · manual' : 'Testy', true);
        const cancellation = run.token.onCancellationRequested(cancel);
        this.activeRun = run; this.publishedCoverage.clear(); this.lastError = '';
        try {
            this.lastSummary = await this.engine.run(batch, abort.signal, manual, manualOperation);
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
        if (this.disposed) {return;}
        const id = `${group.id}:${result.id}`;
        this.testIds.set(id, { group: group.id, test: result.id });
        let item = this.items.get(id);
        if (!item) {
            item = this.item(id, result.name, group.file);
            this.items.get(`file:${group.id}`)?.children.add(item);
        }
        this.setOutcome(id, result.outcome);
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
        if (this.disposed) {return;}
        let total = 0, covered = 0;
        for (const summary of this.engine.coverage.summarize(this.engine.hashes)) {
            if (summary.stale) {continue;}
            if (this.productionSources.has(summary.file)) {total += summary.total; covered += summary.covered;}
            if (!this.activeRun) {continue;}
            const previous = this.publishedCoverage.get(summary.file);
            if (previous?.lines === summary.lines && previous.covered === summary.covered && previous.total === summary.total) {continue;}
            const coverage = new vscode.FileCoverage(vscode.Uri.file(summary.file), { covered: summary.covered, total: summary.total });
            this.details.set(coverage, summary); this.publishedCoverage.set(summary.file, summary); this.activeRun.addCoverage(coverage);
        }
        this.coverageSuffix = total ? ` · ${Math.round(covered / total * 100)}%` : '';
        this.queueDecorations(vscode.window.visibleTextEditors); this.updateStatus();
    }

    private queueDecorations(editors: readonly vscode.TextEditor[]): void {
        if (this.disposed) {return;}
        editors.forEach(editor => this.pendingEditors.add(editor));
        this.renderTimer ??= setTimeout(() => {
            this.renderTimer = undefined;
            const pending = [...this.pendingEditors]; this.pendingEditors.clear();
            this.decorate(pending);
        }, 50);
    }

    private decorate(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
        if (this.disposed) {return;}
        for (const editor of editors) {
            const entries: Record<'covered' | 'uncovered' | 'stale', vscode.DecorationOptions[]> = { covered: [], uncovered: [], stale: [] };
            const summary = this.config.showCoverage ? this.engine.coverage.summary(normalizePath(editor.document.uri.fsPath), this.engine.hashes) : undefined;
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
        const { passed, failed } = this;
        const suffix = this.coverageSuffix;
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
        this.lifetime.abort();
        this.disposed = true; this.scheduler.dispose(); this.watchers.forEach(watcher => watcher.dispose());
        if (this.renderTimer) {clearTimeout(this.renderTimer);} this.pendingEditors.clear();
        this.disposables.forEach(disposable => disposable.dispose());
        Object.values(this.decorations).forEach(decoration => decoration.dispose());
        this.activeRun?.end(); this.controller.dispose(); this.output.dispose(); this.status.dispose();
    }
}
