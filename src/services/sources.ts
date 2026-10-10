import * as fs from 'node:fs/promises';
import { contentHash, isGeneratedSource, sourceText } from '../core/paths';

interface SourceState { readonly stamp: string; readonly hash: string | undefined; readonly analysisHash: string | undefined; readonly generated: boolean; readonly aliasSource: string | undefined; }

/** Cheap candidate check for `global using` directives; Roslyn interprets escapes and disabled branches later.
 * Comments are blanked, so prose and commented-out directives do not retain full sources. */
function mayDeclareGlobalUsing(content: string): boolean {
    return content.includes('global') && /\bglobal\s+using\b/.test(content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ' '));
}

/** Reads changed content only; all expensive work belongs to the scheduled batch. */
export class SourceTracker {
    private readonly states = new Map<string, SourceState>();
    private readonly dirty = new Set<string>();
    private current: ReadonlyMap<string, string> = new Map();
    private known = new Set<string>();
    /** `known` as a list, built once per setFiles: every full sweep reads it. */
    private knownList: readonly string[] | undefined;
    private tracked = new Set<string>();
    private readonly classifications = new Map<string, { generated: boolean; version: number }>();
    private classificationVersion = 0;
    private derived: { readonly analysisHashes: ReadonlyMap<string, string>; readonly aliasSources: ReadonlyMap<string, string> } | undefined;
    /** Refreshes apply in start order; see refresh(). */
    private refreshing: Promise<unknown> = Promise.resolve();
    revision = 0;

    get hashes(): ReadonlyMap<string, string> { return this.current; }
    get files(): readonly string[] { return this.knownList ??= [...this.known]; }
    isGenerated(file: string): boolean { return this.classifications.get(file)?.generated ?? this.states.get(file)?.generated ?? false; }
    /** An editor or watcher classification. The file is read again by the next refresh, since a header change is also a content change
     * that the watcher does not otherwise report for generated files. */
    observeGenerated(file: string, generated: boolean): void { this.classify(file, generated); if (this.known.has(file)) {this.dirty.add(file);} }
    private classify(file: string, generated: boolean): void { this.classifications.set(file, { generated, version: ++this.classificationVersion }); }
    // Rebuilt lazily after the states change; callers read these on every analysis.
    get analysisHashes(): ReadonlyMap<string, string> { return this.derive().analysisHashes; }
    get aliasSources(): ReadonlyMap<string, string> { return this.derive().aliasSources; }
    private derive(): NonNullable<SourceTracker['derived']> {
        return this.derived ??= {
            analysisHashes: new Map([...this.states].filter(([, state]) => state.analysisHash !== undefined).map(([file, state]) => [file, state.analysisHash!])),
            aliasSources: new Map([...this.states].filter(([, state]) => state.aliasSource !== undefined).map(([file, state]) => [file, state.aliasSource!]))
        };
    }

    setFiles(files: readonly string[], analysisFiles: readonly string[] = []): void {
        const tracked = new Set(files), next = new Set([...files, ...analysisFiles]);
        const hashes = new Map(this.current);
        let changed = false;
        for (const file of this.known) {
            if (!next.has(file)) {this.states.delete(file); hashes.delete(file); this.dirty.delete(file); changed = true; this.derived = undefined;}
        }
        // Ordinary paths need no tombstone once they leave the source graph.
        for (const [file, classification] of this.classifications) {
            if (!next.has(file) && !classification.generated) {this.classifications.delete(file);}
        }
        for (const file of next) {if (!this.known.has(file) || tracked.has(file) !== this.tracked.has(file)) {this.dirty.add(file);}}
        this.known = next; this.knownList = undefined;
        this.tracked = tracked;
        if (changed) {this.current = hashes; this.revision++;}
    }

    mark(files: readonly string[]): void {
        for (const file of files) {this.dirty.add(file);}
        this.revision++;
    }

    /** Refreshes are serialized: overlapping ones (event handling, run phases, commits) would
     * otherwise apply in completion order, so a slow older read could replace newer hashes.
     * A caller that is cancelled while queued stops waiting at once. */
    refresh(files: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
        if (signal?.aborted) {return Promise.reject(signal.reason as Error);}
        const result = this.refreshing.then(() => this.refreshNow(files, signal));
        this.refreshing = result.catch(() => undefined);
        if (!signal) {return result;}
        return new Promise((resolve, reject) => {
            const abort = (): void => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            result.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
    }

    /** A full sweep of every known file, for background use. Cancellation stops it only before it applies anything: the changes
     * it applies are always returned, never lost to a late abort, since no later refresh reports them again. */
    sweep(signal: AbortSignal): Promise<readonly string[]> {
        const result = this.refreshing.then(() => this.refreshNow(this.files, signal));
        this.refreshing = result.catch(() => undefined);
        return result;
    }

    private async refreshNow(files: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
        signal?.throwIfAborted();
        const queue = [...new Set([...files, ...this.dirty])].filter(file => this.known.has(file));
        const updates = new Map<string, SourceState | undefined>();
        const transient = new Set<string>();
        let index = 0;
        const revision = this.revision;
        const classificationVersion = this.classificationVersion;
        await Promise.all(Array.from({ length: Math.min(16, queue.length) }, async () => {
            for (;;) {
                signal?.throwIfAborted();
                const file = queue[index++];
                if (!file) {return;}
                try {
                    const stat = await fs.stat(file, { bigint: true });
                    if (!stat.isFile()) {updates.set(file, undefined); continue;}
                    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                    const previous = this.states.get(file);
                    if (previous?.stamp === stamp && !this.dirty.has(file)) {continue;}
                    const bytes = await fs.readFile(file, { signal });
                    const content = /\.cs$/i.test(file) ? sourceText(bytes) : '';
                    const generated = isGeneratedSource(file, bytes);
                    const aliasSource = mayDeclareGlobalUsing(content) ? content : undefined;
                    const hash = contentHash(bytes);
                    updates.set(file, { stamp, hash: this.tracked.has(file) && !generated ? hash : undefined,
                        analysisHash: /\.cs$/i.test(file) ? hash : undefined, generated, aliasSource });
                } catch (error) {
                    if (signal?.aborted || (error as Error).name === 'AbortError') {throw error;}
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {updates.set(file, undefined);}
                    // EBUSY/EPERM/EACCES (antivirus, editors on Windows) are usually brief:
                    // the version becomes unknown and the file is read again next time.
                    else {transient.add(file);}
                }
            }
        }));
        signal?.throwIfAborted();
        const changed: string[] = [];
        let hashes: Map<string, string> | undefined;
        for (const file of transient) {
            const previous = this.states.get(file);
            if (this.current.get(file) !== undefined) {hashes ??= new Map(this.current); hashes.delete(file);}
            if (previous) {this.states.set(file, { ...previous, stamp: '', hash: undefined });}
            changed.push(file);
        }
        for (const [file, state] of updates) {
            // setFiles may have retired it while this refresh read it.
            if (!this.known.has(file)) {continue;}
            if (this.current.get(file) !== state?.hash) {
                changed.push(file); hashes ??= new Map(this.current);
                if (state?.hash) {hashes.set(file, state.hash);} else {hashes.delete(file);}
            }
            if (state) {
                this.states.set(file, state);
                if ((this.classifications.get(file)?.version ?? 0) <= classificationVersion) {this.classify(file, state.generated);}
            }
            else if (this.states.get(file)?.generated) {this.states.set(file, { stamp: '', hash: undefined, analysisHash: undefined, generated: true, aliasSource: undefined });}
            else {this.states.delete(file);}
        }
        if (revision === this.revision) {for (const file of queue) {if (!transient.has(file)) {this.dirty.delete(file);}}}
        for (const file of transient) {this.dirty.add(file);}
        this.derived = undefined;
        if (hashes) {this.current = hashes;}
        return changed;
    }
}
