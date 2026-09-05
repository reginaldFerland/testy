import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { CoverageSource, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';
import { validSource, validTrace } from './cacheFormat';

export interface CacheSnapshot {
    readonly sources: readonly (Omit<CoverageSource, 'lines'> & { lines: Float64Array })[];
    readonly traces: readonly (Omit<StoredTrace, 'coverage' | 'sourceIds'> & { sourceIds: Uint32Array; coverage: readonly { file: string; hash: string; values: Float64Array }[] })[];
    readonly warnings: readonly string[];
    readonly complete: boolean;
}

async function read(directory: string): Promise<CacheSnapshot> {
    const warnings: string[] = [];
    const load = async (kind: string): Promise<unknown[]> => {
        const result: unknown[] = [];
        let names: string[];
        try {names = await fs.readdir(path.join(directory, kind));}
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {warnings.push(`Unable to read the coverage cache: ${String(error)}`);}
            return result;
        }
        // No size cutoff: every entry this version writes must be readable.
        for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
            try {result.push(JSON.parse(await fs.readFile(path.join(directory, kind, name), 'utf8')));}
            catch {warnings.push(`Ignoring an unreadable coverage cache entry: ${name}`);}
        }
        return result;
    };
    const sourceValues = await load('sources'), traceValues = await load('traces');
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
