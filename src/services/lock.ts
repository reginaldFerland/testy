import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { currentProcessStamp, isProcessAlive, isProcessStamp } from './processStamp';

/** Holders refresh their owner file. A lock is taken over when its holder has
 * exited. A silent heartbeat only matters for holders whose stamp cannot tell a
 * reused PID from the original process; elsewhere a paused holder (suspended
 * laptop, blocked event loop) is slow, not gone. `cleanupWaitMs` bounds waits
 * on shutdown paths, where a hung live holder must not block disposal. */
export const lockTiming = { heartbeatMs: 5_000, staleMs: 60_000, cleanupWaitMs: 10_000 };

export class LockTimeoutError extends Error {
    constructor(directory: string) {super(`Timed out waiting for the lock ${directory}.`); this.name = 'LockTimeoutError';}
}
/** The holder's owner file disappeared, so a contender judged the lock abandoned. */
export class LockLostError extends Error {
    constructor(directory: string) {super(`The lock ${directory} was taken over while its work was running.`); this.name = 'LockLostError';}
}
export interface LockOptions {
    /** Give up waiting for the lock after this long; unbounded when omitted. */
    readonly timeoutMs?: number;
}

async function abandoned(directory: string, name: string): Promise<boolean> {
    const pid = Number(name.split('-')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) {return false;}
    const file = path.join(directory, name);
    const [contents, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    let stamp: unknown;
    try {stamp = contents ? JSON.parse(contents) : undefined;} catch {stamp = undefined;}
    // An empty marker is either still being written or from an older version
    // without heartbeats; only its PID can be checked.
    if (!isProcessStamp(stamp)) {return !await isProcessAlive(pid);}
    if (!await isProcessAlive(pid, stamp)) {return true;}
    // The stamp identifies a live holder. Without a start time, a reused PID
    // looks identical, so only then does a silent heartbeat prove abandonment.
    return stamp.start === undefined && Date.now() - stat.mtimeMs > lockTiming.staleMs;
}

/** A process-owned directory serializes shared storage without blocking the host.
 * The work receives a signal that aborts if the lock is taken over meanwhile, and
 * the call then fails instead of reporting success for work another writer may have raced. */
export async function withLock<T>(directory: string, signal: AbortSignal | undefined, work: (signal?: AbortSignal) => Promise<T>,
    options: LockOptions = {}): Promise<T> {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const owner = `${process.pid}-${randomUUID()}`;
    const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
    for (;;) {
        signal?.throwIfAborted();
        try {await fs.mkdir(directory); break;}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error;}}
        try {
            const names = await fs.readdir(directory);
            for (const name of names) {
                if (!await abandoned(directory, name)) {continue;}
                // Only the contender that removes this unique owner may
                // remove the directory. It cannot remove a successor's lock.
                await fs.unlink(path.join(directory, name)); await fs.rmdir(directory);
            }
            // Recover a process that died between mkdir and publishing its PID.
            if (!names.length && Date.now() - (await fs.stat(directory)).mtimeMs > 10_000) {await fs.rmdir(directory);}
        } catch (error) {if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;}}
        const remaining = deadline - Date.now();
        if (remaining <= 0) {throw new LockTimeoutError(directory);}
        await delay(Math.min(50, remaining), undefined, { signal });
    }
    const file = path.join(directory, owner), lost = new AbortController();
    const markLost = (error: unknown): void => {if ((error as NodeJS.ErrnoException).code === 'ENOENT') {lost.abort(new LockLostError(directory));}};
    let heartbeat: NodeJS.Timeout | undefined;
    try {
        await fs.writeFile(file, JSON.stringify(await currentProcessStamp()));
        // A refresh that cannot find the owner file means a contender removed it.
        heartbeat = setInterval(() => {const now = new Date(); void fs.utimes(file, now, now).catch(markLost);}, lockTiming.heartbeatMs);
        heartbeat.unref();
        const scoped = signal ? AbortSignal.any([signal, lost.signal]) : lost.signal;
        scoped.throwIfAborted();
        const result = await work(scoped);
        // The last heartbeat may predate a takeover; confirm before reporting success.
        await fs.access(file).catch(markLost);
        if (lost.signal.aborted) {throw lost.signal.reason;}
        return result;
    } catch (error) {
        throw lost.signal.aborted ? lost.signal.reason : error;
    } finally {
        clearInterval(heartbeat);
        await fs.unlink(file).catch(() => undefined);
        // After a takeover the directory may already belong to the successor.
        if (!lost.signal.aborted) {await fs.rmdir(directory).catch(() => undefined);}
    }
}
