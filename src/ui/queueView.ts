import * as vscode from 'vscode';
import { QueueEntry } from '../core/queue';
import { describeCause } from './selectionCause';

// Call sites use l10n.t(...) literally so `npm run l10n:export` can extract them.
const l10n = vscode.l10n;

const icons: Record<QueueEntry['state'], [string, string | undefined]> = {
    queued: ['circle-outline', undefined], running: ['loading~spin', 'testing.iconQueued'], passed: ['pass', 'testing.iconPassed'],
    failed: ['error', 'testing.iconFailed'], stopped: ['circle-slash', 'testing.iconSkipped']
};

/** A short description of an entry: its state, and its time (expected while queued, so far while running, taken once done). */
export function describeEntry(entry: QueueEntry, now: number): string {
    const seconds = (milliseconds: number): string => l10n.t('{0}s', (milliseconds / 1000).toFixed(1));
    const part = entry.part ? ` · ${l10n.t('part {0} of {1}', entry.part.index, entry.part.count)}` : '';
    switch (entry.state) {
        case 'queued': return `${l10n.t('queued')}${entry.expected === undefined ? '' : ` · ${l10n.t('about {0}', seconds(entry.expected))}`}${part}`;
        case 'running': return `${l10n.t('running')} ${seconds(now - (entry.started ?? now))}${entry.expected === undefined ? '' : ` / ${seconds(entry.expected)}`}${part}`;
        case 'passed': return `${l10n.t('passed')} ${seconds(entry.elapsed ?? 0)}${part}`;
        case 'failed': return `${entry.failed ? l10n.t('{0} failed', entry.failed) : l10n.t('could not run')} · ${seconds(entry.elapsed ?? 0)}${part}`;
        case 'stopped': return `${l10n.t('stopped')}${part}`;
    }
}

/** NCrunch's processing queue for Testy: the test batches of the current or latest run, running ones first, then queued ones in
 * the order they may start, then finished ones; each says why it was selected. Choosing one shows its file in Test Explorer. */
export class QueueView implements vscode.TreeDataProvider<QueueEntry>, vscode.Disposable {
    private entries: readonly QueueEntry[] = [];
    private readonly changed = new vscode.EventEmitter<QueueEntry | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private timer: NodeJS.Timeout | undefined;
    private ticker: NodeJS.Timeout | undefined;

    constructor(private readonly now: () => number = Date.now) {}

    /** The batches of the testing run changed; redrawn at most every 200 ms, and every second while one runs. */
    update(entries: readonly QueueEntry[]): void {
        this.entries = entries;
        this.timer ??= setTimeout(() => {this.timer = undefined; this.changed.fire(undefined);}, 200);
        const running = entries.some(entry => entry.state === 'running');
        if (running && !this.ticker) {this.ticker = setInterval(() => this.changed.fire(undefined), 1000);}
        else if (!running && this.ticker) {clearInterval(this.ticker); this.ticker = undefined;}
    }

    getChildren(element?: QueueEntry): QueueEntry[] {
        if (element) {return [];}
        const order: Record<QueueEntry['state'], number> = { running: 0, queued: 1, failed: 2, passed: 3, stopped: 4 };
        return this.entries.map((entry, index) => ({ entry, index })).sort((a, b) => order[a.entry.state] - order[b.entry.state] || a.index - b.index).map(item => item.entry);
    }

    getTreeItem(entry: QueueEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);
        item.description = describeEntry(entry, this.now());
        const [icon, colour] = icons[entry.state];
        item.iconPath = new vscode.ThemeIcon(icon, colour ? new vscode.ThemeColor(colour) : undefined);
        item.tooltip = [l10n.t('{0} tests', entry.tests), entry.cause ? describeCause(entry.cause) : undefined].filter(Boolean).join(' · ');
        item.command = { command: 'testy.showTest', title: l10n.t('Show in Test Explorer'), arguments: [`file:${entry.id}`] };
        return item;
    }

    dispose(): void { if (this.timer) {clearTimeout(this.timer);} if (this.ticker) {clearInterval(this.ticker);} this.changed.dispose(); }
}
