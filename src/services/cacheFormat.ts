import { CoverageSource } from '../core/coverage';
import { contentHash } from '../core/paths';
import { StoredOutcomes } from '../core/runPolicy';

/** The format of every record in the coverage cache. The directory carries it too, so a changed format starts a new
 * directory and never reads the old one; a record of another format found in this directory is left alone, unread. */
export const cacheFormat = 3;
export const cacheDirectory = `coverage-v${cacheFormat}`;
/** Earlier formats' directories, deleted once the current directory is established. */
export const legacyCacheDirectories: readonly string[] = ['coverage-v2'];

/** An interned string (a path or a test file ID), or a source version: an earlier string entry naming the file, and its hash. */
export type TableEntry = string | readonly [file: number, hash: string];
/** Tables only grow: each save appends one immutable segment of new entries, starting at `start`. A trace or checkpoint names
 * its table generation; restore starts a new generation when most entries are garbage (see CoverageCache.compact). */
export interface TableSegment { readonly format: number; readonly start: number; readonly entries: readonly TableEntry[] }
/** The current table generation, which saves extend. */
export interface TablePointer { readonly format: number; readonly generation: string }
/** A StoredTrace with every path and version replaced by a table entry. `sources` and `inputs` name versions (a source ID is
 * the hash of its version), `dependencies` and `moduleProjects` strings, and each `coverage` entry is its source's position in
 * `sources` followed by (line, hits) pairs. */
export interface TraceRecord {
    readonly format: number; readonly table: string; readonly groupId: string; readonly identity?: string | undefined;
    readonly sources: readonly number[]; readonly dependencies: readonly number[]; readonly moduleProjects?: readonly number[] | undefined;
    readonly inputs: readonly number[]; readonly coverage: readonly (readonly number[])[];
    readonly reliable: boolean; readonly stale?: boolean | undefined; readonly historical?: boolean | undefined; readonly timestamp: number;
}
/** What the saved traces can be trusted for after a restart: the identity they must have been learned under, the test files
 * whose saved state is complete, and the source versions that state accounts for; any other version is a change. `shapes`
 * holds the declaration shapes of those versions, as (file, shape) version entries; a change without one is conservative.
 * The few fields below are stored inline, not in the table: `untracked` holds (file, version) pairs of files the source
 * tracker does not hash (data outside every project, restored package assets), `pending` the changes no run has consumed
 * yet, and `toolchain` the SDK and evaluation tools the coverage was learned with. A checkpoint without them trusts less. */
export interface CheckpointRecord {
    readonly format: number; readonly table: string; readonly identity: string; readonly completed: readonly number[]; readonly versions: readonly number[]; readonly shapes: readonly number[];
    readonly untracked?: readonly (readonly [string, string])[] | undefined; readonly pending?: readonly string[] | undefined; readonly toolchain?: string | undefined;
}
/** A restored checkpoint: test file IDs, versions and declaration shapes by path, and the inline fields of CheckpointRecord. */
export interface SavedCheckpoint {
    readonly identity: string; readonly completed: readonly string[]; readonly versions: ReadonlyMap<string, string>; readonly shapes: ReadonlyMap<string, string | null>;
    readonly untracked?: ReadonlyMap<string, string> | undefined; readonly pending?: readonly string[] | undefined; readonly toolchain?: string | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const indices = (value: unknown): value is number[] => Array.isArray(value) && value.every(index);

/** `current` for a record of this format; `foreign` for another format's record, which is ignored but kept; otherwise corrupt. */
export function recordFormat(value: unknown): 'current' | 'foreign' | 'corrupt' {
    const format = record(value)?.format;
    return format === cacheFormat ? 'current' : typeof format === 'number' ? 'foreign' : 'corrupt';
}

export function validSource(value: unknown): value is CoverageSource {
    const source = record(value);
    return !!source && typeof source.id === 'string' && typeof source.file === 'string' && typeof source.hash === 'string'
        && source.id === contentHash(`${source.file}\0${source.hash}`) && Array.isArray(source.lines) && source.lines.every(positive)
        && (source.declarations === undefined || Array.isArray(source.declarations) && source.declarations.every(value => {
            const declaration = record(value);
            return !!declaration && typeof declaration.name === 'string' && positive(declaration.start) && positive(declaration.end) && declaration.start <= declaration.end;
        }));
}

/** A segment's version entries name strictly earlier entries; whether those are strings is checked once the table is assembled. */
export function validSegment(value: unknown, start: number): value is TableSegment {
    const segment = record(value);
    return !!segment && segment.start === start && Array.isArray(segment.entries) && segment.entries.every((entry: unknown, position) => typeof entry === 'string'
        || Array.isArray(entry) && entry.length === 2 && index(entry[0]) && entry[0] < start + position && typeof entry[1] === 'string');
}

export function validPointer(value: unknown): value is TablePointer {
    const pointer = record(value);
    return !!pointer && typeof pointer.generation === 'string' && /^[a-f0-9-]{36}$/.test(pointer.generation);
}

/** Structure only; references are resolved against the trace's table. */
export function validTraceRecord(value: unknown): value is TraceRecord {
    const trace = record(value);
    return !!trace && typeof trace.table === 'string' && typeof trace.groupId === 'string' && (trace.identity === undefined || typeof trace.identity === 'string')
        && indices(trace.sources) && indices(trace.dependencies) && (trace.moduleProjects === undefined || indices(trace.moduleProjects)) && indices(trace.inputs)
        && typeof trace.reliable === 'boolean' && (trace.stale === undefined || typeof trace.stale === 'boolean')
        && (trace.historical === undefined || typeof trace.historical === 'boolean') && typeof trace.timestamp === 'number' && Number.isFinite(trace.timestamp)
        && Array.isArray(trace.coverage) && trace.coverage.every((file: unknown) => {
            if (!Array.isArray(file) || file.length % 2 !== 1 || !index(file[0]) || file[0] >= (trace.sources as number[]).length) {return false;}
            for (let position = 1; position < file.length; position += 2) {
                const hits: unknown = file[position + 1];
                if (!positive(file[position]) || typeof hits !== 'number' || !Number.isFinite(hits) || hits <= 0) {return false;}
            }
            return true;
        });
}

export function validCheckpoint(value: unknown): value is CheckpointRecord {
    const checkpoint = record(value);
    return !!checkpoint && typeof checkpoint.table === 'string' && typeof checkpoint.identity === 'string' && indices(checkpoint.completed) && indices(checkpoint.versions)
        && indices(checkpoint.shapes) && (checkpoint.pending === undefined || strings(checkpoint.pending))
        && (checkpoint.toolchain === undefined || typeof checkpoint.toolchain === 'string')
        && (checkpoint.untracked === undefined || Array.isArray(checkpoint.untracked) && checkpoint.untracked.every((pair: unknown) => strings(pair) && pair.length === 2));
}

/** A file's latest test outcomes and run time; caches written before outcomes were saved have none, before run times were saved no `elapsed`, and before test durations were saved no `durations`. */
export function validOutcomes(value: unknown): value is StoredOutcomes {
    const outcomes = record(value);
    return !!outcomes && typeof outcomes.groupId === 'string'
        && Object.entries(outcomes).every(([key, value]) => key === 'groupId' || key === 'format'
            || key === 'elapsed' && typeof value === 'number' && Number.isFinite(value) && value >= 0
            || key === 'durations' && !!record(value) && Object.values(value as object).every(time => typeof time === 'number' && Number.isFinite(time) && time >= 0)
            || ['passed', 'failed', 'errored', 'skipped'].includes(key) && strings(value));
}

/** Bounds on what one restore loads; the oldest traces beyond them are discarded. Saves sweep the cache every
 * `maintenanceSaves`, and a restore compacts a table generation of more than `compactEntries` that is mostly garbage. */
export interface CacheLimits { readonly maxTraces: number; readonly maxBytes: number; readonly maintenanceSaves: number; readonly compactEntries: number }
export const defaultCacheLimits: CacheLimits = { maxTraces: 50_000, maxBytes: 256 * 1024 * 1024, maintenanceSaves: 128, compactEntries: 4096 };
