import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LockTimeoutError, lockTiming, withLock } from './lock';
import { removeOutput } from './output';
import { uuidPattern as identityPattern } from '../core/paths';
import { currentProcessStamp, isProcessAlive, isProcessStamp, ProcessStamp } from './processStamp';
import { readOwnerRecord, scanOwnerRecords, tryRemoveOwned } from './ownerRecords';
import type { OwnerRead } from './ownerRecords';
const suffix = '.owner.json';
const maximumMetadataBytes = 4 * 1024 * 1024;
export interface Retention { readonly entries: number; readonly bytes: number; }
/** A parked snapshot reduced to fit a budget, and the entry directories it no longer references. */
export interface PreparedStorageShrink { readonly snapshot: unknown; readonly retention: Retention; readonly removed: readonly string[]; }
export interface PreparedStorageLimits {
    readonly maxEntries?: number; readonly maxBytes?: number;
    /** Drops the oldest entries of a parked snapshot to fit the target, instead of discarding the whole
     * container. Returns nothing when no entry fits or the snapshot is not understood. */
    readonly shrink?: (snapshot: unknown, target: Retention) => PreparedStorageShrink | undefined;
    /** Diagnostics for cleanup that is skipped and retried later. */
    readonly log?: (text: string) => void;
}
interface Budget { readonly maxEntries: number; readonly maxBytes: number; readonly shrink?: PreparedStorageLimits['shrink']; readonly log: (text: string) => void; }
export interface PreparedStorageLease {
    readonly directory: string;
    readonly snapshot?: unknown;
    /** Accommodate a larger worker pool without changing the retained byte budget. */
    reserveEntries(entries: number): void;
    /** Publish only after every process and mutable artifact lease has drained. */
    park(snapshot: unknown, retention: Retention): Promise<void>;
    dispose(): Promise<void>;
}
interface Owner {
    readonly version: 1;
    readonly identity: string;
    readonly token: string;
    readonly pid: number;
    /** Distinguishes a live owner from an unrelated process that reused its PID. */
    readonly process?: ProcessStamp | undefined;
    readonly state: 'active' | 'parked';
    readonly parkedAt?: number;
    readonly snapshot?: unknown;
    readonly retention?: Retention;
}
interface Parked extends Owner {
    readonly state: 'parked';
    readonly parkedAt: number;
    readonly retention: Retention;
}

function count(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;}
function validRetention(value: unknown): value is Retention {
    return !!value && typeof value === 'object' && count((value as Retention).entries) && count((value as Retention).bytes);
}
function parked(owner: Owner): owner is Parked {
    return owner.state === 'parked' && owner.pid === 0 && count(owner.parkedAt) && validRetention(owner.retention)
        && Object.hasOwn(owner, 'snapshot');
}

/** Unknown versions and shapes may belong to another release, so they are never reclaimed. */
function readOwner(storage: string, identity: string): Promise<OwnerRead<Owner>> {
    return readOwnerRecord(path.join(storage, identity + suffix), maximumMetadataBytes, parsed => {
        const value = parsed as { readonly [Key in keyof Owner]?: unknown } | null;
        if (!value || value.version !== 1 || value.identity !== identity || typeof value.token !== 'string' || !identityPattern.test(value.token)
            || !count(value.pid) || (value.state !== 'active' && value.state !== 'parked')
            || (value.state === 'active' ? value.pid === 0 : value.pid !== 0)
            || (value.process !== undefined && !isProcessStamp(value.process))) {return undefined;}
        return value as Owner;
    });
}

/** Every caller holds the storage lock; rename publishes the complete state at once. */
async function writeOwner(storage: string, owner: Owner, fresh = false): Promise<void> {
    const file = path.join(storage, owner.identity + suffix), temporary = path.join(storage, `${owner.identity}.${randomUUID()}.tmp`);
    const contents = JSON.stringify(owner);
    if (Buffer.byteLength(contents) > maximumMetadataBytes) {throw new Error('Prepared output metadata exceeds its size limit.');}
    let published = false;
    try {
        await fs.writeFile(temporary, contents, { flag: 'wx' });
        if (fresh) {await fs.link(temporary, file);} else {await fs.rename(temporary, file);}
        published = true;
    } finally {
        // A successful transition cannot be reported as failure: the old cache
        // could otherwise delete artifacts now available to a successor.
        try {await fs.rm(temporary, { force: true });} catch (error) {if (!published) {throw error;}}
    }
}

async function discard(storage: string, identity: string): Promise<void> {
    await removeOutput(path.join(storage, identity));
    await fs.rm(path.join(storage, identity + suffix), { force: true });
}

const tryDiscard = (storage: string, identity: string, log: Budget['log']): Promise<boolean> =>
    tryRemoveOwned(() => discard(storage, identity), log, 'A retained prepared output');

/** Unknown formats and possibly live owners are never reclaimed. */
async function inventory(storage: string, log: Budget['log'], signal?: AbortSignal): Promise<Parked[]> {
    const result: Parked[] = [];
    await scanOwnerRecords<Owner>(storage, { suffix, read: identity => readOwner(storage, identity), discard: identity => tryDiscard(storage, identity, log),
        async visit(identity, owner) {
            if (owner.state === 'active') {
                if (!await isProcessAlive(owner.pid, owner.process)) {await tryDiscard(storage, identity, log);}
                return;
            }
            const stat = await fs.lstat(path.join(storage, identity)).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;} throw error;
            });
            if (!parked(owner) || !stat?.isDirectory() || stat.isSymbolicLink() || !owner.retention.entries) {
                await tryDiscard(storage, identity, log); return;
            }
            result.push(owner);
        } }, signal);
    return result;
}

/** Publish the reduced snapshot before deleting what it dropped, so no snapshot names a deleted directory. */
async function shrinkOwner(storage: string, owner: Parked, target: Retention, budget: Budget): Promise<Parked | undefined> {
    const reduced = target.entries ? budget.shrink?.(owner.snapshot, target) : undefined;
    if (!reduced || !validRetention(reduced.retention) || !reduced.retention.entries) {return undefined;}
    const shrunk: Parked = { ...owner, snapshot: reduced.snapshot, retention: reduced.retention };
    try {await writeOwner(storage, shrunk);}
    catch (error) {budget.log(`A retained preparation container could not be reduced. ${String(error)}\n`); return undefined;}
    const container = path.join(storage, owner.identity);
    for (const name of reduced.removed) {
        const directory = path.join(container, name);
        if (path.dirname(directory) !== container) {continue;}
        // An unreferenced leftover is removed by whichever session adopts and parks the container next.
        try {await removeOutput(directory);}
        catch (error) {budget.log(`A dropped preparation could not be removed yet. ${String(error)}\n`);}
    }
    return shrunk;
}

async function trim(storage: string, owners: Parked[], budget: Budget): Promise<Parked[]> {
    owners.sort((a, b) => a.parkedAt - b.parkedAt || a.identity.localeCompare(b.identity));
    const total = (pick: (owner: Parked) => number): number => owners.reduce((sum, owner) => sum + pick(owner), 0);
    for (let index = 0; index < owners.length;) {
        const excessEntries = total(owner => owner.retention.entries) - budget.maxEntries;
        const excessBytes = total(owner => owner.retention.bytes) - budget.maxBytes;
        if (excessEntries <= 0 && excessBytes <= 0) {break;}
        const owner = owners[index]!; // index < owners.length
        // The oldest container gives up its oldest entries first and goes whole only when none fit.
        const shrunk = await shrinkOwner(storage, owner, { entries: Math.max(0, owner.retention.entries - Math.max(0, excessEntries)),
            bytes: Math.max(0, owner.retention.bytes - Math.max(0, excessBytes)) }, budget);
        if (shrunk) {owners[index++] = shrunk; continue;}
        // A container that cannot be removed now is not adopted either; the next claim retries it.
        await tryDiscard(storage, owner.identity, budget.log); owners.splice(index, 1);
    }
    return owners;
}

/** Cleanly parked containers transfer exclusively, in place. Crashed active owners never transfer. */
export async function claimPreparedStorage(storage: string, signal?: AbortSignal, options: PreparedStorageLimits = {}): Promise<PreparedStorageLease> {
    const limits = { maxEntries: options.maxEntries ?? 16, maxBytes: options.maxBytes ?? 512 * 1024 * 1024, shrink: options.shrink,
        log: options.log ?? ((): void => undefined) };
    if (!count(limits.maxEntries) || !count(limits.maxBytes)) {throw new Error('Invalid prepared output storage limit.');}
    const token = randomUUID();
    const claimed = await withLock(`${storage}.lock`, signal, async () => {
        await fs.mkdir(storage, { recursive: true });
        const candidates = await trim(storage, await inventory(storage, limits.log, signal), limits);
        const previous = candidates.at(-1);
        signal?.throwIfAborted();
        const owner: Owner = { version: 1, identity: previous?.identity ?? randomUUID(), token, pid: process.pid, process: await currentProcessStamp(), state: 'active' };
        await writeOwner(storage, owner, !previous);
        if (!previous) {
            try {await fs.mkdir(path.join(storage, owner.identity));}
            catch (error) {await fs.rm(path.join(storage, owner.identity + suffix), { force: true }); throw error;}
        }
        return { owner, snapshot: previous?.snapshot };
    });
    let closed = false, pending = Promise.resolve();
    const finish = (work: (owner: Owner) => Promise<void>): Promise<void> => {
        const next = pending.catch(() => undefined).then(async () => {
            if (closed) {return;}
            try {
                await withLock(`${storage}.lock`, undefined, async () => {
                    const current = await readOwner(storage, claimed.owner.identity);
                    if (!current || current === 'unreadable' || current.state !== 'active' || current.token !== token || current.pid !== process.pid) {closed = true; return;}
                    await work(current); closed = true;
                }, { timeoutMs: lockTiming.cleanupWaitMs });
            } catch (error) {
                if (!(error instanceof LockTimeoutError)) {throw error;}
                // A hung holder must not block shutdown. The container stays marked active, so it is
                // reclaimed once this process has exited.
                limits.log(`Prepared output storage is busy; leaving this session's outputs for later reclaim. ${String(error)}\n`);
                closed = true;
            }
        });
        pending = next; return next;
    };
    return { directory: path.join(storage, claimed.owner.identity), snapshot: claimed.snapshot,
        reserveEntries(entries) {
            if (!count(entries)) {throw new Error('Invalid prepared output storage limit.');}
            if (closed) {throw new Error('The prepared output storage lease is closed.');}
            limits.maxEntries = Math.max(limits.maxEntries, entries);
        },
        park(snapshot, retention) {
            if (!validRetention(retention)) {return Promise.reject(new Error('Invalid prepared output retention.'));}
            return finish(async owner => {
                const fits = retention.entries <= limits.maxEntries && retention.bytes <= limits.maxBytes;
                // An empty budget keeps nothing, and without a way to shrink it an oversized container is not worth publishing.
                if (!retention.entries || !limits.maxEntries || (!fits && (!limits.shrink || !limits.maxBytes))) {
                    await discard(storage, owner.identity); return;
                }
                await writeOwner(storage, { ...owner, state: 'parked', pid: 0, process: undefined, parkedAt: Date.now(), snapshot, retention });
                // Ownership has ended even if trimming another container fails.
                closed = true;
                try {await trim(storage, await inventory(storage, limits.log), limits);}
                catch { /* Retry pruning on the next storage operation; never revoke a published transfer. */ }
            });
        },
        dispose: () => finish(owner => discard(storage, owner.identity)) };
}
