import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageDelta, CoverageSource, CoverageStore, mergeDeclarations, StoredTrace } from '../core/coverage';
import { FileCoverage } from '../core/model';
import { contentHash } from '../core/paths';
import { OutcomeDelta, StoredOutcomes } from '../core/runPolicy';
import { mapConcurrent } from '../core/concurrency';
import { lockTiming, withLock } from './lock';

export { validOutcomes, validSource } from './cacheFormat';
export type { SavedCheckpoint } from './cacheFormat';
import { cacheDirectory, cacheFormat, CacheLimits, CheckpointRecord, defaultCacheLimits, legacyCacheDirectories, recordFormat, SavedCheckpoint, TableEntry,
    TestCoverageRecord, TraceRecord, validPointer, validSegment, validSource, validTestCoverage } from './cacheFormat';
import { TestCoverageDelta } from '../core/testCoverage';
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

/** What a save writes besides coverage: changed outcomes, each test's own coverage, and the checkpoint (undefined keeps the saved
 * one, null deletes it). */
export type CacheDelta = CoverageDelta & { readonly outcomes?: OutcomeDelta; readonly tests?: TestCoverageDelta; readonly checkpoint?: SavedCheckpoint | null };
/** Saved per-test coverage of one test file, by test ID: the hits of each version it covers (see restoredRecords). */
export type SavedTestCoverage = ReadonlyMap<string, readonly { readonly file: string; readonly hash: string; readonly hits: ReadonlyMap<number, number> }[]>;
/** What a restore found: the saved outcomes, and the checkpoint when it was saved under the requested identity. */
export interface RestoredCache { readonly outcomes: readonly StoredOutcomes[]; readonly checkpoint: SavedCheckpoint | undefined }

/** The entries of one table generation, interned; the first `persisted` are on disk. */
class Table {
    readonly entries: TableEntry[] = [];
    private readonly positions = new Map<string, number>();
    persisted: number;
    constructor(readonly generation: string, entries: readonly TableEntry[] = []) {
        for (const entry of entries) {const key = Table.key(entry); if (!this.positions.has(key)) {this.positions.set(key, this.entries.length);} this.entries.push(entry);}
        this.persisted = this.entries.length;
    }
    private static key(entry: TableEntry): string { return typeof entry === 'string' ? `s${entry}` : `v${entry[0]}\0${entry[1]}`; }
    string(value: string): number { return this.intern(value); }
    version(file: string, hash: string): number { return this.intern([this.string(file), hash]); }
    private intern(entry: TableEntry): number {
        const key = Table.key(entry);
        let position = this.positions.get(key);
        if (position === undefined) {position = this.entries.length; this.entries.push(entry); this.positions.set(key, position);}
        return position;
    }
}

const segmentName = (start: number): string => String(start).padStart(12, '0');

/** Immutable source records and independently atomic traces avoid full-cache rewrites; so do the latest
 * test outcomes, one record per test file beside the traces. Paths and source versions are stored once, in an
 * append-only table that traces and the checkpoint reference by position. */
export class CoverageCache {
    private readonly directory: string;
    private writes = 0;
    private epoch: string | undefined;
    private readonly knownSources = new Map<string, CoverageSource>();
    /** Present only while it provably matches the directory; any doubt discards it. */
    private index: TraceIndex | undefined;
    private readonly unsynced = new Set<string>();
    /** Present only while it provably matches the directory, like `index`. */
    private table: Table | undefined;
    constructor(private readonly storage: string, private readonly output: (text: string) => void, private readonly limits: CacheLimits = defaultCacheLimits) {
        this.directory = path.join(storage, cacheDirectory);
    }

    /** Restores the saved traces into `store`. With `identity`, a checkpoint saved under that identity is returned, and the
     * traces learned under it are restored as saved (see CoverageStore.restorePacked); every other trace is stale history.
     * Once this format's directory is established, earlier formats' directories are deleted. */
    async restore(store: CoverageStore, signal?: AbortSignal, identity?: string): Promise<RestoredCache> {
        const revision = store.revision;
        const restored = await withLock(`${this.directory}.lock`, signal, async () => {
            try {
                await this.beginWrite(signal);
                const snapshot = await readCache(this.directory, signal, this.limits);
                const complete = await this.discard(snapshot, signal);
                for (const source of snapshot.sources) {this.knownSources.set(source.id, source);}
                const generation = snapshot.generation;
                this.table = generation === undefined ? undefined : new Table(generation, snapshot.tables[generation]);
                if (snapshot.compact && complete) {await this.compact(snapshot, signal);}
                signal?.throwIfAborted();
                const checkpoint = identity !== undefined && snapshot.checkpoint?.identity === identity ? snapshot.checkpoint : undefined;
                await store.restorePackedAsync(snapshot.sources, snapshot.traces, signal, revision, checkpoint ? trace => trace.identity === identity : undefined);
                await this.finishMaintenance(snapshot, complete, signal);
                await this.flush(signal);
                return { outcomes: snapshot.outcomes, checkpoint };
            } catch (error) {this.invalidateMaintenance(); throw error;}
        });
        await this.removeLegacy(signal);
        return restored;
    }

    async save(delta: CacheDelta, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const outcomes = delta.outcomes ?? { saved: [], removed: [] }, tests = delta.tests ?? { saved: [], removed: [] };
        if (!delta.sources.length && !delta.traces.length && !delta.removedTraces.length && !outcomes.saved.length && !outcomes.removed.length
            && !tests.saved.length && !tests.removed.length && delta.checkpoint === undefined) {return;}
        await withLock(`${this.directory}.lock`, signal, async () => {
            try {
                await Promise.all(['sources', 'traces', ...outcomes.saved.length ? ['outcomes'] : [], ...tests.saved.length ? ['tests'] : [], ...delta.checkpoint ? ['checkpoint'] : []]
                    .map(kind => fs.mkdir(path.join(this.directory, kind), { recursive: true })));
                await this.beginWrite(signal);
                const table = this.table ??= await this.loadTable(signal);
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
                const versions = await this.sourcesOf(delta, signal);
                const records = delta.traces.map(trace => this.encode(trace, table, versions));
                const checkpoint = delta.checkpoint ? this.encodeCheckpoint(delta.checkpoint, table) : undefined;
                // Geometry and table entries are durable before any trace names them.
                await this.writeSegment(table, signal);
                await this.flush(signal);
                await this.publish('traces', records.map((record, position) => ({ id: contentHash(record.groupId), value: record,
                    published: (bytes: number) => this.index?.set(contentHash(record.groupId), delta.traces[position]!.sourceIds, bytes) })), signal);
                if (this.index) {for (const id of introduced) {if (!this.index.has(id)) {this.index.orphaned = true;}}}
                for (const id of delta.removedTraces) {
                    signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'traces', `${contentHash(id)}.json`), { force: true });
                    this.index?.delete(contentHash(id));
                }
                // The checkpoint vouches for traces, so it never becomes durable before them.
                if (delta.checkpoint !== undefined) {
                    await this.flush(signal);
                    if (checkpoint) {await this.write('checkpoint', 'checkpoint', checkpoint, signal);}
                    else {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'checkpoint', 'checkpoint.json'), { force: true });}
                }
                // Each file's outcomes replace its previous record whole; nothing else refers to them.
                await this.publish('outcomes', outcomes.saved.map(stored => ({ id: contentHash(stored.groupId), value: { format: cacheFormat, ...stored } })), signal);
                for (const id of outcomes.removed) {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'outcomes', `${contentHash(id)}.json`), { force: true });}
                // Per-test coverage names its versions itself; restore checks them against the trace saved beside it.
                await this.publish('tests', tests.saved.map(({ groupId, records }) => ({ id: contentHash(groupId), value: encodeTests(groupId, records) })), signal);
                for (const id of tests.removed) {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'tests', `${contentHash(id)}.json`), { force: true });}
                await this.flush(signal);
                if (++this.writes % this.limits.maintenanceSaves === 0) {await this.maintain(signal);}
            } catch (error) {this.invalidateMaintenance(); throw error;}
        });
    }

    /** Each saved test file's per-test coverage, by test file ID. Records that are unreadable, of another format or larger than the
     * restore limit are skipped: those files narrow by test again once they have run completely. */
    async restoreTests(signal?: AbortSignal): Promise<Map<string, SavedTestCoverage>> {
        const directory = path.join(this.directory, 'tests'), restored = new Map<string, SavedTestCoverage>();
        let names: string[];
        try {names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));}
        catch (error) {signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return restored;} throw error;}
        let budget = this.limits.maxBytes;
        await mapConcurrent(names, 4, signal, async name => {
            const file = path.join(directory, name);
            try {
                const { size } = await fs.stat(file);
                if (size > budget) {return;}
                budget -= size;
                const value: unknown = JSON.parse(await fs.readFile(file, { encoding: 'utf8', signal }));
                if (recordFormat(value) !== 'current' || !validTestCoverage(value) || `${contentHash(value.groupId)}.json` !== name) {return;}
                restored.set(value.groupId, new Map(value.tests.map(([test, coverage]) => [test, coverage.map(entry => {
                    const [file, hash] = value.sources[entry[0]!]!, hits = new Map<number, number>();
                    for (let position = 1; position < entry.length; position += 2) {hits.set(entry[position]!, entry[position + 1]!);}
                    return { file, hash, hits };
                })])));
            } catch {signal?.throwIfAborted();}
        });
        return restored;
    }

    /** The file and version of every source the delta's traces use: the delta carries them, or an earlier save wrote them. */
    private async sourcesOf(delta: CoverageDelta, signal?: AbortSignal): Promise<ReadonlyMap<string, Pick<CoverageSource, 'file' | 'hash'>>> {
        const known = new Map<string, Pick<CoverageSource, 'file' | 'hash'>>(delta.sources.map(source => [source.id, source]));
        for (const trace of delta.traces) {
            for (const id of trace.sourceIds) {
                if (known.has(id)) {continue;}
                let source: Pick<CoverageSource, 'file' | 'hash'> | undefined = this.knownSources.get(id)
                    ?? trace.coverage.find(file => contentHash(`${file.file}\0${file.hash}`) === id);
                if (!source) {
                    try {
                        const value: unknown = JSON.parse(await fs.readFile(path.join(this.directory, 'sources', `${id}.json`), { encoding: 'utf8', signal }));
                        if (validSource(value)) {source = value;}
                    } catch {signal?.throwIfAborted();}
                }
                if (!source) {throw new Error(`The coverage cache has no source ${id} for ${trace.groupId}.`);}
                known.set(id, source);
            }
        }
        return known;
    }

    private encode(trace: StoredTrace, table: Table, sources: ReadonlyMap<string, Pick<CoverageSource, 'file' | 'hash'>>): TraceRecord {
        const positions = new Map<string, number>();
        const versions = trace.sourceIds.map((id, position) => {
            const source = sources.get(id)!, key = `${source.file}\0${source.hash}`;
            if (!positions.has(key)) {positions.set(key, position);}
            return table.version(source.file, source.hash);
        });
        return { format: cacheFormat, table: table.generation, groupId: trace.groupId, ...trace.identity === undefined ? {} : { identity: trace.identity },
            sources: versions, dependencies: trace.dependencies.map(file => table.string(file)),
            ...trace.moduleProjects ? { moduleProjects: trace.moduleProjects.map(project => table.string(project)) } : {},
            inputs: Object.entries(trace.inputs ?? {}).map(([file, hash]) => table.version(file, hash)),
            // Contributions outside sourceIds cannot be restored, so they are not saved.
            coverage: trace.coverage.flatMap(file => {
                const position = positions.get(`${file.file}\0${file.hash}`);
                if (position === undefined) {return [];}
                const values = [position];
                for (const line of file.lines) {values.push(line.line, line.hits);}
                return [values];
            }),
            reliable: trace.reliable, ...trace.stale === undefined ? {} : { stale: trace.stale }, ...trace.historical === undefined ? {} : { historical: trace.historical },
            timestamp: trace.timestamp };
    }

    private encodeCheckpoint(checkpoint: SavedCheckpoint, table: Table): CheckpointRecord {
        // An unknown shape is simply not saved: a change to that file stays conservative.
        return { format: cacheFormat, table: table.generation, identity: checkpoint.identity, completed: checkpoint.completed.map(id => table.string(id)),
            versions: Array.from(checkpoint.versions, ([file, hash]) => table.version(file, hash)),
            shapes: [...checkpoint.shapes].flatMap(([file, shape]) => shape === null ? [] : [table.version(file, shape)]),
            ...checkpoint.untracked ? { untracked: [...checkpoint.untracked] } : {}, ...checkpoint.pending ? { pending: [...checkpoint.pending] } : {},
            ...checkpoint.toolchain === undefined ? {} : { toolchain: checkpoint.toolchain } };
    }

    /** The current generation's table, read again because another writer may have extended it. Anything doubtful starts a new generation. */
    private async loadTable(signal?: AbortSignal): Promise<Table> {
        const root = path.join(this.directory, 'tables');
        let pointer: unknown;
        try {pointer = JSON.parse(await fs.readFile(path.join(root, 'current.json'), { encoding: 'utf8', signal }));}
        catch {signal?.throwIfAborted();}
        if (!validPointer(pointer) || recordFormat(pointer) !== 'current') {return this.newTable(signal);}
        try {
            const names = (await fs.readdir(path.join(root, pointer.generation))).filter(name => /^\d{12}\.json$/.test(name)).sort();
            const entries: TableEntry[] = [];
            for (const name of names) {
                signal?.throwIfAborted();
                const value: unknown = JSON.parse(await fs.readFile(path.join(root, pointer.generation, name), { encoding: 'utf8', signal }));
                const start = Number(name.slice(0, 12));
                if (start !== entries.length || recordFormat(value) !== 'current' || !validSegment(value, start)
                    || value.entries.some(entry => typeof entry !== 'string' && typeof (entry[0] < start ? entries[entry[0]] : value.entries[entry[0] - start]) !== 'string')) {
                    return await this.newTable(signal);
                }
                entries.push(...value.entries);
            }
            return new Table(pointer.generation, entries);
        } catch {signal?.throwIfAborted(); return this.newTable(signal);}
    }

    /** Saves extend a new, empty generation from now on; traces naming older generations stay readable. */
    private async newTable(signal?: AbortSignal): Promise<Table> {
        const table = new Table(randomUUID());
        await fs.mkdir(path.join(this.directory, 'tables', table.generation), { recursive: true });
        await this.write('tables', 'current', { format: cacheFormat, generation: table.generation }, signal);
        return table;
    }

    /** Append the entries interned since the last segment as one immutable segment. */
    private async writeSegment(table: Table, signal?: AbortSignal): Promise<void> {
        if (table.persisted === table.entries.length) {return;}
        const start = table.persisted;
        await fs.mkdir(path.join(this.directory, 'tables', table.generation), { recursive: true });
        await this.write(path.join('tables', table.generation), segmentName(start), { format: cacheFormat, start, entries: table.entries.slice(start) }, signal);
        table.persisted = table.entries.length;
    }

    /** Rewrite every trace and the checkpoint into a new table generation when the current one is mostly garbage, then delete the
     * old generations. A crash part way leaves traces in both generations, each still valid; nothing is lost. */
    private async compact(snapshot: CacheContents, signal?: AbortSignal): Promise<void> {
        const table = this.table = await this.newTable(signal);
        const sources = new Map(snapshot.sources.map(source => [source.id, source]));
        const records = snapshot.traces.map(trace => this.encode(trace, table, sources));
        const checkpoint = snapshot.checkpoint && this.encodeCheckpoint(snapshot.checkpoint, table);
        await this.writeSegment(table, signal); await this.flush(signal);
        await this.publish('traces', records.map(record => ({ id: contentHash(record.groupId), value: record })), signal);
        await this.flush(signal);
        // Keep each trace's age, which orders eviction.
        await mapConcurrent(records, 8, signal, async (record, position) => {
            const time = snapshot.stats[position]?.mtimeMs;
            if (time !== undefined) {await fs.utimes(path.join(this.directory, 'traces', `${contentHash(record.groupId)}.json`), time / 1000, time / 1000).catch(() => undefined);}
        });
        if (checkpoint) {await this.write('checkpoint', 'checkpoint', checkpoint, signal); await this.flush(signal);}
        for (const generation of Object.keys(snapshot.tables)) {
            if (generation !== table.generation) {signal?.throwIfAborted(); await fs.rm(path.join(this.directory, 'tables', generation), { recursive: true, force: true });}
        }
        this.output(`Compacted the coverage cache: ${records.length} traces.\n`);
    }

    /** Delete earlier formats' directories, each under its own lock so a window still running an older Testy is not cut off mid-write. */
    private async removeLegacy(signal?: AbortSignal): Promise<void> {
        for (const name of legacyCacheDirectories) {
            const directory = path.join(this.storage, name);
            try {
                await fs.access(directory);
                await withLock(`${directory}.lock`, signal, () => fs.rm(directory, { recursive: true, force: true }), { timeoutMs: lockTiming.cleanupWaitMs });
                this.output(`Removed the coverage cache of an earlier Testy version (${name}).\n`);
            } catch (error) {
                signal?.throwIfAborted();
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {this.output(`Unable to remove the earlier coverage cache ${name}: ${String(error)}\n`);}
            }
        }
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
        if (!previous || lines.length !== previous.lines.length || declarations !== previous.declarations) {await this.write('sources', source.id, { format: cacheFormat, ...merged }, signal);}
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
        if (!current || current !== this.epoch) {this.knownSources.clear(); this.invalidateMaintenance(); this.table = undefined;}
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
                // Unused table generations are directories.
                await fs.rm(path.join(this.directory, name), { recursive: true, force: true });
                if (name.startsWith('sources/')) {this.knownSources.delete(name.slice('sources/'.length, -'.json'.length));}
            } catch (error) {signal?.throwIfAborted(); complete = false; this.output(`Unable to remove coverage cache entry ${name}: ${String(error)}\n`);}
        }
        return complete;
    }

    /** Every `maintenanceSaves` saves: reread the cache only when what it holds is unknown. */
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
        const staged = await this.stage(kind, id, value, signal, durable);
        try {signal?.throwIfAborted(); await fs.rename(staged.temporary, staged.destination);}
        finally {await fs.rm(staged.temporary, { force: true });}
        if (durable) {this.unsynced.add(path.dirname(staged.destination));}
        return staged.bytes;
    }

    /** Write records concurrently, each synced, then rename them in order: a list may repeat a record, and a failure leaves
     * every earlier record published and no later one. `published` runs as each record is renamed. */
    private async publish(kind: string, records: readonly { readonly id: string; readonly value: unknown; readonly published?: (bytes: number) => void }[], signal?: AbortSignal): Promise<void> {
        if (!records.length) {return;}
        const staged: ({ readonly temporary: string; readonly destination: string; readonly bytes: number } | { readonly error: unknown } | undefined)[] = [];
        let next = 0, failed = records.length;
        await Promise.all(Array.from({ length: Math.min(8, records.length) }, async () => {
            for (let position = next++; position < failed; position = next++) {
                const { id, value } = records[position]!;
                try {staged[position] = await this.stage(kind, id, value, signal);}
                catch (error) {staged[position] = { error }; failed = Math.min(failed, position);}
            }
        }));
        try {
            for (const [position, record] of records.entries()) {
                const item = staged[position];
                if (!item) {break;}
                if ('error' in item) {throw item.error;}
                signal?.throwIfAborted(); await fs.rename(item.temporary, item.destination);
                this.unsynced.add(path.dirname(item.destination)); record.published?.(item.bytes);
            }
        } finally {await Promise.all(staged.map(item => item && 'temporary' in item ? fs.rm(item.temporary, { force: true }) : Promise.resolve()));}
    }

    /** Write a record's data to a temporary file beside its destination; a durable one is synced. */
    private async stage(kind: string, id: string, value: unknown, signal?: AbortSignal, durable = true): Promise<{ temporary: string; destination: string; bytes: number }> {
        signal?.throwIfAborted();
        const destination = path.join(this.directory, kind, `${id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        let handle: fs.FileHandle | undefined, bytes = 0, staged = false;
        try {
            handle = await fs.open(temporary, 'w');
            for (const chunk of jsonChunks(value)) {signal?.throwIfAborted(); await handle.writeFile(chunk); bytes += Buffer.byteLength(chunk);}
            // The data must be durable before the rename can make it the record.
            if (durable) {await handle.sync();}
            await handle.close(); handle = undefined; staged = true;
            return { temporary, destination, bytes };
        }
        finally { await handle?.close(); if (!staged) {await fs.rm(temporary, { force: true });} }
    }
}

/** A test file's per-test coverage as saved: only the lines that ran, since restore rebuilds the rest from each version's geometry. */
function encodeTests(groupId: string, records: ReadonlyMap<string, readonly FileCoverage[]>): TestCoverageRecord {
    const sources: [string, string][] = [], positions = new Map<string, number>();
    const source = (file: string, hash: string): number => {
        const key = `${file}\0${hash}`;
        let position = positions.get(key);
        if (position === undefined) {position = sources.length; sources.push([file, hash]); positions.set(key, position);}
        return position;
    };
    const tests = [...records].map(([test, coverage]) => [test, coverage.map(entry => [source(entry.file, entry.hash),
        ...entry.lines.flatMap(line => line.hits > 0 ? [line.line, line.hits] : [])])] as const);
    return { format: cacheFormat, groupId, sources, tests };
}
