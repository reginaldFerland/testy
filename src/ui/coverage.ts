import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { Configuration } from '../configuration';
import { CoverageSummary, declarationHits } from '../core/coverage';
import { normalizePath } from '../core/paths';
import { TestEngine } from '../services/engine';

const l10n = vscode.l10n;

type DecorationKind = 'covered' | 'uncovered' | 'stale';

interface EditorCoverageState {
    readonly document: vscode.TextDocument;
    readonly version: number;
    readonly lineCount: number;
    readonly dirty: boolean;
    readonly show: boolean;
    readonly lines: CoverageSummary['lines'] | undefined;
    readonly stale: boolean | undefined;
}

/** What the coverage view needs from the extension that owns it. */
export interface CoverageHost {
    readonly disposed: boolean;
    readonly activeRun: vscode.TestRun | undefined;
    readonly config: Configuration;
    /** Aborted on disposal; cancels pending summary work. */
    readonly lifetime: AbortController;
    updateStatus(): void;
    reportError(error: unknown): void;
}

/** Publishes coverage to Test Explorer's native view and, optionally, to editor gutters. */
export class CoverageView {
    /** Coverage contribution IDs (test files and project aggregates) to their tree items. */
    owners: ReadonlyMap<string, string> = new Map();
    /** Production sources whose coverage counts toward the status bar percentage. */
    productionSources = new Set<string>();
    /** The status bar's coverage percentage, or nothing while coverage is hidden. */
    suffix = '';
    hidden = false;
    private readonly details = new WeakMap<vscode.FileCoverage, CoverageSummary>();
    private readonly publishedCoverage = new Map<string, CoverageSummary>();
    private nativePublished = false;
    private readonly decorations: Record<DecorationKind, vscode.TextEditorDecorationType>;
    private renderTimer: NodeJS.Timeout | undefined;
    private rendering = false;
    private readonly pendingEditors = new Set<vscode.TextEditor>();
    private decoratedEditors?: WeakMap<vscode.TextEditor, EditorCoverageState>;
    private decorationIndex?: { readonly summaries: readonly CoverageSummary[]; readonly files: ReadonlyMap<string, CoverageSummary> };

    constructor(extensionUri: vscode.Uri, private readonly controller: vscode.TestController, private readonly profile: vscode.TestRunProfile,
        private readonly engine: TestEngine, private readonly items: ReadonlyMap<string, vscode.TestItem>, private readonly host: CoverageHost) {
        // Distinct shapes per state; colours per theme kind (high contrast themes use the matching variant).
        const icon = (kind: string, theme: string): vscode.Uri => vscode.Uri.joinPath(extensionUri, 'media', `${kind}-${theme}.svg`);
        this.decorations = Object.fromEntries(['covered', 'uncovered', 'stale'].map(kind => [kind, vscode.window.createTextEditorDecorationType({
            gutterIconSize: 'contain', light: { gutterIconPath: icon(kind, 'light') }, dark: { gutterIconPath: icon(kind, 'dark') }
        })])) as typeof this.decorations;
        this.bind(profile);
    }

    /** Load per-line and per-test detail for coverage published through this profile. */
    bind(profile: vscode.TestRunProfile): void {
        profile.loadDetailedCoverage = async (_run, coverage, token) => {
            const summary = this.details.get(coverage);
            return summary ? this.detail(summary, summary.lines, token) : [];
        };
        profile.loadDetailedCoverageForTest = async (_run, coverage, item, token) => {
            const summary = this.details.get(coverage);
            if (!summary) {return [];}
            const owners = new Set(summary.groupIds.filter(id => this.owners.get(id) === item.id));
            const lines = this.engine.coverage.contribution(summary.file, owners, this.engine.hashes);
            return lines ? this.detail(summary, lines, token) : [];
        };
    }

    /** A new run republishes every file's coverage and shows it again. */
    beginRun(): void { this.publishedCoverage.clear(); this.hidden = false; }

    hide(): void { this.hidden = true; this.suffix = ''; this.queue(vscode.window.visibleTextEditors); }

    /** Statements span each line's code from its first non-blank character; declarations span their methods.
     * An open editor's text wins over the disk copy, so ranges fit what is shown; lines past its end are dropped. */
    private async detail(summary: CoverageSummary, lines: CoverageSummary['lines'], token?: vscode.CancellationToken): Promise<vscode.FileCoverageDetail[]> {
        const open = vscode.workspace.textDocuments.find(document => document.uri.scheme === 'file' && normalizePath(document.uri.fsPath) === summary.file);
        let text: string[] | undefined = open?.getText().split(/\r?\n/);
        if (!text) {try {text = (await fs.readFile(summary.file, 'utf8')).split(/\r?\n/);} catch { /* Deleted file: fall back to line starts. */ }}
        if (token?.isCancellationRequested) {return [];}
        const source = (line: number): string => text?.[line - 1] ?? '', exists = (line: number): boolean => !open || line <= open.lineCount;
        const statements: vscode.FileCoverageDetail[] = lines.filter(line => exists(line.line)).map(line => {
            const code = source(line.line), first = code.search(/\S/);
            const range = first < 0 ? new vscode.Position(line.line - 1, 0) : new vscode.Range(line.line - 1, first, line.line - 1, code.trimEnd().length);
            return new vscode.StatementCoverage(line.hits, range);
        });
        const declarations = declarationHits(lines, summary.declarations ?? []).filter(({ declaration }) => exists(declaration.start))
            .map(({ declaration, hits }) => {
                const end = open ? Math.min(declaration.end, open.lineCount) : declaration.end, first = Math.max(0, source(declaration.start).search(/\S/));
                return new vscode.DeclarationCoverage(declaration.name, hits, new vscode.Range(declaration.start - 1, first, end - 1, source(end).trimEnd().length));
            });
        return [...statements, ...declarations];
    }

    publish(): void {
        if (this.host.disposed) {return;}
        let total = 0, covered = 0;
        const summaries = this.engine.coverage.summarize(this.engine.hashes);
        // Coverage restored or refreshed outside a run reaches the native view once,
        // through a run of its own; afterwards each run publishes its current coverage.
        const passive = !this.host.activeRun && !this.nativePublished && !this.hidden && summaries.some(summary => !summary.stale)
            ? this.controller.createTestRun(new vscode.TestRunRequest(undefined, undefined, this.profile), l10n.t('Testy · retained coverage'), false) : undefined;
        const run = this.host.activeRun ?? passive;
        for (const summary of summaries) {
            if (summary.stale) {continue;}
            if (this.productionSources.has(summary.file)) {total += summary.total; covered += summary.covered;}
            if (!run) {continue;}
            const previous = this.publishedCoverage.get(summary.file);
            if (previous?.lines === summary.lines && previous.declarations === summary.declarations
                && previous.covered === summary.covered && previous.total === summary.total) {continue;}
            const owners = [...new Set(summary.groupIds.map(id => this.owners.get(id)))].map(id => id ? this.items.get(id) : undefined)
                .filter((item): item is vscode.TestItem => !!item);
            const methods = summary.declarations ? declarationHits(summary.lines, summary.declarations) : [];
            const coverage = new vscode.FileCoverage(vscode.Uri.file(summary.file), { covered: summary.covered, total: summary.total }, undefined,
                methods.length ? { covered: methods.filter(method => method.hits > 0).length, total: methods.length } : undefined, owners.length ? owners : undefined);
            this.details.set(coverage, summary); this.publishedCoverage.set(summary.file, summary); run.addCoverage(coverage);
            this.nativePublished = true;
        }
        passive?.end();
        this.suffix = total && !this.hidden ? ` · ${Math.round(covered / total * 100)}%` : '';
        this.queue(vscode.window.visibleTextEditors); this.host.updateStatus();
    }

    queue(editors: readonly vscode.TextEditor[]): void {
        if (this.host.disposed) {return;}
        editors.forEach(editor => this.pendingEditors.add(editor));
        if (this.rendering) {return;}
        this.renderTimer ??= setTimeout(() => {
            this.renderTimer = undefined;
            void this.render().catch((error: unknown) => this.host.reportError(error));
        }, 50);
    }

    private async render(): Promise<void> {
        this.rendering = true;
        try {
            while (!this.host.disposed && this.pendingEditors.size) {
                const pending = [...this.pendingEditors]; this.pendingEditors.clear();
                await this.decorate(pending);
            }
        } catch (error) {this.host.reportError(error);}
        finally {this.rendering = false;}
    }

    /** Optional gutter markers; Test Explorer's native coverage view is the primary display. */
    async decorate(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): Promise<void> {
        const { host } = this;
        if (host.disposed) {return;}
        // Read the state again after each await: it can change while summaries are prepared.
        const disposed = (): boolean => host.disposed, visible = (): boolean => host.config.showCoverage && !this.hidden;
        let hashes: ReadonlyMap<string, string>;
        let summaries: readonly CoverageSummary[];
        do {
            hashes = this.engine.hashes;
            summaries = visible() ? await this.engine.coverage.summarizeAsync(hashes, host.lifetime.signal) : [];
        } while (!disposed() && visible() && hashes !== this.engine.hashes);
        if (disposed()) {return;}
        if (this.decorationIndex?.summaries !== summaries) {
            this.decorationIndex = { summaries, files: new Map(summaries.map(summary => [summary.file, summary])) };
        }
        const byFile = this.decorationIndex.files, rendered = this.decoratedEditors ??= new WeakMap();
        for (const editor of editors) {
            const document = editor.document, show = visible();
            const summary = show ? byFile.get(normalizePath(document.uri.fsPath)) : undefined;
            const state: EditorCoverageState = { document, version: document.version, lineCount: document.lineCount, dirty: document.isDirty,
                show, lines: summary?.lines, stale: summary?.stale };
            const previous = rendered.get(editor);
            if (previous && previous.document === document && previous.version === state.version && previous.lineCount === state.lineCount
                && previous.dirty === state.dirty && previous.show === state.show && previous.lines === state.lines && previous.stale === state.stale) {continue;}
            const entries: Record<DecorationKind, vscode.DecorationOptions[]> = { covered: [], uncovered: [], stale: [] };
            if (summary) {
                const hovers = {
                    stale: l10n.t('Testy: coverage is out of date. It will refresh after the affected tests finish.'),
                    covered: l10n.t('Testy: covered by tests.'), uncovered: l10n.t('Testy: not covered by tests.')
                };
                for (const line of summary.lines) {
                    if (line.line > state.lineCount) {continue;}
                    const stale = summary.stale || state.dirty;
                    const kind = stale ? 'stale' : line.hits > 0 ? 'covered' : 'uncovered';
                    entries[kind].push({ range: new vscode.Range(line.line - 1, 0, line.line - 1, 0), hoverMessage: hovers[kind] });
                }
            }
            // A partially failed submission must never make an older state look current.
            rendered.delete(editor);
            for (const kind of ['covered', 'uncovered', 'stale'] as const) {editor.setDecorations(this.decorations[kind], entries[kind]);}
            rendered.set(editor, state);
        }
    }

    dispose(): void {
        if (this.renderTimer) {clearTimeout(this.renderTimer);} this.pendingEditors.clear();
        Object.values(this.decorations).forEach(decoration => {decoration.dispose();});
    }
}
