import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { configuration, Configuration } from './configuration';
import { CoverageSummary } from './core/coverage';
import { TestFile, TestResult } from './core/model';
import { contentHash, isInheritedConfiguration, isExcluded, isGeneratedSource, isInside, matchesPattern, normalizePath, sourceDirectories } from './core/paths';
import { ChangeBatch, Scheduler, SchedulerState } from './core/scheduler';
import { ManualSelection, RunSummary, TestEngine } from './services/engine';

let activeExtension: Testy | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ snapshot: () => unknown } | undefined> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => normalizePath(folder.uri.fsPath));
    if (!roots.length || !vscode.workspace.isTrusted) {return;}
    const extension = new Testy(context, roots);
    activeExtension = extension;
    context.subscriptions.push(extension);
    await extension.start();
    return { snapshot: () => extension.snapshot() };
}

export async function deactivate(): Promise<void> {
    try {await activeExtension?.dispose();}
    finally {activeExtension = undefined;}
}

interface EditorCoverageState {
    readonly document: vscode.TextDocument;
    readonly version: number;
    readonly lineCount: number;
    readonly dirty: boolean;
    readonly show: boolean;
    readonly lines: CoverageSummary['lines'] | undefined;
    readonly stale: boolean | undefined;
}

class Testy implements vscode.Disposable {
    private readonly controller = vscode.tests.createTestController('testy', 'Testy');
    private readonly output = vscode.window.createOutputChannel('Testy');
    private readonly status = vscode.window.createStatusBarItem('testy.status', vscode.StatusBarAlignment.Left, 10);
    private readonly disposables: vscode.Disposable[] = [];
    private readonly items = new Map<string, vscode.TestItem>();
    private readonly testIds = new Map<string, { group: string; test: string }>();
    private readonly treeFiles = new Map<string, { tests: TestFile['tests']; ids: Set<string>; dirty?: boolean }>();
    private readonly treeProjects = new Map<string, readonly string[]>();
    private treeRoots: readonly string[] = [];
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
    private pausedContext: boolean | undefined;
    private readonly publishedCoverage = new Map<string, CoverageSummary>();
    private renderTimer: NodeJS.Timeout | undefined;
    private rendering = false;
    private readonly pendingEditors = new Set<vscode.TextEditor>();
    private decoratedEditors?: WeakMap<vscode.TextEditor, EditorCoverageState>;
    private decorationIndex?: { readonly summaries: readonly CoverageSummary[]; readonly files: ReadonlyMap<string, CoverageSummary> };
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
    private disposal?: Promise<void>;
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
                inputsChanged: () => this.watch(),
                discovered: groups => this.updateTree(groups),
                selected: selection => {
                    this.output.appendLine(`${selection.reason}: ${selection.groups.length} of ${this.engine.groups.length} test files.`);
                    const invalidated: vscode.TestItem[] = [];
                    // The resolved selection is authoritative. Expanding it
                    // with remembered runtime rows would clear unselected failures.
                    for (const group of selection.groups) {for (const test of group.tests) {
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
                if (this.config.trigger === 'save') {void this.changed(document.uri);}
            }),
            vscode.workspace.onDidDeleteFiles(event => { for (const uri of event.files) {void this.changed(uri, undefined, true);} }),
            vscode.workspace.onDidRenameFiles(event => { for (const file of event.files) { void this.changed(file.oldUri, undefined, true); void this.changed(file.newUri, undefined, true); } }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('testy')) {return;}
                try {
                    this.config = configuration();
                    this.scheduler.setDebounce(this.config.debounce);
                    this.scheduler.setPaused(!this.config.enabled);
                    this.watch(); this.queueDecorations(vscode.window.visibleTextEditors);
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
            groups: this.engine.displayGroups, baseline: this.engine.baselineProgress, coverage: this.engine.coverage.summarize(this.engine.hashes),
            status: this.status.text, outcomes: Object.fromEntries(this.outcomes)
        };
    }

    private watch(): void {
        // Saves need no filesystem plan, regardless of workspace size.
        const signature = JSON.stringify([this.config.trigger, this.config.pattern, this.roots, this.engine.inputVersion]);
        if (signature === this.watchSignature) {return;}
        this.watchSignature = signature;
        this.watchers.forEach(watcher => watcher.dispose()); this.watchers = [];
        if (this.config.trigger !== 'fileSystem') {return;}
        const inputs = this.engine.knownFiles, directories = this.engine.directories;
        const external: string[] = [];
        for (const directory of sourceDirectories(inputs, directories).filter(directory => !this.roots.some(root => isInside(directory, root)))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))) {
            if (!external.some(parent => isInside(directory, parent))) {external.push(directory);}
        }
        const inputDirectories = [...new Set(inputs.filter(file => !matchesPattern(file, this.config.pattern, this.roots)
            || (isInheritedConfiguration(file) && !this.roots.some(root => isInside(file, root)))).map(file => path.dirname(file)))];
        for (const pattern of [this.config.pattern, ...external.map(directory => new vscode.RelativePattern(directory, this.config.pattern)),
            ...inputDirectories.map(directory => new vscode.RelativePattern(directory, '*'))]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(uri => {void this.changed(uri);});
            watcher.onDidCreate(uri => {void this.changed(uri, undefined, true);});
            watcher.onDidDelete(uri => {void this.changed(uri, undefined, true);});
            this.watchers.push(watcher);
        }
    }

    private async changed(uri: vscode.Uri, content?: string | Buffer, directoryEvent = false): Promise<void> {
        if (this.disposed || uri.scheme !== 'file') {return;}
        const file = normalizePath(uri.fsPath);
        if (!this.roots.some(root => isInside(file, root)) && !this.engine.knownFiles.includes(file)
            && !this.engine.knownFiles.some(known => isInside(known, file))
            && !sourceDirectories(this.engine.knownFiles, this.engine.directories).some(directory => isInside(file, directory))) {return;}
        if (isExcluded(file, this.config.excludes, this.roots)) {return;}
        const descendants = directoryEvent ? this.engine.knownFiles.filter(known => known !== file && isInside(known, file)) : [];
        let directory = descendants.length > 0;
        if (directoryEvent && !directory) {try {directory = (await fs.stat(file)).isDirectory();} catch { /* Deleted path. */ }}
        if (directoryEvent && isExcluded(`${file}/`, this.config.excludes, this.roots)) {return;}
        if (!directory && !this.engine.knownFiles.includes(file) && !matchesPattern(file, this.config.pattern, this.roots)) {return;}
        if (!directory && /\.cs$/i.test(file)) {
            if (content === undefined) {
                let handle: fs.FileHandle | undefined;
                try {handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer); content = buffer.subarray(0, bytesRead);}
                catch { /* Deleted file. */ } finally {await handle?.close();}
            }
            if (content !== undefined) {
                const generated = isGeneratedSource(file, content);
                this.engine.sources?.observeGenerated(file, generated);
                if (generated) {return;}
            } else if (this.engine.sources?.isGenerated(file)) {return;}
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

    private async updateTree(groups: readonly TestFile[]): Promise<void> {
        if (this.disposed) {return;}
        this.productionSources = new Set(this.engine.projects.filter(project => !project.isTestProject).flatMap(project => [...project.sourceFiles]));
        this.watch();
        const projectCounts = new Map<string, number>(), live = new Set<string>();
        const projects = new Map<string, vscode.TestItem[]>();
        let work = 0;
        const ordered = [...groups].sort((a, b) => a.project.localeCompare(b.project) || (a.file ?? '').localeCompare(b.file ?? '') || a.framework.localeCompare(b.framework));
        for (const group of ordered) {
            if (++work % 512 === 0) {await yieldTurn(); if (this.disposed) {return;}}
            const tests = this.engine.knownTests(group), previous = this.treeFiles.get(group.id);
            projectCounts.set(group.project, (projectCounts.get(group.project) ?? 0) + tests.length);
            const projectId = `project:${group.project}`;
            this.item(projectId, path.basename(group.project, '.csproj'), group.project);
            live.add(group.id);
            const files = projects.get(projectId) ?? [];
            const file = this.item(`file:${group.id}`, `${path.basename(group.file ?? (group.runtimeOnly ? 'Unmapped runtime tests' : 'Other tests'))} · ${group.framework}`, group.file);
            files.push(file); projects.set(projectId, files);
            let same = !previous?.dirty && previous?.tests.length === tests.length;
            if (same && previous!.tests !== tests) {for (let index = 0; index < tests.length; index++) {
                const a = previous!.tests[index], b = tests[index];
                if (a.id !== b.id || a.name !== b.name || a.file !== b.file || a.line !== b.line) {same = false; break;}
                if (++work % 512 === 0) {await yieldTurn(); if (this.disposed) {return;}}
            }}
            if (same) {this.treeFiles.set(group.id, { tests, ids: previous!.ids }); continue;}
            const children: vscode.TestItem[] = [], ids = new Set<string>();
            for (const test of tests) {
                const id = `${group.id}:${test.id}`, item = this.item(id, test.name, test.file);
                item.range = test.file ? new vscode.Range(Math.max(0, test.line - 1), 0, Math.max(0, test.line - 1), 0) : undefined;
                ids.add(id); this.testIds.set(id, { group: group.id, test: test.id }); children.push(item);
                if (++work % 512 === 0) {await yieldTurn(); if (this.disposed) {return;}}
            }
            file.children.replace(children);
            for (const id of previous?.ids ?? []) {if (!ids.has(id)) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.disposed) {return;}}
            }}
            this.treeFiles.set(group.id, { tests, ids });
        }
        for (const [group, previous] of this.treeFiles) {if (!live.has(group)) {
            for (const id of previous.ids) {
                this.testIds.delete(id); this.items.delete(id); this.setOutcome(id);
                if (++work % 512 === 0) {await yieldTurn(); if (this.disposed) {return;}}
            }
            this.items.delete(`file:${group}`); this.treeFiles.delete(group);
        }}
        const sameIds = (previous: readonly string[] | undefined, next: readonly string[]): boolean => !!previous && previous.length === next.length && previous.every((id, index) => id === next[index]);
        for (const [id, files] of projects) {
            const project = this.items.get(id)!, ids = files.map(file => file.id);
            const description = `${projectCounts.get(id.slice('project:'.length))} tests`;
            if (project.description !== description) {project.description = description;}
            if (!sameIds(this.treeProjects.get(id), ids)) {project.children.replace(files); this.treeProjects.set(id, ids);}
        }
        for (const id of this.treeProjects.keys()) {if (!projects.has(id)) {this.treeProjects.delete(id); this.items.delete(id);}}
        const roots = [...projects.keys()];
        if (!sameIds(this.treeRoots, roots)) {this.controller.items.replace(roots.map(id => this.items.get(id)!)); this.treeRoots = roots;}
        this.updateStatus();
    }

    private item(id: string, label: string, file?: string): vscode.TestItem {
        const existing = this.items.get(id);
        if (existing && (existing.uri ? file !== undefined && path.normalize(existing.uri.fsPath) === path.normalize(file) : file === undefined)) {
            if (existing.label !== label) {existing.label = label;} return existing;
        }
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
        if (group.runtimeOnly && !this.treeFiles.has(group.id)) {
            const file = this.item(`file:${group.id}`, `Unmapped runtime tests · ${group.framework}`);
            this.items.get(`project:${group.project}`)?.children.add(file);
            this.treeFiles.set(group.id, { tests: [], ids: new Set(), dirty: true });
        }
        const id = `${group.id}:${result.id}`;
        this.testIds.set(id, { group: group.id, test: result.id });
        const file = this.treeFiles.get(group.id);
        if (file && !file.ids.has(id)) {file.ids.add(id); file.dirty = true;}
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
        if (this.rendering) {return;}
        this.renderTimer ??= setTimeout(() => {
            this.renderTimer = undefined;
            void this.renderDecorations();
        }, 50);
    }

    private async renderDecorations(): Promise<void> {
        this.rendering = true;
        try {
            while (!this.disposed && this.pendingEditors.size) {
                const pending = [...this.pendingEditors]; this.pendingEditors.clear();
                await this.decorate(pending);
            }
        } catch (error) {this.reportError(error);}
        finally {this.rendering = false;}
    }

    private async decorate(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): Promise<void> {
        if (this.disposed) {return;}
        let hashes: ReadonlyMap<string, string>;
        let summaries: readonly CoverageSummary[];
        do {
            hashes = this.engine.hashes;
            summaries = this.config.showCoverage ? await this.engine.coverage.summarizeAsync(hashes, this.lifetime.signal) : [];
        } while (!this.disposed && this.config.showCoverage && hashes !== this.engine.hashes);
        if (this.disposed) {return;}
        if (this.decorationIndex?.summaries !== summaries) {
            this.decorationIndex = { summaries, files: new Map(summaries.map(summary => [summary.file, summary])) };
        }
        const byFile = this.decorationIndex.files, rendered = this.decoratedEditors ??= new WeakMap();
        for (const editor of editors) {
            const document = editor.document;
            const summary = this.config.showCoverage ? byFile.get(normalizePath(document.uri.fsPath)) : undefined;
            const state: EditorCoverageState = { document, version: document.version, lineCount: document.lineCount, dirty: document.isDirty,
                show: this.config.showCoverage, lines: summary?.lines, stale: summary?.stale };
            const previous = rendered.get(editor);
            if (previous && previous.document === document && previous.version === state.version && previous.lineCount === state.lineCount
                && previous.dirty === state.dirty && previous.show === state.show && previous.lines === state.lines && previous.stale === state.stale) {continue;}
            const entries: Record<'covered' | 'uncovered' | 'stale', vscode.DecorationOptions[]> = { covered: [], uncovered: [], stale: [] };
            if (summary) {for (const line of summary.lines) {
                if (line.line > state.lineCount) {continue;}
                const stale = summary.stale || state.dirty;
                const kind = stale ? 'stale' : line.hits > 0 ? 'covered' : 'uncovered';
                entries[kind].push({
                    range: new vscode.Range(line.line - 1, 0, line.line - 1, 0),
                    hoverMessage: stale ? 'Testy: coverage is out of date. It will refresh after the affected tests finish.' : line.hits > 0 ? 'Testy: covered by tests.' : 'Testy: not covered by tests.'
                });
            }}
            // A partially failed submission must never make an older state look current.
            rendered.delete(editor);
            for (const kind of ['covered', 'uncovered', 'stale'] as const) {editor.setDecorations(this.decorations[kind], entries[kind]);}
            rendered.set(editor, state);
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
        if (this.pausedContext !== this.scheduler.isPaused) {
            this.pausedContext = this.scheduler.isPaused;
            void vscode.commands.executeCommand('setContext', 'testy.paused', this.pausedContext);
        }
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

    dispose(): Promise<void> {
        if (this.disposal) {return this.disposal;}
        this.lifetime.abort();
        this.disposed = true; this.scheduler.dispose(); this.watchers.forEach(watcher => watcher.dispose());
        this.disposal = this.engine.dispose();
        // Subscription disposal is synchronous; deactivate also awaits this work.
        void this.disposal.catch(error => console.error('Testy prepared-output cleanup failed.', error));
        if (this.renderTimer) {clearTimeout(this.renderTimer);} this.pendingEditors.clear();
        this.disposables.forEach(disposable => disposable.dispose());
        Object.values(this.decorations).forEach(decoration => decoration.dispose());
        this.activeRun?.end(); this.controller.dispose(); this.output.dispose(); this.status.dispose();
        return this.disposal;
    }
}
