import * as fs from 'node:fs/promises';
import { contentHash, isGeneratedSource } from '../core/paths';

interface SourceState { readonly stamp: string; readonly hash?: string; readonly generated: boolean; readonly excludedAliases: readonly string[]; }

/** Reads changed content only; all expensive work belongs to the scheduled batch. */
export class SourceTracker {
    private readonly states = new Map<string, SourceState>();
    private readonly dirty = new Set<string>();
    private current: ReadonlyMap<string, string> = new Map();
    private known = new Set<string>();
    revision = 0;

    get hashes(): ReadonlyMap<string, string> { return this.current; }
    get files(): readonly string[] { return [...this.known]; }
    isGenerated(file: string): boolean { return this.states.get(file)?.generated ?? false; }
    get excludedAliases(): readonly string[] { return [...new Set([...this.states.values()].flatMap(state => [...state.excludedAliases]))]; }

    setFiles(files: readonly string[]): void {
        const next = new Set(files);
        const hashes = new Map(this.current);
        let changed = false;
        for (const file of this.known) {
            if (!next.has(file)) {this.states.delete(file); hashes.delete(file); this.dirty.delete(file); changed = true;}
        }
        for (const file of next) {if (!this.known.has(file)) {this.dirty.add(file);}}
        this.known = next;
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
                    const excludedAliases = [...content.matchAll(/\bglobal\s+using\s+(@?\w+)\s*=([^;]+);/g)]
                        .filter(match => /\b(ExcludeFromCodeCoverage|DebuggerHidden|DebuggerNonUserCode|GeneratedCode|CompilerGenerated)(Attribute)?\b/.test(match[2]))
                        .flatMap(match => {const name = match[1].replace(/^@/, ''); return [name, name.replace(/Attribute$/, '')];});
                    const generated = isGeneratedSource(file, bytes);
                    updates.set(file, { stamp, hash: generated ? undefined : contentHash(bytes), generated, excludedAliases });
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
            if (state) {this.states.set(file, state);} else {this.states.delete(file);}
        }
        if (revision === this.revision) {for (const file of queue) {this.dirty.delete(file);}}
        if (hashes) {this.current = hashes;}
        return changed;
    }
}
