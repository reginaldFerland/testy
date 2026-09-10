import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { CoverageSource, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';
import { validSource, validTrace } from './cacheFormat';
import { mapConcurrent } from '../core/concurrency';

export interface CacheSnapshot {
    readonly sources: readonly (Omit<CoverageSource, 'lines'> & { lines: Float64Array })[];
    readonly traces: readonly (Omit<StoredTrace, 'coverage' | 'sourceIds'> & { sourceIds: Uint32Array; coverage: readonly { file: string; hash: string; values: Float64Array }[] })[];
    readonly warnings: readonly string[];
    readonly complete: boolean;
}

async function read(directory: string): Promise<CacheSnapshot> {
    const warnings: string[] = [];
    const inventories = await Promise.all(['sources', 'traces'].map(async kind => {
        try {return { kind, names: (await fs.readdir(path.join(directory, kind))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) };}
        catch (error) {
            return { kind, names: [], warning: (error as NodeJS.ErrnoException).code !== 'ENOENT' ? `Unable to read the coverage cache: ${String(error)}` : undefined };
        }
    }));
    // One small pool spans both tables. Preserve inventory order, including
    // warnings, without creating a pending read for every record. No size cutoff:
    // every entry this version writes must be readable.
    const records = await mapConcurrent(inventories.flatMap(({ kind, names }) => names.map(name => ({ kind, name }))), 4, undefined, async ({ kind, name }) => {
        try {return { value: JSON.parse(await fs.readFile(path.join(directory, kind, name), 'utf8')) as unknown };}
        catch {return { warning: `Ignoring an unreadable coverage cache entry: ${name}` };}
    });
    let offset = 0;
    const [sourceValues, traceValues] = inventories.map(inventory => {
        if (inventory.warning) {warnings.push(inventory.warning);}
        const values: unknown[] = [];
        for (let index = 0; index < inventory.names.length; index++) {
            const record = records[offset++];
            if (record.warning) {warnings.push(record.warning);} else {values.push(record.value);}
        }
        return values;
    });
    const sources = sourceValues.filter(validSource);
    const byId = new Map(sources.map(source => [source.id, new Set(source.lines)]));
    const sourceIndex = new Map(sources.map((source, index) => [source.id, index]));
    const traces = traceValues.filter(validTrace).filter(trace => trace.sourceIds.every(id => byId.has(id))
        && trace.coverage.every(file => {
            const lines = byId.get(contentHash(`${file.file}\0${file.hash}`));
            return !!lines && file.lines.every(line => lines.has(line.line));
        }));
    if (sources.length !== sourceValues.length || traces.length !== traceValues.length) {warnings.push('Ignoring invalid coverage cache records; preserving source geometry until the cache is fully readable.');}
    return { warnings, complete: !warnings.length,
        sources: sources.map(source => ({ ...source, lines: Float64Array.from([...byId.get(source.id)!].sort((a, b) => a - b)) })),
        traces: traces.map(trace => ({ ...trace, sourceIds: Uint32Array.from(trace.sourceIds.map(id => sourceIndex.get(id)!)), coverage: trace.coverage.map(file => {
            const values = new Float64Array(file.lines.length * 2);
            file.lines.forEach((line, index) => {values[index * 2] = line.line; values[index * 2 + 1] = line.hits;});
            return { file: file.file, hash: file.hash, values };
        }) })) };
}

void read(workerData as string).then(snapshot => parentPort!.postMessage(snapshot,
    [...snapshot.sources.map(source => source.lines.buffer), ...snapshot.traces.flatMap(trace => [trace.sourceIds.buffer, ...trace.coverage.map(file => file.values.buffer)])] as ArrayBuffer[]))
    .catch(error => {throw error;});
