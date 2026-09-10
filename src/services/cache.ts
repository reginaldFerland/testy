import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageDelta, CoverageSource, CoverageStore, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';
import { mapConcurrent } from '../core/concurrency';
import { withLock } from './lock';

export { validSource, validTrace } from './cacheFormat';
import { validSource } from './cacheFormat';
import { readCache } from './cacheReader';
import { finishAsync, sortedUnion } from '../core/work';
import { jsonChunks } from './jsonWriter';

/** Immutable source records and independently atomic traces avoid full-cache rewrites. */
export class CoverageCache {
    private readonly directory: string;
    private writes = 0;
    private epoch: string | undefined;
    private readonly knownSources = new Map<string, CoverageSource>();
    constructor(storage: string, private readonly output: (text: string) => void) { this.directory = path.join(storage, 'coverage-v2'); }

    async restore(store: CoverageStore, signal?: AbortSignal): Promise<void> {
        const revision = store.revision;
        await withLock(`${this.directory}.lock`, signal, async () => {
            await this.beginWrite(signal);
            const snapshot = await readCache(this.directory, signal);
            for (const warning of snapshot.warnings) {this.output(`${warning}\n`);}
            for (const source of snapshot.sources) {this.knownSources.set(source.id, source);}
            signal?.throwIfAborted();
            await store.restorePackedAsync(snapshot.sources, snapshot.traces, signal, revision);
            if (snapshot.complete) {await this.prune(snapshot.traces, signal);}
        });
    }

    async save(delta: CoverageDelta, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (!delta.sources.length && !delta.traces.length && !delta.removedTraces.length) {return;}
        await withLock(`${this.directory}.lock`, signal, async () => {
            await Promise.all(['sources', 'traces'].map(kind => fs.mkdir(path.join(this.directory, kind), { recursive: true })));
            await this.beginWrite(signal);
            const sources = new Map<string, CoverageSource[]>();
            for (const source of delta.sources) {
                const group = sources.get(source.id);
                if (!group && this.knownSources.get(source.id) === source) {continue;}
                if (group) {group.push(source);} else {sources.set(source.id, [source]);}
            }
            // Independent geometry records share a small filesystem budget. Keep
            // same-ID merges ordered and drain all writes before publishing traces
            // or releasing the cross-process lock, including after cancellation.
            await mapConcurrent([...sources.values()], 4, signal, async (group, _index, workerSignal) => {
                for (const source of group) {await this.saveSource(source, workerSignal);}
            });
            for (const trace of delta.traces) {await this.write('traces', contentHash(trace.groupId), trace, signal);}
            for (const id of delta.removedTraces) {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'traces', `${contentHash(id)}.json`), { force: true });}
            if (++this.writes % 128 === 0) {
                const snapshot = await readCache(this.directory, signal);
                for (const warning of snapshot.warnings) {this.output(`${warning}\n`);}
                if (snapshot.complete) {await this.prune(snapshot.traces, signal);}
            }
        });
    }

    private async saveSource(source: CoverageSource, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        let previous = this.knownSources.get(source.id);
        if (!previous) {
            try {
                const value: unknown = JSON.parse(await fs.readFile(path.join(this.directory, 'sources', `${source.id}.json`), { encoding: 'utf8', signal }));
                if (validSource(value)) {previous = value;}
            }
            catch {signal.throwIfAborted(); /* Missing or corrupt. */}
        }
        if (previous === source) {return;}
        const lines = previous ? await finishAsync(sortedUnion(previous.lines, source.lines), signal) : source.lines;
        const merged = lines.length === source.lines.length ? source : { ...source, lines };
        if (!previous || lines.length !== previous.lines.length) {await this.write('sources', source.id, merged, signal);}
        this.knownSources.set(source.id, merged);
    }

    /** Publish before mutation so even an interrupted other writer invalidates our memo. */
    private async beginWrite(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        await fs.mkdir(this.directory, { recursive: true });
        let current: unknown;
        try {current = JSON.parse(await fs.readFile(path.join(this.directory, 'epoch.json'), { encoding: 'utf8', signal }));}
        catch {signal?.throwIfAborted();}
        if (!current || current !== this.epoch) {this.knownSources.clear();}
        const next = randomUUID();
        await this.write('', 'epoch', next, signal); this.epoch = next;
    }

    private async prune(traces: readonly StoredTrace[], signal?: AbortSignal): Promise<void> {
        const live = new Set<string>();
        await finishAsync((function* () {
            let count = 0;
            for (const trace of traces) {for (const id of trace.sourceIds) {
                live.add(id); if (++count % 4096 === 0) {yield;}
            }}
        })(), signal);
        const directory = path.join(this.directory, 'sources');
        for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
            signal?.throwIfAborted();
            if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name.slice(0, -5))) {
                await fs.rm(path.join(directory, name), { force: true }); this.knownSources.delete(name.slice(0, -5));
            }
        }
    }

    private async write(kind: string, id: string, value: unknown, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const destination = path.join(this.directory, kind, `${id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(temporary, 'w');
            for (const chunk of jsonChunks(value)) {signal?.throwIfAborted(); await handle.writeFile(chunk);}
            await handle.close(); handle = undefined;
            signal?.throwIfAborted(); await fs.rename(temporary, destination);
        }
        finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
    }

}
