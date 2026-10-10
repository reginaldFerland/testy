import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { CoverageSource, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';
import { CacheLimits, defaultCacheLimits, validSource, validTrace } from './cacheFormat';
import { mapConcurrent } from '../core/concurrency';

export interface CacheSnapshot {
    readonly sources: readonly (Omit<CoverageSource, 'lines'> & { lines: Float64Array })[];
    readonly traces: readonly (Omit<StoredTrace, 'coverage' | 'sourceIds'> & { sourceIds: Uint32Array; coverage: readonly { file: string; hash: string; values: Float64Array }[] })[];
    /** File size and modification time per trace, in trace order. */
    readonly stats: readonly { readonly bytes: number; readonly mtimeMs: number }[];
    readonly warnings: readonly string[];
    /** Records that can never be valid (cache-relative paths). The caller removes them. */
    readonly corrupt: readonly string[];
    /** The oldest traces beyond the limits (cache-relative paths), left unread. */
    readonly evicted: readonly string[];
    /** False when anything unreadable might hold references the snapshot cannot see. */
    readonly complete: boolean;
}

type Outcome = { readonly value: unknown } | { readonly corrupt: true } | { readonly warning: string };

async function read(directory: string, limits: CacheLimits): Promise<CacheSnapshot> {
    const warnings: string[] = [];
    let complete = true;
    type Inventory = { readonly kind: string; readonly names: readonly string[]; readonly warning: string | undefined };
    const list = async (kind: string): Promise<Inventory> => {
        try {return { kind, names: (await fs.readdir(path.join(directory, kind))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)), warning: undefined };}
        catch (error) {
            return { kind, names: [], warning: (error as NodeJS.ErrnoException).code !== 'ENOENT' ? `Unable to read the coverage cache: ${String(error)}` : undefined };
        }
    };
    const [sourceInventory, traceInventory] = await Promise.all([list('sources'), list('traces')]);
    // Keep the newest traces within the limits. Order is otherwise inventory order.
    const aged = await mapConcurrent(traceInventory.names, 16, undefined, async name => {
        try {const stat = await fs.stat(path.join(directory, 'traces', name)); return { name, bytes: stat.size, mtimeMs: stat.mtimeMs };}
        catch {return { name, bytes: 0, mtimeMs: 0 };}
    });
    const kept = new Set<string>(), evicted: string[] = [];
    let used = 0, full = false;
    for (const item of [...aged].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1))) {
        full ||= kept.size >= limits.maxTraces || used + item.bytes > limits.maxBytes;
        if (full) {evicted.push(`traces/${item.name}`);} else {kept.add(item.name); used += item.bytes;}
    }
    const stats = new Map(aged.map(item => [item.name, { bytes: item.bytes, mtimeMs: item.mtimeMs }]));
    const traceTable: Inventory = { ...traceInventory, names: traceInventory.names.filter(name => kept.has(name)) }, tables = [sourceInventory, traceTable];
    // One small pool spans both tables. Preserve inventory order, including
    // warnings, without creating a pending read for every record. No size cutoff:
    // every entry this version writes must be readable.
    const records = await mapConcurrent(tables.flatMap(({ kind, names }) => names.map(name => ({ kind, name }))), 4, undefined, async ({ kind, name }): Promise<Outcome> => {
        let contents: string;
        try {contents = await fs.readFile(path.join(directory, kind, name), 'utf8');}
        catch {return { warning: `Ignoring an unreadable coverage cache entry: ${name}` };}
        try {return { value: JSON.parse(contents) as unknown };}
        catch {return { corrupt: true };}
    });
    const corrupt: string[] = [];
    // collect() sets unreadableSources; `as boolean` keeps the later read from narrowing to false.
    let offset = 0, unreadableSources = false as boolean;
    const collect = (table: Inventory, sources: boolean): { readonly name: string; readonly value: unknown }[] => {
        if (table.warning) {warnings.push(table.warning); complete = false; if (sources) {unreadableSources = true;}}
        const values: { readonly name: string; readonly value: unknown }[] = [];
        for (const name of table.names) {
            // records holds exactly one outcome per table name, in table order.
            const record = records[offset++]!;
            if ('warning' in record) {warnings.push(record.warning); complete = false; if (sources) {unreadableSources = true;}}
            else if ('corrupt' in record) {warnings.push(`Discarding a corrupt coverage cache entry: ${name}`); corrupt.push(`${table.kind}/${name}`);}
            else {values.push({ name, value: record.value });}
        }
        return values;
    };
    const sourceValues = collect(sourceInventory, true), traceValues = collect(traceTable, false);
    // A record in the wrong file would be duplicated by the next save of its identity.
    const sourceIssues: string[] = [], malformed: string[] = [], dangling: string[] = [];
    const sources = sourceValues.filter(({ name, value }) => validSource(value) && name === `${value.id}.json` || (sourceIssues.push(name), false));
    const byId = new Map(sources.map(({ value }) => [(value as CoverageSource).id, new Set((value as CoverageSource).lines)]));
    const sourceIndex = new Map(sources.map(({ value }, index) => [(value as CoverageSource).id, index]));
    const traceRecords = traceValues.filter(({ name, value }) => validTrace(value) && name === `${contentHash(value.groupId)}.json` || (malformed.push(name), false));
    // References depend on every source being visible; otherwise leave the trace alone.
    const resolved = traceRecords.filter(({ name, value }) => {
        const trace = value as StoredTrace;
        return trace.sourceIds.every(id => byId.has(id)) && trace.coverage.every(file => {
            const lines = byId.get(contentHash(`${file.file}\0${file.hash}`));
            return !!lines && file.lines.every(line => lines.has(line.line));
        }) || (dangling.push(name), false);
    });
    const discard = (table: string, names: readonly string[]): void => {
        for (const name of names) {corrupt.push(`${table}/${name}`); warnings.push(`Discarding a corrupt coverage cache entry: ${name}`);}
    };
    discard('sources', sourceIssues); discard('traces', malformed);
    if (!unreadableSources) {discard('traces', dangling);}
    else if (dangling.length) {warnings.push('Ignoring invalid coverage cache records; preserving source geometry until the cache is fully readable.');}
    if (evicted.length) {warnings.push(`Discarding the ${evicted.length} oldest coverage cache traces beyond the restore limit.`);}
    const traces = resolved.map(item => item.value as StoredTrace);
    return { warnings, complete, corrupt, evicted, stats: resolved.map(({ name }) => stats.get(name)!),
        sources: sources.map(({ value }) => ({ ...(value as CoverageSource), lines: Float64Array.from([...byId.get((value as CoverageSource).id)!].sort((a, b) => a - b)) })),
        traces: traces.map(trace => ({ ...trace, sourceIds: Uint32Array.from(trace.sourceIds.map(id => sourceIndex.get(id)!)), coverage: trace.coverage.map(file => {
            const values = new Float64Array(file.lines.length * 2);
            file.lines.forEach((line, index) => {values[index * 2] = line.line; values[index * 2 + 1] = line.hits;});
            return { file: file.file, hash: file.hash, values };
        }) })) };
}

const input = workerData as string | { directory: string; limits: CacheLimits };
void (typeof input === 'string' ? read(input, defaultCacheLimits) : read(input.directory, input.limits)).then(snapshot => parentPort!.postMessage(snapshot,
    [...snapshot.sources.map(source => source.lines.buffer), ...snapshot.traces.flatMap(trace => [trace.sourceIds.buffer, ...trace.coverage.map(file => file.values.buffer)])] as ArrayBuffer[]))
    .catch((error: unknown) => {throw error;});
