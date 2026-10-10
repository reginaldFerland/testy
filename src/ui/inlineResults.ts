import * as vscode from 'vscode';
import * as path from 'node:path';
import { Configuration } from '../configuration';
import { CoverageSummary } from '../core/coverage';
import { TestFile } from '../core/model';
import { normalizePathAsync } from '../core/paths';
import { TestEngine } from '../services/engine';
import { CoverageView } from './coverage';
import { fileStatus, inlineGutter, LineStatus, lineStatuses, orderByStatus, summarizeLine } from './inlineStatus';
import { TestTree } from './testTree';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;
const statuses: readonly LineStatus[] = ['passed', 'failed', 'pending'];
/** Test files listed in a hover before the rest are counted. */
const hoverFiles = 10;
/** Failing tests named per test file in a hover. */
const hoverTests = 3;

/** What inline results need from the extension that owns them. */
export interface InlineResultsHost {
    readonly disposed: boolean;
    readonly config: Configuration;
    /** Aborted on disposal; cancels pending summary work. */
    readonly lifetime: AbortController;
    reportError(error: unknown): void;
}

/** Retained coverage and test outcomes as of one revision; test file statuses are filled in as lines need them. */
interface Snapshot {
    readonly summaries: readonly CoverageSummary[];
    readonly coverageRevision: number;
    readonly outcomeRevision: number;
    readonly files: ReadonlyMap<string, CoverageSummary>;
    readonly statuses: Map<string, LineStatus>;
}

interface EditorState {
    readonly document: vscode.TextDocument;
    readonly version: number;
    readonly lineCount: number;
    readonly dirty: boolean;
    readonly summary: CoverageSummary | undefined;
    readonly snapshot: Snapshot | undefined;
    readonly lines: Record<LineStatus, number[]>;
}

const empty = (): Record<LineStatus, number[]> => ({ passed: [], failed: [], pending: [] });
const sameLines = (a: Record<LineStatus, number[]>, b: Record<LineStatus, number[]>): boolean =>
    statuses.every(status => a[status].length === b[status].length && a[status].every((line, index) => line === b[status][index]));
const csharp = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file' && document.languageId === 'csharp';

/**
 * Wallaby-style inline results: a covered line of a C# source shows whether the test files whose retained coverage hits it
 * passed, failed, or have not run since a change, in the gutter and (optionally) in a hover. Only visible editors are drawn,
 * after a short debounce, and an editor is redrawn only when its document, coverage or the outcomes change.
 * While inline gutter markers are on, `testy.showCoverage` leaves covered lines to them and marks only uncovered and stale lines.
 */
export class InlineResults implements vscode.Disposable {
    /** Created on first use, so nothing is allocated while inline results are off. */
    private decorations: Record<LineStatus, vscode.TextEditorDecorationType> | undefined;
    private hover: vscode.Disposable | undefined;
    private timer: NodeJS.Timeout | undefined;
    private rendering = false;
    private readonly pending = new Set<vscode.TextEditor>();
    private rendered = new WeakMap<vscode.TextEditor, EditorState>();
    /** Whether markers may be on screen; while false and markers are off, there is nothing to update or clear. */
    private drawn = false;
    private snapshot: Snapshot | undefined;
    private readonly paths = new WeakMap<vscode.TextDocument, Promise<string>>();

    constructor(private readonly extensionUri: vscode.Uri, private readonly engine: TestEngine, private readonly coverage: CoverageView,
        private readonly tree: TestTree, private readonly host: InlineResultsHost) {
        this.syncHover();
    }

    private get gutter(): boolean { return inlineGutter(this.host.config.inlineResults) && !this.coverage.hidden; }

    /** Distinct shapes per status; colours per theme kind (high contrast themes use the matching variant). */
    private get types(): Record<LineStatus, vscode.TextEditorDecorationType> {
        const icon = (kind: string, theme: string): vscode.Uri => vscode.Uri.joinPath(this.extensionUri, 'media', `${kind}-${theme}.svg`);
        return this.decorations ??= Object.fromEntries(statuses.map(status => [status, vscode.window.createTextEditorDecorationType({
            gutterIconSize: 'contain', light: { gutterIconPath: icon(status, 'light') }, dark: { gutterIconPath: icon(status, 'dark') },
            // Failing lines are also marked in the scroll bar, in the theme's own failure colour.
            ...status === 'failed' ? { overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'), overviewRulerLane: vscode.OverviewRulerLane.Left } : {}
        })])) as Record<LineStatus, vscode.TextEditorDecorationType>;
    }

    /** The hover provider exists only while `testy.inlineResults` asks for hovers. */
    private syncHover(): void {
        const wanted = this.host.config.inlineResults === 'gutterAndHover';
        if (wanted && !this.hover) {
            this.hover = vscode.languages.registerHoverProvider({ scheme: 'file', language: 'csharp' }, { provideHover: (document, position, token) => this.provideHover(document, position, token) });
        } else if (!wanted && this.hover) {this.hover.dispose(); this.hover = undefined;}
    }

    /** Redraw the visible editors, for example after results, coverage or settings changed. */
    refresh(): void { this.syncHover(); this.queue(vscode.window.visibleTextEditors); }

    queue(editors: readonly vscode.TextEditor[]): void {
        if (this.host.disposed || (!this.drawn && !this.gutter)) {return;}
        for (const editor of editors) {this.pending.add(editor);}
        if (this.rendering) {return;}
        this.timer ??= setTimeout(() => {
            this.timer = undefined;
            void this.render().catch((error: unknown) => this.host.reportError(error));
        }, 100);
    }

    private async render(): Promise<void> {
        this.rendering = true;
        try {
            while (!this.host.disposed && this.pending.size) {
                const editors = [...this.pending]; this.pending.clear();
                await this.decorate(editors);
            }
        } finally {this.rendering = false;}
    }

    private path(document: vscode.TextDocument): Promise<string> {
        let file = this.paths.get(document);
        if (!file) {file = normalizePathAsync(document.uri.fsPath); this.paths.set(document, file);}
        return file;
    }

    /** The current coverage and outcomes; reused while neither changed. */
    private async current(): Promise<Snapshot | undefined> {
        let hashes: ReadonlyMap<string, string>, summaries: readonly CoverageSummary[];
        do {
            hashes = this.engine.hashes;
            summaries = await this.engine.coverage.summarizeAsync(hashes, this.host.lifetime.signal);
        } while (!this.host.disposed && hashes !== this.engine.hashes);
        if (this.host.disposed) {return undefined;}
        const coverageRevision = this.engine.coverage.revision, outcomeRevision = this.tree.outcomeRevision, previous = this.snapshot;
        if (previous?.summaries === summaries && previous.coverageRevision === coverageRevision && previous.outcomeRevision === outcomeRevision) {return previous;}
        const files = previous?.summaries === summaries ? previous.files : new Map(summaries.map(summary => [summary.file, summary]));
        return this.snapshot = { summaries, coverageRevision, outcomeRevision, files, statuses: new Map() };
    }

    private statusOf(snapshot: Snapshot, group: string): LineStatus {
        let status = snapshot.statuses.get(group);
        if (!status) {
            status = fileStatus(this.tree.fileOutcomes.get(group), this.engine.coverage.traces.get(group)?.stale === true);
            snapshot.statuses.set(group, status);
        }
        return status;
    }

    /** An unsaved document, or coverage of another version of the file that no stale test file explains, has no current results. */
    private unverified(summary: CoverageSummary, document: vscode.TextDocument): boolean {
        return document.isDirty || (summary.stale && !summary.groupIds.some(id => this.engine.coverage.traces.get(id)?.stale));
    }

    private async decorate(editors: readonly vscode.TextEditor[]): Promise<void> {
        const show = this.gutter, sources = editors.filter(editor => csharp(editor.document));
        const snapshot = show && sources.length ? await this.current() : undefined;
        const files = await Promise.all(editors.map(editor => snapshot && csharp(editor.document) ? this.path(editor.document) : Promise.resolve(undefined)));
        if (this.host.disposed) {return;}
        // Settings can change while coverage is read.
        const visible = show && this.gutter;
        for (const [index, editor] of editors.entries()) {
            const document = editor.document, file = files[index];
            const summary = visible && snapshot && file !== undefined ? snapshot.files.get(file) : undefined;
            const previous = this.rendered.get(editor);
            const unchanged = previous?.document === document && previous.summary === summary && previous.snapshot === snapshot && previous.dirty === document.isDirty
                && previous.lineCount === document.lineCount && (previous.version === document.version || document.isDirty || !summary);
            if (unchanged) {continue;}
            const lines = summary && snapshot ? lineStatuses(this.coverage.coveringOf(summary), group => this.statusOf(snapshot, group),
                { pending: this.unverified(summary, document), lineCount: document.lineCount }) : empty();
            const state: EditorState = { document, version: document.version, lineCount: document.lineCount, dirty: document.isDirty, summary, snapshot, lines };
            if (sameLines(previous?.lines ?? empty(), lines)) {this.rendered.set(editor, state); continue;}
            // A partially failed submission must never make an older state look current.
            this.rendered.delete(editor);
            const types = this.types;
            for (const status of statuses) {editor.setDecorations(types[status], lines[status].map(line => new vscode.Range(line, 0, line, 0)));}
            this.rendered.set(editor, state);
            if (statuses.some(status => lines[status].length)) {this.drawn = true;}
        }
        if (!visible) {this.drawn = false;}
    }

    /** "Covered by N test files (X failing)", the files with their status, and command links to run or show them. */
    async provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        if (this.host.disposed || this.host.config.inlineResults !== 'gutterAndHover' || this.coverage.hidden || !csharp(document)) {return undefined;}
        const [file, snapshot] = await Promise.all([this.path(document), this.current()]);
        const summary = snapshot?.files.get(file);
        if (!snapshot || !summary || token?.isCancellationRequested) {return undefined;}
        const groups = this.coverage.coveringOf(summary).get(position.line + 1);
        if (!groups?.length || position.line >= document.lineCount) {return undefined;}
        const unverified = this.unverified(summary, document);
        const statusOf = (group: string): LineStatus => unverified ? 'pending' : this.statusOf(snapshot, group);
        const { files, failing, pending } = summarizeLine(groups, statusOf);
        const known = new Map<string, TestFile>(this.engine.displayGroups.map(group => [group.id, group]));
        const command = (id: string, args: unknown[]): string => `command:${id}?${encodeURIComponent(JSON.stringify(args))}`;
        const escape = (text: string): string => text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, match => `\\${match}`);
        const icons: Record<LineStatus, string> = { passed: '$(pass)', failed: '$(error)', pending: '$(circle-outline)' };
        const labels: Record<LineStatus, string> = { passed: l10n.t('passed'), failed: l10n.t('failed'), pending: l10n.t('not run since a change') };
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.isTrusted = { enabledCommands: ['testy.runCoveringTests', 'testy.showTest'] };
        markdown.appendMarkdown(`**Testy** · ${escape(failing ? l10n.t('Covered by {0} test files ({1} failing)', files, failing) : l10n.t('Covered by {0} test files', files))}`);
        if (pending) {markdown.appendMarkdown(` · ${escape(l10n.t('{0} not run since a change', pending))}`);}
        markdown.appendMarkdown('\n\n');
        const ordered = orderByStatus(groups, statusOf);
        for (const id of ordered.slice(0, hoverFiles)) {
            const group = known.get(id), status = statusOf(id);
            const name = group ? `${path.basename(group.file ?? group.project)} · ${group.framework}` : id;
            let entry = `- ${icons[status]} [${escape(name)}](${command('testy.showTest', [`file:${id}`])} "${escape(l10n.t('Show in Test Explorer'))}") · ${escape(labels[status])}`;
            if (status === 'failed') {
                const tests = this.tree.failingTests(id);
                const links = tests.slice(0, hoverTests).map(item => `[${escape(item.label)}](${command('testy.showTest', [item.id])})`);
                if (links.length) {entry += `: ${links.join(', ')}${tests.length > hoverTests ? ` ${escape(l10n.t('+{0} more', tests.length - hoverTests))}` : ''}`;}
            }
            markdown.appendMarkdown(`${entry}\n`);
        }
        if (ordered.length > hoverFiles) {markdown.appendMarkdown(`- ${escape(l10n.t('+{0} more', ordered.length - hoverFiles))}\n`);}
        markdown.appendMarkdown(`\n[$(play) ${escape(l10n.t('Run covering tests'))}](${command('testy.runCoveringTests', [document.uri.toString(), position.line + 1])})`);
        return new vscode.Hover(markdown, new vscode.Range(position.line, 0, position.line, document.lineAt(position.line).text.length));
    }

    dispose(): void {
        if (this.timer) {clearTimeout(this.timer);} this.pending.clear();
        this.hover?.dispose();
        for (const decoration of Object.values(this.decorations ?? {})) {decoration.dispose();}
    }
}
