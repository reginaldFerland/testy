import * as vscode from 'vscode';
import type { LineMap } from '../core/lineMap';
import { ExceptionSite, ExceptionSites, exceptionSites } from '../core/exceptionSites';
import { TestResult } from '../core/model';
import { isInside, normalizePathAsync } from '../core/paths';
import { mapDeterministicPath, parseStackTrace } from '../core/stackTrace';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;
/** Longest marker text before it is cut. */
const maxText = 100;

/** What exception markers need from the extension that owns them. */
export interface ExceptionMarkersHost {
    readonly disposed: boolean;
    readonly roots: readonly string[];
    /** Whether markers are drawn (`testy.inlineResults` is not `off`). */
    readonly enabled: boolean;
    /** Current content versions by normalized path. */
    readonly hashes: ReadonlyMap<string, string>;
    /** Known source files by lowercase file name, for deterministic `/_/` stack paths. */
    named(name: string): readonly string[];
    reportError(error: unknown): void;
    /** How an unsaved document's edits moved its saved lines, when they were all followed (see InlineResults.track). */
    lineMap?(document: vscode.TextDocument): LineMap | undefined;
}

const csharp = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file' && document.languageId === 'csharp';
const cut = (text: string): string => text.length > maxText ? `${text.slice(0, maxText - 1)}…` : text;

/**
 * NCrunch-style exception markers: every workspace line on the stack of a failing test is marked at the end of the line and in
 * the scroll bar, and its hover shows the failure. The innermost workspace frame is where the test threw; the others are its
 * callers. A line's marker disappears when its tests pass. While its file is unsaved, it follows the edits (and is hidden on a
 * line an edit touched); it is hidden when the file changed since the failure, since its line numbers may no longer match.
 */
export class ExceptionMarkers implements vscode.Disposable {
    readonly sites = new ExceptionSites();
    private decoration: vscode.TextEditorDecorationType | undefined;
    private timer: NodeJS.Timeout | undefined;
    private readonly pending = new Set<vscode.TextEditor>();
    /** The latest record per test; an older one finishing later is dropped. */
    private readonly sequence = new Map<string, number>();
    private next = 0;
    private readonly paths = new WeakMap<vscode.TextDocument, Promise<string>>();
    private readonly drawn = new WeakMap<vscode.TextEditor, string>();

    constructor(private readonly host: ExceptionMarkersHost) {}

    /** A test reported: a failure records where it threw; any other outcome clears its markers. */
    async record(test: string, label: string, result: TestResult): Promise<void> {
        const order = ++this.next; this.sequence.set(test, order);
        const failed = result.outcome === 'failed' || result.outcome === 'errored';
        const frames = failed ? parseStackTrace(result.stack) : [];
        const resolved = new Map<string, string | undefined>();
        await Promise.all([...new Set(frames.flatMap(frame => frame.file ? [frame.file] : []))].map(async file => {
            const mapped = mapDeterministicPath(file, name => this.host.named(name)) ?? file;
            const normalized = await normalizePathAsync(mapped).catch(() => undefined);
            resolved.set(file, normalized && this.host.roots.some(root => isInside(normalized, root)) ? normalized : undefined);
        }));
        if (this.host.disposed || this.sequence.get(test) !== order) {return;}
        this.sequence.delete(test);
        const revision = this.sites.revision;
        this.sites.set(test, exceptionSites(test, label, result.message, frames, file => resolved.get(file), file => this.host.hashes.get(file)));
        if (this.sites.revision !== revision) {this.refresh();}
    }

    /** Redraw the visible editors. */
    refresh(): void { this.queue(vscode.window.visibleTextEditors); }

    queue(editors: readonly vscode.TextEditor[]): void {
        if (this.host.disposed || (!this.sites.size && !this.decoration)) {return;}
        for (const editor of editors) {this.pending.add(editor);}
        this.timer ??= setTimeout(() => {
            this.timer = undefined;
            const pending = [...this.pending]; this.pending.clear();
            void this.render(pending).catch((error: unknown) => this.host.reportError(error));
        }, 100);
    }

    private path(document: vscode.TextDocument): Promise<string> {
        let file = this.paths.get(document);
        if (!file) {file = normalizePathAsync(document.uri.fsPath); this.paths.set(document, file);}
        return file;
    }

    private async render(editors: readonly vscode.TextEditor[]): Promise<void> {
        const files = await Promise.all(editors.map(editor => csharp(editor.document) ? this.path(editor.document) : Promise.resolve(undefined)));
        if (this.host.disposed) {return;}
        for (const [index, editor] of editors.entries()) {
            const document = editor.document, file = files[index];
            // An unsaved document shows its markers where its edits moved their lines, and hides those on lines an edit touched.
            const map = this.host.lineMap?.(document);
            const lines = file !== undefined && this.host.enabled && (!document.isDirty || map) ? this.sites.forFile(file) : new Map<number, ExceptionSite[]>();
            const current = [...lines].flatMap(([line, sites]): [number, ExceptionSite[]][] => {
                const moved = map ? map.map(line - 1) : line - 1;
                return moved !== undefined && moved < document.lineCount && sites.some(site => site.version === undefined || site.version === this.host.hashes.get(site.file)) ? [[moved + 1, sites]] : [];
            });
            const key = `${this.sites.revision}:${document.version}:${map?.version ?? ''}:${current.map(([line]) => line).join(',')}`;
            if (this.drawn.get(editor) === key || (!current.length && !this.drawn.has(editor))) {continue;}
            const decoration = this.decoration ??= vscode.window.createTextEditorDecorationType({
                after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('testing.message.error.decorationForeground') },
                overviewRulerColor: new vscode.ThemeColor('testing.iconFailed'), overviewRulerLane: vscode.OverviewRulerLane.Right
            });
            editor.setDecorations(decoration, current.map(([line, sites]) => {
                const end = document.lineAt(line - 1).range.end;
                return { range: new vscode.Range(end, end), hoverMessage: hover(sites), renderOptions: { after: { contentText: summary(sites) } } };
            }));
            if (current.length) {this.drawn.set(editor, key);} else {this.drawn.delete(editor);}
        }
    }

    dispose(): void {
        if (this.timer) {clearTimeout(this.timer);} this.pending.clear();
        this.decoration?.dispose();
    }
}

/** `✗ thrown here · Divides_by_zero: Attempted to divide by zero.`, or a count when several tests failed through the line. */
function summary(sites: readonly ExceptionSite[]): string {
    const tests = new Set(sites.map(site => site.test)), first = sites[0]!;
    if (tests.size > 1) {return cut(`✗ ${l10n.t('{0} failing tests pass through here', tests.size)}`);}
    const where = first.depth === 0 ? l10n.t('thrown here') : l10n.t('on the stack');
    return cut(`✗ ${where} · ${first.label}${first.message ? `: ${first.message}` : ''}`);
}

function hover(sites: readonly ExceptionSite[]): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: ['testy.showTest'] };
    const escape = (text: string): string => text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, match => `\\${match}`);
    markdown.appendMarkdown(`**Testy** · ${escape(l10n.t('Failing tests through this line'))}\n\n`);
    const seen = new Set<string>();
    for (const site of sites) {
        if (seen.has(site.test)) {continue;}
        seen.add(site.test);
        const link = `command:testy.showTest?${encodeURIComponent(JSON.stringify([site.test]))}`;
        const where = site.depth === 0 ? l10n.t('threw here') : l10n.t('called through here');
        markdown.appendMarkdown(`- $(error) [${escape(site.label)}](${link} "${escape(l10n.t('Show in Test Explorer'))}") ${escape(where)}`);
        markdown.appendMarkdown(site.message ? `: ${escape(site.message)}\n` : '\n');
    }
    return markdown;
}
