import * as fs from 'node:fs/promises';
import { contentHash, isGeneratedSource } from '../core/paths';

interface SourceState { readonly stamp: string; readonly hash?: string; readonly analysisHash?: string; readonly generated: boolean; readonly aliasSource?: string; }

/** Reads changed content only; all expensive work belongs to the scheduled batch. */
export class SourceTracker {
    private readonly states = new Map<string, SourceState>();
    private readonly dirty = new Set<string>();
    private current: ReadonlyMap<string, string> = new Map();
    private known = new Set<string>();
    private tracked = new Set<string>();
    private readonly classifications = new Map<string, { generated: boolean; version: number }>();
    private classificationVersion = 0;
    revision = 0;

    get hashes(): ReadonlyMap<string, string> { return this.current; }
    get files(): readonly string[] { return [...this.known]; }
    isGenerated(file: string): boolean { return this.classifications.get(file)?.generated ?? this.states.get(file)?.generated ?? false; }
    observeGenerated(file: string, generated: boolean): void { this.classifications.set(file, { generated, version: ++this.classificationVersion }); }
    get analysisHashes(): ReadonlyMap<string, string> { return new Map([...this.states].filter(([, state]) => state.analysisHash !== undefined).map(([file, state]) => [file, state.analysisHash!])); }
    get aliasSources(): ReadonlyMap<string, string> { return new Map([...this.states].filter(([, state]) => state.aliasSource !== undefined).map(([file, state]) => [file, state.aliasSource!])); }

    setFiles(files: readonly string[], analysisFiles: readonly string[] = []): void {
        const tracked = new Set(files), next = new Set([...files, ...analysisFiles]);
        const hashes = new Map(this.current);
        let changed = false;
        for (const file of this.known) {
            if (!next.has(file)) {this.states.delete(file); hashes.delete(file); this.dirty.delete(file); changed = true;}
        }
        // Ordinary paths need no tombstone once they leave the source graph.
        for (const [file, classification] of this.classifications) {
            if (!next.has(file) && !classification.generated) {this.classifications.delete(file);}
        }
        for (const file of next) {if (!this.known.has(file) || tracked.has(file) !== this.tracked.has(file)) {this.dirty.add(file);}}
        this.known = next;
        this.tracked = tracked;
        if (changed) {this.current = hashes; this.revision++;}
    }

    mark(files: readonly string[]): void {
        for (const file of files) {this.dirty.add(file);}
        this.revision++;
    }

    async refresh(files: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
        const queue = [...new Set([...files, ...this.dirty])].filter(file => this.known.has(file));
        const updates = new Map<string, SourceState | undefined>();
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
                    const content = /\.cs$/i.test(file) ? bytes.toString('utf8') : '';
                    const generated = isGeneratedSource(file, bytes);
                    // This is only a cheap candidate check. Roslyn interprets
                    // comments, escapes, Unicode and disabled branches later.
                    const aliasSource = /\bglobal(?=\s|\/)/.test(content) ? content : undefined;
                    const hash = contentHash(bytes);
                    updates.set(file, { stamp, hash: this.tracked.has(file) && !generated ? hash : undefined,
                        analysisHash: /\.cs$/i.test(file) ? hash : undefined, generated, aliasSource });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
                    updates.set(file, undefined);
                }
            }
        }));
        signal?.throwIfAborted();
        const changed: string[] = [];
        let hashes: Map<string, string> | undefined;
        for (const [file, state] of updates) {
            if (this.current.get(file) !== state?.hash) {
                changed.push(file); hashes ??= new Map(this.current);
                if (state?.hash) {hashes.set(file, state.hash);} else {hashes.delete(file);}
            }
            if (state) {
                this.states.set(file, state);
                if ((this.classifications.get(file)?.version ?? 0) <= classificationVersion) {this.observeGenerated(file, state.generated);}
            }
            else if (this.states.get(file)?.generated) {this.states.set(file, { stamp: '', generated: true });}
            else {this.states.delete(file);}
        }
        if (revision === this.revision) {for (const file of queue) {this.dirty.delete(file);}}
        if (hashes) {this.current = hashes;}
        return changed;
    }
}
