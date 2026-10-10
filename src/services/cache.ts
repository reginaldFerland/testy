import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageDelta, CoverageSource, CoverageStore, mergeDeclarations } from '../core/coverage';
import { contentHash } from '../core/paths';
import { OutcomeDelta, StoredOutcomes } from '../core/runPolicy';
import { mapConcurrent } from '../core/concurrency';
import { withLock } from './lock';

export { validOutcomes, validSource, validTrace } from './cacheFormat';
import { CacheLimits, defaultCacheLimits, validSource } from './cacheFormat';
import { CacheContents, readCache } from './cacheReader';
import { finishAsync, sortedUnion } from '../core/work';
import { jsonChunks, syncDirectory } from './jsonWriter';

/** Which sources each saved trace uses, so unreferenced geometry is found without rereading the cache. */
class TraceIndex {
    /** Oldest first: saving a trace moves it to the end. */
    readonly entries = new Map<string, { readonly ids: readonly string[]; readonly bytes: number }>();
    private readonly references = new Map<string, number>();
    bytes = 0;
    /** Some source may have lost its last trace, or never had one. */
    orphaned = false;
    has(id: string): boolean { return this.references.has(id); }
    set(stem: string, ids: readonly string[], bytes: number): void {
        const previous = this.entries.get(stem);
        for (const id of ids) {this.references.set(id, (this.references.get(id) ?? 0) + 1);}
        if (previous) {this.release(previous.ids); this.bytes -= previous.bytes; this.entries.delete(stem);}
        this.entries.set(stem, { ids, bytes }); this.bytes += bytes;
    }
    delete(stem: string): void {
        const previous = this.entries.get(stem);
        if (!previous) {return;}
        this.release(previous.ids); this.bytes -= previous.bytes; this.entries.delete(stem);
    }
    private release(ids: readonly string[]): void {
        for (const id of ids) {
            const count = this.references.get(id)! - 1;
            if (count) {this.references.set(id, count);} else {this.references.delete(id); this.orphaned = true;}
        }
    }
}

/** Immutable source records and independently atomic traces avoid full-cache rewrites; so do the latest
 * test outcomes, one record per test file beside the traces. */
export class CoverageCache {
    private readonly directory: string;
    private writes = 0;
    private epoch: string | undefined;
    private readonly knownSources = new Map<string, CoverageSource>();
    /** Present only while it provably matches the directory; any doubt discards it. */
    private index: TraceIndex | undefined;
    private readonly unsynced = new Set<string>();
    constructor(storage: string, private readonly output: (text: string) => void, private readonly limits: CacheLimits = defaultCacheLimits) { this.directory = path.join(storage, 'coverage-v2'); }

    /** Resolves to the saved test outcomes. */
    async restore(store: CoverageStore, signal?: AbortSignal): Promise<readonly StoredOutcomes[]> {
        const revision = store.revision;
        return withLock(`${this.directory}.lock`, signal, async () => {
            try {
                await this.beginWrite(signal);
                const snapshot = await readCache(this.directory, signal, this.limits);
                const complete = await this.discard(snapshot, signal);
                for (const source of snapshot.sources) {this.knownSources.set(source.id, source);}
                signal?.throwIfAborted();
                await store.restorePackedAsync(snapshot.sources, snapshot.traces, signal, revision);
                await this.finishMaintenance(snapshot, complete, signal);
                await this.flush(signal);
                return snapshot.outcomes;
            } catch (error) {this.invalidateMaintenance(); throw error;}
        });
    }

    async save(delta: CoverageDelta & { readonly outcomes?: OutcomeDelta }, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const outcomes = delta.outcomes ?? { saved: [], removed: [] };
        if (!delta.sources.length && !delta.traces.length && !delta.removedTraces.length && !outcomes.saved.length && !outcomes.removed.length) {return;}
        await withLock(`${this.directory}.lock`, signal, async () => {
            try {
                await Promise.all(['sources', 'traces', ...outcomes.saved.length ? ['outcomes'] : []].map(kind => fs.mkdir(path.join(this.directory, kind), { recursive: true })));
                await this.beginWrite(signal);
                if (delta.removedSources.length && this.index) {this.index.orphaned = true;}
                const sources = new Map<string, CoverageSource[]>();
                for (const source of delta.sources) {
                    const group = sources.get(source.id);
                    if (!group && this.knownSources.get(source.id) === source) {continue;}
                    if (group) {group.push(source);} else {sources.set(source.id, [source]);}
                }
                // Independent geometry records share a small filesystem budget. Keep
                // same-ID merges ordered and drain all writes before publishing traces
                // or releasing the cross-process lock, including after cancellation.
                const introduced = new Set<string>();
                await mapConcurrent([...sources.values()], 4, signal, async (group, _index, workerSignal) => {
                    for (const source of group) {if (await this.saveSource(source, workerSignal)) {introduced.add(source.id);}}
                });
                // Geometry is durable before any trace names it.
                await this.flush(signal);
                // Serial: a delta may repeat a trace, and a failure must leave every earlier trace published.
                for (const trace of delta.traces) {
                    const bytes = await this.write('traces', contentHash(trace.groupId), trace, signal);
                    this.index?.set(contentHash(trace.groupId), trace.sourceIds, bytes);
                }
                if (this.index) {for (const id of introduced) {if (!this.index.has(id)) {this.index.orphaned = true;}}}
                for (const id of delta.removedTraces) {
                    signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'traces', `${contentHash(id)}.json`), { force: true });
                    this.index?.delete(contentHash(id));
                }
                // Each file's outcomes replace its previous record whole; nothing else refers to them.
                for (const stored of outcomes.saved) {await this.write('outcomes', contentHash(stored.groupId), stored, signal);}
                for (const id of outcomes.removed) {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'outcomes', `${contentHash(id)}.json`), { force: true });}
                await this.flush(signal);
                if (++this.writes % 128 === 0) {await this.maintain(signal);}
            } catch (error) {this.invalidateMaintenance(); throw error;}
        });
    }

    private async saveSource(source: CoverageSource, signal: AbortSignal): Promise<boolean> {
        signal.throwIfAborted();
        let previous = this.knownSources.get(source.id);
        if (!previous) {
            try {
                const value: unknown = JSON.parse(await fs.readFile(path.join(this.directory, 'sources', `${source.id}.json`), { encoding: 'utf8', signal }));
                if (validSource(value)) {previous = value;}
            }
            catch {signal.throwIfAborted(); /* Missing or corrupt. */}
        }
        if (previous === source) {return false;}
        const lines = previous ? await finishAsync(sortedUnion(previous.lines, source.lines), signal) : source.lines;
        const declarations = mergeDeclarations(previous?.declarations, source.declarations);
        const merged = lines.length === source.lines.length && declarations === source.declarations ? source : { ...source, lines, ...declarations ? { declarations } : {} };
        if (!previous || lines.length !== previous.lines.length || declarations !== previous.declarations) {await this.write('sources', source.id, merged, signal);}
        this.knownSources.set(source.id, merged);
        return !previous;
    }

    /** Publish before mutation so even an interrupted other writer invalidates our memo.
     * The epoch only coordinates live writers, which observe it through the shared page
     * cache, so it is replaced atomically but not synced: after a crash no writer retains
     * a memo for a lost epoch to invalidate. Records are still synced one by one, since a
     * rename can otherwise become durable before its data, and every sync of a directory's
     * renames is batched into one flush per phase. */
    private async beginWrite(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        await fs.mkdir(this.directory, { recursive: true });
        let current: unknown;
        try {current = JSON.parse(await fs.readFile(path.join(this.directory, 'epoch.json'), { encoding: 'utf8', signal }));}
        catch {signal?.throwIfAborted();}
        if (!current || current !== this.epoch) {this.knownSources.clear(); this.invalidateMaintenance();}
        const next = randomUUID();
        await this.write('', 'epoch', next, signal, false); this.epoch = next;
    }

    private invalidateMaintenance(): void { this.index = undefined; }

    /** Report the snapshot's findings and remove what can never be valid. False if a removal failed. */
    private async discard(snapshot: CacheContents, signal?: AbortSignal): Promise<boolean> {
        for (const warning of snapshot.warnings) {this.output(`${warning}\n`);}
        let complete = snapshot.complete;
        // The affected traces simply go missing and are learned again.
        for (const name of [...snapshot.corrupt, ...snapshot.evicted]) {
            signal?.throwIfAborted();
            try {
                await fs.rm(path.join(this.directory, name), { force: true });
                if (name.startsWith('sources/')) {this.knownSources.delete(name.slice('sources/'.length, -'.json'.length));}
            } catch (error) {signal?.throwIfAborted(); complete = false; this.output(`Unable to remove coverage cache entry ${name}: ${String(error)}\n`);}
        }
        return complete;
    }

    /** Every 128 saves: reread the cache only when what it holds is unknown. */
    private async maintain(signal?: AbortSignal): Promise<void> {
        const index = this.index;
        if (!index) {
            const snapshot = await readCache(this.directory, signal, this.limits);
            await this.finishMaintenance(snapshot, await this.discard(snapshot, signal), signal);
            return;
        }
        // Saves never read the cache, so the restore limits also bound what accumulates.
        for (const stem of [...index.entries.keys()]) {
            if (index.entries.size <= this.limits.maxTraces && index.bytes <= this.limits.maxBytes) {break;}
            signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'traces', `${stem}.json`), { force: true }); index.delete(stem);
        }
        if (!index.orphaned) {return;}
        if (await this.prune(index, signal)) {index.orphaned = false;} else {this.invalidateMaintenance();}
    }

    /** Only a complete validated snapshot and finished prune can prove later additions safe. */
    private async finishMaintenance(snapshot: Pick<CacheContents, 'traces' | 'stats'>, complete: boolean, signal?: AbortSignal): Promise<void> {
        if (!complete) {this.invalidateMaintenance(); return;}
        // Stats are in trace order; a trace without one cannot be ordered and stays out of the index.
        const index = new TraceIndex(), order = snapshot.traces.flatMap((trace, position) => {const stat = snapshot.stats[position]; return stat ? [{ trace, stat }] : [];})
            .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
        await finishAsync((function* () {
            let count = 0;
            for (const { trace, stat } of order) {
                index.set(contentHash(trace.groupId), trace.sourceIds, stat.bytes);
                count += trace.sourceIds.length + 1;
                if (count >= 4096) {count = 0; yield;}
            }
        })(), signal);
        if (!await this.prune(index, signal)) {this.invalidateMaintenance(); return;}
        signal?.throwIfAborted();
        index.orphaned = false; this.index = index;
    }

    private async prune(live: Pick<TraceIndex, 'has'>, signal?: AbortSignal): Promise<boolean> {
        const directory = path.join(this.directory, 'sources');
        let names: string[];
        try {names = await fs.readdir(directory);}
        catch (error) {signal?.throwIfAborted(); return (error as NodeJS.ErrnoException).code === 'ENOENT';}
        for (const name of names) {
            signal?.throwIfAborted();
            if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name.slice(0, -5))) {
                await fs.rm(path.join(directory, name), { force: true }); this.knownSources.delete(name.slice(0, -5));
            }
        }
        signal?.throwIfAborted(); return true;
    }

    /** Persist the renames made since the last flush. */
    private async flush(signal?: AbortSignal): Promise<void> {
        const directories = [...this.unsynced]; this.unsynced.clear();
        for (const directory of directories) {signal?.throwIfAborted(); await syncDirectory(directory);}
    }

    /** Atomically publish a JSON record; resolves to its size in bytes. A durable record is
     * synced before its rename and its directory joins the next flush. */
    private async write(kind: string, id: string, value: unknown, signal?: AbortSignal, durable = true): Promise<number> {
        signal?.throwIfAborted();
        const destination = path.join(this.directory, kind, `${id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        let handle: fs.FileHandle | undefined, bytes = 0;
        try {
            handle = await fs.open(temporary, 'w');
            for (const chunk of jsonChunks(value)) {signal?.throwIfAborted(); await handle.writeFile(chunk); bytes += Buffer.byteLength(chunk);}
            // The data must be durable before the rename can make it the record.
            if (durable) {await handle.sync();}
            await handle.close(); handle = undefined;
            signal?.throwIfAborted(); await fs.rename(temporary, destination);
            if (durable) {this.unsynced.add(path.dirname(destination));}
        }
        finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
        return bytes;
    }
}
