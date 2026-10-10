import { scriptPath } from './assets';
import { Worker } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoverageSource, StoredTrace } from '../core/coverage';
import { CoveredLine } from '../core/model';
import type { CacheSnapshot } from './cacheWorker';
import { CacheLimits, defaultCacheLimits } from './cacheFormat';

export type CacheContents = Pick<CacheSnapshot, 'stats' | 'warnings' | 'corrupt' | 'evicted' | 'complete'> & { sources: CoverageSource[]; traces: StoredTrace[] };

/** Parsing and validation are interruptible even for dense, valid cache records. */
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
        for (const source of snapshot.sources) {
            const lines: number[] = [];
            for (const line of source.lines) {
                if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                lines.push(line);
            }
            sources.push({ ...source, lines });
        }
        for (const trace of snapshot.traces) {
            const sourceIds: string[] = [];
            for (const index of trace.sourceIds) {
                if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                const source = sources[index];
                if (!source) {throw new Error('The coverage cache reader returned a trace with an unknown source.');}
                sourceIds.push(source.id);
            }
            const coverage = [];
            for (const file of trace.coverage) {
                const lines: CoveredLine[] = [];
                // Values are (line, hits) pairs; the bound covers both reads.
                for (let index = 0; index + 1 < file.values.length; index += 2) {
                    if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                    lines.push({ line: file.values[index]!, hits: file.values[index + 1]! });
                }
                coverage.push({ file: file.file, hash: file.hash, lines });
            }
            traces.push({ ...trace, sourceIds, coverage });
        }
        signal?.throwIfAborted();
        return { sources, traces, stats: snapshot.stats, warnings: snapshot.warnings, corrupt: snapshot.corrupt, evicted: snapshot.evicted, complete: snapshot.complete };
    } finally {signal?.removeEventListener('abort', abort); await worker.terminate();}
}
