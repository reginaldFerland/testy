import { scriptPath } from './assets';
import { Worker } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoverageSource, StoredTrace } from '../core/coverage';
import { CoveredLine } from '../core/model';
import type { CacheSnapshot } from './cacheWorker';
import { CacheLimits, defaultCacheLimits, SavedCheckpoint, TableEntry } from './cacheFormat';

export type CacheContents = Pick<CacheSnapshot, 'outcomes' | 'stats' | 'warnings' | 'corrupt' | 'evicted' | 'complete' | 'generation' | 'compact' | 'tables'>
    & { sources: CoverageSource[]; traces: StoredTrace[]; checkpoint: SavedCheckpoint | undefined };

/** Parsing and validation are interruptible even for dense, valid cache records. Paths resolve to one shared string per table entry. */
export async function readCache(directory: string, signal?: AbortSignal, limits: CacheLimits = defaultCacheLimits): Promise<CacheContents> {
    signal?.throwIfAborted();
    const worker = new Worker(scriptPath('cacheWorker'), { workerData: { directory, limits } });
    let abort = (): void => {};
    try {
        const snapshot = await new Promise<CacheSnapshot>((resolve, reject) => {
            abort = (): void => {reject(signal?.reason ?? new Error('Cache restore cancelled.')); void worker.terminate();};
            signal?.addEventListener('abort', abort, { once: true });
            worker.once('message', resolve); worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`The coverage cache reader exited before returning a snapshot (exit ${code}).`)));
            if (signal?.aborted) {abort();}
        });
        const sources: CoverageSource[] = [], traces: StoredTrace[] = [];
        let converted = 0;
        const step = async (): Promise<void> => {if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}};
        for (const source of snapshot.sources) {
            const lines: number[] = [];
            for (const line of source.lines) {await step(); lines.push(line);}
            sources.push({ ...source, lines });
        }
        const table = (generation: string): readonly TableEntry[] => {
            const entries = snapshot.tables[generation];
            if (!entries) {throw new Error('The coverage cache reader returned a trace with an unknown table.');}
            return entries;
        };
        const text = (entries: readonly TableEntry[], position: number): string => {
            const value = entries[position];
            if (typeof value !== 'string') {throw new Error('The coverage cache reader returned an invalid table reference.');}
            return value;
        };
        const version = (entries: readonly TableEntry[], position: number): readonly [string, string] => {
            const value = entries[position];
            if (!Array.isArray(value)) {throw new Error('The coverage cache reader returned an invalid table reference.');}
            return [text(entries, value[0] as number), value[1] as string];
        };
        for (const trace of snapshot.traces) {
            const entries = table(trace.table), sourceIds: string[] = [], dependencies: string[] = [], inputs: Record<string, string> = {};
            for (const index of trace.sourceIds) {
                await step();
                const source = sources[index];
                if (!source) {throw new Error('The coverage cache reader returned a trace with an unknown source.');}
                sourceIds.push(source.id);
            }
            for (const position of trace.dependencies) {await step(); dependencies.push(text(entries, position));}
            for (const position of trace.inputs) {await step(); const [file, hash] = version(entries, position); inputs[file] = hash;}
            const coverage = [];
            for (const file of trace.coverage) {
                const source = sources[file.source], lines: CoveredLine[] = [];
                if (!source) {throw new Error('The coverage cache reader returned a trace with an unknown source.');}
                // Values are (line, hits) pairs; the bound covers both reads.
                for (let index = 0; index + 1 < file.values.length; index += 2) {await step(); lines.push({ line: file.values[index]!, hits: file.values[index + 1]! });}
                coverage.push({ file: source.file, hash: source.hash, lines });
            }
            traces.push({ groupId: trace.groupId, reliable: trace.reliable, timestamp: trace.timestamp, sourceIds, dependencies, inputs, coverage,
                ...trace.identity === undefined ? {} : { identity: trace.identity }, ...trace.stale === undefined ? {} : { stale: trace.stale },
                ...trace.historical === undefined ? {} : { historical: trace.historical },
                ...trace.moduleProjects ? { moduleProjects: Array.from(trace.moduleProjects, position => text(entries, position)) } : {} });
        }
        let checkpoint: SavedCheckpoint | undefined;
        if (snapshot.checkpoint) {
            const entries = table(snapshot.checkpoint.table), versions = new Map<string, string>(), shapes = new Map<string, string | null>();
            for (const position of snapshot.checkpoint.versions) {await step(); const [file, hash] = version(entries, position); versions.set(file, hash);}
            for (const position of snapshot.checkpoint.shapes) {await step(); const [file, shape] = version(entries, position); shapes.set(file, shape);}
            const { untracked, pending, toolchain } = snapshot.checkpoint;
            checkpoint = { identity: snapshot.checkpoint.identity, completed: Array.from(snapshot.checkpoint.completed, position => text(entries, position)), versions, shapes,
                ...untracked ? { untracked: new Map(untracked) } : {}, ...pending ? { pending } : {}, ...toolchain === undefined ? {} : { toolchain } };
        }
        signal?.throwIfAborted();
        return { sources, traces, checkpoint, outcomes: snapshot.outcomes, stats: snapshot.stats, warnings: snapshot.warnings, corrupt: snapshot.corrupt,
            evicted: snapshot.evicted, complete: snapshot.complete, generation: snapshot.generation, compact: snapshot.compact, tables: snapshot.tables };
    } finally {signal?.removeEventListener('abort', abort); await worker.terminate();}
}
