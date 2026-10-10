import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

/** Identifies a process instance, not just a PID. PIDs are reused after a
 * reboot and inside containers, so ownership markers also record the boot
 * time and, where the OS reports it cheaply, the process start time. */
export interface ProcessStamp {
    readonly pid: number;
    /** Seconds since the epoch at which the machine booted. */
    readonly boot: number;
    /** Opaque OS start time: Linux clock ticks since boot, or the macOS start
     * time in UTC. Absent on Windows, which exposes no start time without
     * spawning PowerShell or WMI per check, and in stamps from older versions.
     * Without it a reused PID looks alive until reboot. */
    readonly start?: string;
}

/** Wall-clock adjustments move the derived boot time slightly. */
const bootTolerance = 300;
/** Lock contenders and reclaim loops ask about the same few PIDs repeatedly. */
const startCacheMs = 1_000;

function bootTime(): number { return Math.round(Date.now() / 1000 - os.uptime()); }

async function linuxStart(pid: number): Promise<string | undefined> {
    try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        // The command name can contain spaces and parentheses; fields resume after the last ')'.
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {return undefined;}
}

/** One second resolution is plenty: a reused PID is born after the original exited.
 * UTC and the C locale keep the text stable across time zone and language changes. */
function macStart(pid: number): Promise<string | undefined> {
    return new Promise(resolve => execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)],
        { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2_000, windowsHide: true },
        (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)));
}

const recentStarts = new Map<number, { readonly at: number; readonly start: Promise<string | undefined> }>();
function processStart(pid: number): Promise<string | undefined> {
    if (process.platform === 'linux') {return linuxStart(pid);}
    if (process.platform !== 'darwin') {return Promise.resolve(undefined);}
    const known = recentStarts.get(pid);
    if (known && Date.now() - known.at < startCacheMs) {return known.start;}
    const start = macStart(pid);
    recentStarts.delete(pid); recentStarts.set(pid, { at: Date.now(), start });
    if (recentStarts.size > 64) {recentStarts.delete(recentStarts.keys().next().value as number);}
    return start;
}

let current: Promise<ProcessStamp> | undefined;
export function currentProcessStamp(): Promise<ProcessStamp> {
    return current ??= (async () => ({ pid: process.pid, boot: bootTime(), start: await processStart(process.pid) }))();
}

export function isProcessStamp(value: unknown): value is ProcessStamp {
    const stamp = value as ProcessStamp;
    return !!stamp && typeof stamp === 'object' && Number.isSafeInteger(stamp.pid) && stamp.pid > 0
        && Number.isSafeInteger(stamp.boot) && (stamp.start === undefined || typeof stamp.start === 'string');
}

/** False only when the process has certainly exited. Markers without a stamp
 * (older versions) rely on the PID alone, and an unreadable start time counts as alive. */
export async function isProcessAlive(pid: number, stamp?: ProcessStamp): Promise<boolean> {
    try {process.kill(pid, 0);}
    catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') {return false;}}
    if (!stamp || stamp.pid !== pid) {return true;}
    if (Math.abs(stamp.boot - bootTime()) > bootTolerance) {return false;}
    if (stamp.start !== undefined) {
        // This process already knows its own start time; contention within it must not spawn `ps`.
        const start = pid === process.pid ? (await currentProcessStamp()).start : await processStart(pid);
        if (start !== undefined && start !== stamp.start) {return false;}
    }
    return true;
}

/** An owner record that cannot be parsed names no process to check. Reclaim it
 * only once it is old, so a record being replaced is never mistaken for garbage. */
export const unreadableOwnerGraceMs = 10 * 60_000;

export async function unreadableOwnerExpired(file: string): Promise<boolean> {
    try {
        const stat = await fs.lstat(file);
        return stat.isFile() && Date.now() - stat.mtimeMs > unreadableOwnerGraceMs;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return false;}
        throw error;
    }
}
