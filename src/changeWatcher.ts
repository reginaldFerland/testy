import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { escape } from 'minimatch';
import type { Configuration } from './configuration';
import { InputIndex } from './core/inputIndex';
import { isExcluded, isGeneratedSource, isInheritedConfiguration, isInside, matchesPattern, normalizePathAsync } from './core/paths';
import type { Scheduler } from './core/scheduler';
import type { TestEngine } from './services/engine';

/** Most directories one merged watcher lists before it watches its whole base instead. */
const maxWatchedDirectories = 64;

/** What the watcher reads from the controller that owns it. */
export interface ChangeHost {
    readonly disposed: boolean;
    readonly config: Configuration;
    readonly roots: readonly string[];
    readonly engine: TestEngine;
    readonly scheduler: Scheduler;
    reportError(error: unknown, notify?: boolean): void;
}

/** Known inputs and their directories, rebuilt only when the engine's inputs change. */
function inputIndex(owner: { inputs?: InputIndex }, engine: ChangeHost['engine']): InputIndex {
    return (owner.inputs ??= new InputIndex(engine)).refresh();
}

/** Turns file-system and editor events into scheduler requests and engine version marks. */
export class ChangeWatcher {
    inputs?: InputIndex;
    private readonly changedFiles = new Set<string>();
    private changeTimer: NodeJS.Timeout | undefined;
    private changeChain: Promise<void> = Promise.resolve();
    private watchers: vscode.FileSystemWatcher[] = [];
    private watchSignature = '';

    constructor(private readonly host: ChangeHost) {}

    watch(): void {
        // Saves need no filesystem plan, regardless of workspace size.
        const signature = JSON.stringify([this.host.config.trigger, this.host.config.pattern, this.host.roots, this.host.engine.inputVersion]);
        if (signature === this.watchSignature) {return;}
        this.watchSignature = signature;
        this.watchers.forEach(watcher => {watcher.dispose();}); this.watchers = [];
        if (this.host.config.trigger !== 'fileSystem') {return;}
        const index = inputIndex(this, this.host.engine), inputs = index.files;
        const external: string[] = [];
        for (const directory of index.sourceDirectories.filter(directory => !this.host.roots.some(root => isInside(directory, root)))
            .sort((a, b) => a.length - b.length || a.localeCompare(b))) {
            if (!external.some(parent => isInside(directory, parent))) {external.push(directory);}
        }
        const inputDirectories = [...new Set(inputs.filter(file => !matchesPattern(file, this.host.config.pattern, this.host.roots)
            || (isInheritedConfiguration(file) && !this.host.roots.some(root => isInside(file, root)))).map(file => path.dirname(file)))];
        // One watcher per root: its input directories merge into a brace glob, and a root with too many falls back to everything
        // beneath it. A directory outside every root keeps its own non-recursive watcher; widening it to a parent could watch far more.
        const bases = new Map<string, string[] | undefined>();
        for (const directory of inputDirectories) {
            const root = this.host.roots.find(candidate => isInside(directory, candidate));
            const base = root ?? directory, name = root ? path.relative(root, directory).replace(/\\/g, '/') : '';
            const names = bases.get(base) ?? (bases.has(base) ? undefined : []);
            if (!names) {continue;}
            if (names.length >= maxWatchedDirectories) {bases.set(base, undefined);} else {names.push(name); bases.set(base, names);}
        }
        const merged = [...bases].map(([base, names]) => {
            if (!names) {return new vscode.RelativePattern(base, '**/*');}
            const globs = names.map(name => name ? `${escape(name, { windowsPathsNoEscape: true, magicalBraces: true })}/*` : '*');
            return new vscode.RelativePattern(base, globs.length === 1 ? globs[0]! : `{${globs.join(',')}}`);
        });
        for (const pattern of [this.host.config.pattern, ...external.map(directory => new vscode.RelativePattern(directory, this.host.config.pattern)), ...merged]) {
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(uri => {void this.changed(uri).catch((error: unknown) => this.host.reportError(error));});
            watcher.onDidCreate(uri => {void this.changed(uri, undefined, true).catch((error: unknown) => this.host.reportError(error));});
            watcher.onDidDelete(uri => {void this.changed(uri, undefined, true).catch((error: unknown) => this.host.reportError(error));});
            this.watchers.push(watcher);
        }
    }

    async changed(uri: vscode.Uri, content?: string | Buffer, directoryEvent = false): Promise<void> {
        if (this.host.disposed || uri.scheme !== 'file') {return;}
        // Build output (obj/, bin/) is rejected on the raw path, before any filesystem access.
        if (isExcluded(uri.fsPath, this.host.config.excludes, this.host.roots)) {return;}
        const file = await normalizePathAsync(uri.fsPath);
        // Disposal can happen during the await above.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.host.disposed) {return;}
        const index = inputIndex(this, this.host.engine);
        if (!this.host.roots.some(root => isInside(file, root)) && !index.has(file) && !index.descendants(file).length && !index.inSourceDirectory(file)) {return;}
        if (isExcluded(file, this.host.config.excludes, this.host.roots)) {return;}
        const descendants = directoryEvent ? index.descendants(file) : [];
        let directory = descendants.length > 0;
        if (directoryEvent && !directory) {try {directory = (await fs.stat(file)).isDirectory();} catch { /* Deleted path. */ }}
        if (directoryEvent && isExcluded(`${file}/`, this.host.config.excludes, this.host.roots)) {return;}
        if (!directory && !index.has(file) && !matchesPattern(file, this.host.config.pattern, this.host.roots)) {return;}
        if (!directory && /\.cs$/i.test(file)) {
            if (content === undefined) {
                let handle: fs.FileHandle | undefined;
                try {handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(2048); const { bytesRead } = await handle.read(buffer); content = buffer.subarray(0, bytesRead);}
                catch { /* Deleted file. */ } finally {await handle?.close();}
            }
            if (content !== undefined) {
                const generated = isGeneratedSource(file, content);
                this.host.engine.sources.observeGenerated(file, generated);
                if (generated) {return;}
            } else if (this.host.engine.sources.isGenerated(file)) {return;}
        }
        // Disposal can happen during the awaits above.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.host.disposed) {return;}
        const files = [...descendants, file];
        this.host.scheduler.request(files, directory);
        // Preserve historical outcomes until analysis identifies the actual
        // selection. Conservative invalidation cannot be undone in Test Explorer.
        this.queueChanged(files);
    }

    /** Coalesce bursts of file events into one `markChanged`; a run flushes first, so marks precede it. */
    private queueChanged(files: readonly string[]): void {
        for (const file of files) {this.changedFiles.add(file);}
        this.changeTimer ??= setTimeout(() => { this.changeTimer = undefined; void this.flush(); }, 50);
    }

    flush(): Promise<void> {
        if (this.changeTimer) {clearTimeout(this.changeTimer); this.changeTimer = undefined;}
        if (this.changedFiles.size && !this.host.disposed) {
            const files = [...this.changedFiles]; this.changedFiles.clear();
            this.changeChain = this.changeChain.then(() => this.host.engine.markChanged(files)).catch((error: unknown) => this.host.reportError(error));
        }
        return this.changeChain;
    }

    dispose(): void {
        clearTimeout(this.changeTimer); this.changedFiles.clear();
        this.watchers.forEach(watcher => {watcher.dispose();});
    }
}
