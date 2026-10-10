import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { CoverageSource } from '../core/coverage';
import { contentHash } from '../core/paths';
import { StoredOutcomes } from '../core/runPolicy';
import { CacheLimits, CheckpointRecord, defaultCacheLimits, recordFormat, TableEntry, TraceRecord, validCheckpoint, validOutcomes, validPointer, validSegment,
    validSource, validTraceRecord } from './cacheFormat';
import { mapConcurrent } from '../core/concurrency';

/** A trace with its table references resolved to positions: `sourceIds` and each coverage `source` index `sources`; the
 * other arrays index the entries of `tables[table]`. */
export interface PackedTrace extends Omit<TraceRecord, 'format' | 'sources' | 'dependencies' | 'moduleProjects' | 'inputs' | 'coverage'> {
    readonly sourceIds: Uint32Array; readonly dependencies: Uint32Array; readonly moduleProjects?: Uint32Array | undefined; readonly inputs: Uint32Array;
    readonly coverage: readonly { readonly source: number; readonly values: Float64Array }[];
}
export interface CacheSnapshot {
    readonly sources: readonly (Omit<CoverageSource, 'lines'> & { lines: Float64Array })[];
    readonly traces: readonly PackedTrace[];
    /** Table entries by generation, for the generations the traces, the checkpoint and the pointer name. */
    readonly tables: Readonly<Record<string, readonly TableEntry[]>>;
    /** The generation saves extend, while its table is intact. */
    readonly generation: string | undefined;
    /** The table has grown far beyond what the traces use; rewriting everything into a new generation pays off. */
    readonly compact: boolean;
    readonly checkpoint: (Omit<CheckpointRecord, 'format' | 'completed' | 'versions' | 'shapes'> & { readonly completed: Uint32Array; readonly versions: Uint32Array; readonly shapes: Uint32Array }) | undefined;
    /** The latest test outcomes by file, independent of the traces and limits. */
    readonly outcomes: readonly StoredOutcomes[];
    /** File size and modification time per trace, in trace order. */
    readonly stats: readonly { readonly bytes: number; readonly mtimeMs: number }[];
    readonly warnings: readonly string[];
    /** Records that can never be valid (cache-relative paths), including table generations nothing uses. The caller removes them. */
    readonly corrupt: readonly string[];
    /** The oldest traces beyond the limits (cache-relative paths), left unread. */
    readonly evicted: readonly string[];
    /** False when anything unreadable might hold references the snapshot cannot see. */
    readonly complete: boolean;
}

type Outcome = { readonly value: unknown } | { readonly corrupt: true } | { readonly warning: string };

/** No record this version writes comes near this; a larger file is foreign or damaged, and reading it whole could exhaust the worker. */
const maxRecordBytes = 128 * 1024 * 1024;
const generationName = /^[a-f0-9-]{36}$/, segmentName = /^\d{12}\.json$/;

/** Read one record. An unreadable or oversized one is left in place (a warning, not corruption), and so is one of another format. */
async function readRecord(file: string, name: string): Promise<Outcome> {
    let contents: string;
    try {
        const size = (await fs.stat(file)).size;
        if (size > maxRecordBytes) {return { warning: `Ignoring an oversized coverage cache entry: ${name} (${size} bytes; the limit is ${maxRecordBytes}).` };}
        contents = await fs.readFile(file, 'utf8');
    } catch {return { warning: `Ignoring an unreadable coverage cache entry: ${name}` };}
    let value: unknown;
    try {value = JSON.parse(contents);}
    catch {return { corrupt: true };}
    const format = recordFormat(value);
    return format === 'current' ? { value } : format === 'foreign' ? { warning: `Ignoring a coverage cache entry of another format: ${name}` } : { corrupt: true };
}

/** A record's content: what it holds without the format it was written in. */
function withoutFormat<T extends object>(value: T): T {
    const copy: Partial<Record<string, unknown>> = { ...value as Record<string, unknown> }; delete copy.format; return copy as T;
}

/** One table generation: its contiguous entries; whether they are all of it (nothing unreadable, damaged or missing), and
 * whether everything could be read, so that what is missing is known to be gone rather than temporarily unreadable. */
interface Table { readonly entries: TableEntry[]; intact: boolean; readable: boolean; segments: number; readonly ids: Map<number, string> }

async function readTables(directory: string, warnings: string[], corrupt: string[]): Promise<{ tables: Map<string, Table>; pointer: string | undefined; readable: boolean }> {
    const root = path.join(directory, 'tables'), tables = new Map<string, Table>();
    let names: string[] = [], readable = true, pointer: string | undefined;
    try {names = await fs.readdir(root);}
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {warnings.push(`Unable to read the coverage cache: ${String(error)}`); readable = false;}
        return { tables, pointer, readable };
    }
    if (names.includes('current.json')) {
        const read = await readRecord(path.join(root, 'current.json'), 'current.json');
        if ('value' in read && validPointer(read.value)) {pointer = read.value.generation;}
        else if ('warning' in read) {warnings.push(read.warning);}
    }
    await mapConcurrent(names.filter(name => generationName.test(name)), 4, undefined, async generation => {
        const table: Table = { entries: [], intact: true, readable: true, segments: 0, ids: new Map() };
        tables.set(generation, table);
        let segments: string[];
        try {segments = (await fs.readdir(path.join(root, generation))).filter(name => segmentName.test(name)).sort();}
        catch {warnings.push(`Ignoring an unreadable coverage cache entry: tables/${generation}`); table.intact = table.readable = false; return;}
        table.segments = segments.length;
        const records = await mapConcurrent(segments, 4, undefined, name => readRecord(path.join(root, generation, name), name));
        // Entries are usable up to the first gap; whatever follows cannot be placed. Saves never extend a broken table.
        segments.forEach((name, position) => {
            const read = records[position]!, start = Number(name.slice(0, 12));
            if ('warning' in read) {warnings.push(read.warning); table.intact = table.readable = false; return;}
            if (!table.intact) {return;}
            const entries = 'value' in read && validSegment(read.value, start) ? read.value.entries : undefined;
            if (!entries || entries.some(entry => typeof entry !== 'string' && typeof (entry[0] < start ? table.entries[entry[0]] : entries[entry[0] - start]) !== 'string')) {
                warnings.push(`Discarding a corrupt coverage cache entry: ${name}`); corrupt.push(`tables/${generation}/${name}`); table.intact = false; return;
            }
            // A missing earlier segment (removed as corrupt) is a permanent gap.
            if (start !== table.entries.length) {table.intact = false; return;}
            table.entries.push(...entries);
        });
    });
    return { tables, pointer, readable };
}

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
    const [sourceInventory, traceInventory, outcomeInventory] = await Promise.all([list('sources'), list('traces'), list('outcomes')]);
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
    const traceTable: Inventory = { ...traceInventory, names: traceInventory.names.filter(name => kept.has(name)) }, inventories = [sourceInventory, traceTable];
    // One small pool spans both record kinds. Preserve inventory order, including
    // warnings, without creating a pending read for every record. No size cutoff:
    // every entry this version writes must be readable.
    const records = await mapConcurrent(inventories.flatMap(({ kind, names }) => names.map(name => ({ kind, name }))), 4, undefined, ({ kind, name }) => readRecord(path.join(directory, kind, name), name));
    const corrupt: string[] = [];
    // collect() sets unreadableSources; `as boolean` keeps the later read from narrowing to false.
    let offset = 0, unreadableSources = false as boolean;
    const collect = (inventory: Inventory, sources: boolean): { readonly name: string; readonly value: unknown }[] => {
        if (inventory.warning) {warnings.push(inventory.warning); complete = false; if (sources) {unreadableSources = true;}}
        const values: { readonly name: string; readonly value: unknown }[] = [];
        for (const name of inventory.names) {
            // records holds exactly one outcome per inventory name, in inventory order.
            const record = records[offset++]!;
            if ('warning' in record) {warnings.push(record.warning); complete = false; if (sources) {unreadableSources = true;}}
            else if ('corrupt' in record) {warnings.push(`Discarding a corrupt coverage cache entry: ${name}`); corrupt.push(`${inventory.kind}/${name}`);}
            else {values.push({ name, value: record.value });}
        }
        return values;
    };
    const sourceValues = collect(sourceInventory, true), traceValues = collect(traceTable, false);
    const { tables, pointer, readable } = await readTables(directory, warnings, corrupt);
    if (!readable) {complete = false;}
    // A record in the wrong file would be duplicated by the next save of its identity.
    const sourceIssues: string[] = [], malformed: string[] = [], dangling: string[] = [];
    const sources = sourceValues.filter(({ name, value }) => validSource(value) && name === `${value.id}.json` || (sourceIssues.push(name), false))
        .map(({ value }) => withoutFormat(value as CoverageSource));
    const byId = new Map(sources.map(source => [source.id, new Set(source.lines)]));
    const sourceIndex = new Map(sources.map((source, index) => [source.id, index]));
    const traceRecords = traceValues.filter(({ name, value }) => validTraceRecord(value) && name === `${contentHash(value.groupId)}.json` || (malformed.push(name), false));
    // Entries a reference may name: a string, or a version whose file is a string (segments guarantee the latter).
    const entry = (table: Table, position: number, kind: 'string' | 'version'): boolean => {
        const value = table.entries[position];
        return kind === 'string' ? typeof value === 'string' : Array.isArray(value);
    };
    /** The source a version entry describes, by its position in `sources`. */
    const sourceOf = (table: Table, position: number): number | undefined => {
        let id = table.ids.get(position);
        if (id === undefined) {
            const version = table.entries[position];
            if (!Array.isArray(version)) {return undefined;}
            id = contentHash(`${table.entries[version[0] as number] as string}\0${version[1] as string}`); table.ids.set(position, id);
        }
        return sourceIndex.get(id);
    };
    const traces: PackedTrace[] = [], marked = new Map<string, Set<number>>(), referenced = new Set<string>();
    const resolvedNames: string[] = [];
    for (const { name, value } of traceRecords) {
        const trace = value as TraceRecord, table = tables.get(trace.table);
        referenced.add(trace.table);
        const positions = table ? trace.sources.map(position => sourceOf(table, position)) : [];
        // References depend on every source and table entry being visible; otherwise leave the trace alone.
        const valid = !!table && positions.every(position => position !== undefined)
            && trace.dependencies.every(position => entry(table, position, 'string')) && (trace.moduleProjects ?? []).every(position => entry(table, position, 'string'))
            && trace.inputs.every(position => entry(table, position, 'version'))
            && trace.coverage.every(file => {
                const lines = byId.get(sources[positions[file[0]!]!]!.id)!;
                for (let position = 1; position < file.length; position += 2) {if (!lines.has(file[position]!)) {return false;}}
                return true;
            });
        if (!valid) {dangling.push(name); continue;}
        const marks = marked.get(trace.table) ?? new Set<number>(); marked.set(trace.table, marks);
        for (const position of [...trace.sources, ...trace.dependencies, ...trace.moduleProjects ?? [], ...trace.inputs]) {
            marks.add(position); const version = table.entries[position]; if (Array.isArray(version)) {marks.add(version[0] as number);}
        }
        resolvedNames.push(name);
        traces.push({ groupId: trace.groupId, table: trace.table, ...trace.identity === undefined ? {} : { identity: trace.identity },
            reliable: trace.reliable, ...trace.stale === undefined ? {} : { stale: trace.stale }, ...trace.historical === undefined ? {} : { historical: trace.historical },
            timestamp: trace.timestamp, sourceIds: Uint32Array.from(positions), dependencies: Uint32Array.from(trace.dependencies),
            ...trace.moduleProjects ? { moduleProjects: Uint32Array.from(trace.moduleProjects) } : {}, inputs: Uint32Array.from(trace.inputs),
            coverage: trace.coverage.map(file => ({ source: positions[file[0]!]!, values: Float64Array.from(file.slice(1)) })) });
    }
    const discard = (kind: string, names: readonly string[]): void => {
        for (const name of names) {corrupt.push(`${kind}/${name}`); warnings.push(`Discarding a corrupt coverage cache entry: ${name}`);}
    };
    discard('sources', sourceIssues); discard('traces', malformed);
    const unreadableTables = !readable || [...tables.values()].some(table => !table.readable);
    if (!unreadableSources && !unreadableTables) {discard('traces', dangling);}
    else if (dangling.length) {warnings.push('Ignoring invalid coverage cache records; preserving source geometry until the cache is fully readable.');}
    if (evicted.length) {warnings.push(`Discarding the ${evicted.length} oldest coverage cache traces beyond the restore limit.`);}
    let checkpoint: CacheSnapshot['checkpoint'];
    const saved = await readRecord(path.join(directory, 'checkpoint', 'checkpoint.json'), 'checkpoint.json');
    if ('value' in saved && validCheckpoint(saved.value)) {
        const value = saved.value, table = tables.get(value.table);
        referenced.add(value.table);
        if (table && value.completed.every(position => entry(table, position, 'string')) && [...value.versions, ...value.shapes].every(position => entry(table, position, 'version'))) {
            checkpoint = { table: value.table, identity: value.identity, completed: Uint32Array.from(value.completed), versions: Uint32Array.from(value.versions), shapes: Uint32Array.from(value.shapes),
                ...value.untracked ? { untracked: value.untracked } : {}, ...value.pending ? { pending: value.pending } : {}, ...value.toolchain === undefined ? {} : { toolchain: value.toolchain } };
            const marks = marked.get(value.table) ?? new Set<number>(); marked.set(value.table, marks);
            for (const position of [...value.completed, ...value.versions, ...value.shapes]) {marks.add(position); const version = table.entries[position]; if (Array.isArray(version)) {marks.add(version[0] as number);}}
        } else if (!unreadableTables) {discard('checkpoint', ['checkpoint.json']);}
    } else if ('corrupt' in saved || 'value' in saved) {discard('checkpoint', ['checkpoint.json']);}
    else if (!saved.warning.startsWith('Ignoring an unreadable')) {warnings.push(saved.warning);}
    // A missing checkpoint reads as unreadable; any other unreadable checkpoint simply trusts nothing.
    const current = pointer !== undefined && tables.get(pointer)?.intact ? pointer : undefined;
    if (current !== undefined) {referenced.add(current);}
    // Generations nothing references are garbage once every reference is known.
    if (complete && !unreadableSources && !unreadableTables) {for (const generation of tables.keys()) {if (!referenced.has(generation)) {corrupt.push(`tables/${generation}`);}}}
    const live = current === undefined ? undefined : tables.get(current)!;
    const compact = !!live && (live.segments > 256 || live.entries.length > limits.compactEntries && live.entries.length > 2 * (marked.get(current!)?.size ?? 0));
    // Outcomes reference nothing, so an unreadable one only goes missing; it never makes the snapshot incomplete.
    if (outcomeInventory.warning) {warnings.push(outcomeInventory.warning);}
    const outcomes: StoredOutcomes[] = [];
    const outcomeRecords = await mapConcurrent(outcomeInventory.names, 4, undefined, name => readRecord(path.join(directory, 'outcomes', name), name));
    outcomeInventory.names.forEach((name, index) => {
        const record = outcomeRecords[index]!;
        if ('warning' in record) {warnings.push(record.warning);}
        else if ('value' in record && validOutcomes(record.value) && name === `${contentHash(record.value.groupId)}.json`) {
            outcomes.push(withoutFormat(record.value));
        } else {corrupt.push(`outcomes/${name}`); warnings.push(`Discarding a corrupt coverage cache entry: ${name}`);}
    });
    return { warnings, complete, corrupt, evicted, outcomes, stats: resolvedNames.map(name => stats.get(name)!), checkpoint, generation: current, compact,
        tables: Object.fromEntries([...referenced].flatMap(generation => {const table = tables.get(generation); return table ? [[generation, table.entries]] : [];})),
        sources: sources.map(source => ({ ...source, lines: Float64Array.from([...byId.get(source.id)!].sort((a, b) => a - b)) })), traces };
}

const input = workerData as string | { directory: string; limits: CacheLimits };
void (typeof input === 'string' ? read(input, defaultCacheLimits) : read(input.directory, input.limits)).then(snapshot => parentPort!.postMessage(snapshot,
    [...snapshot.sources.map(source => source.lines.buffer), ...snapshot.traces.flatMap(trace => [trace.sourceIds.buffer, trace.dependencies.buffer, trace.inputs.buffer,
        ...trace.moduleProjects ? [trace.moduleProjects.buffer] : [], ...trace.coverage.map(file => file.values.buffer)]),
    ...snapshot.checkpoint ? [snapshot.checkpoint.completed.buffer, snapshot.checkpoint.versions.buffer, snapshot.checkpoint.shapes.buffer] : []] as ArrayBuffer[]))
    .catch((error: unknown) => {throw error;});
