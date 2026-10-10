import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock';
import { removeOutput } from './output';
import { uuidPattern as identityPattern } from '../core/paths';
import { currentProcessStamp, isProcessAlive, isProcessStamp, unreadableOwnerExpired } from './processStamp';
export interface RunOutputLease { readonly directory: string; dispose(): Promise<void>; }
type Log = (text: string) => void;
interface OwnerRecord { identity?: unknown; pid?: unknown; process?: unknown }
/** Real records hold a PID and a stamp; anything larger is damaged. */
const maximumOwnerBytes = 64 * 1024;

/** 'unreadable' marks a record that no version can parse (damaged or oversized). */
async function readOwner(file: string): Promise<OwnerRecord | 'unreadable' | undefined> {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile()) {return undefined;}
        if (stat.size > maximumOwnerBytes) {return 'unreadable';}
        return JSON.parse(await fs.readFile(file, 'utf8')) as OwnerRecord | undefined;
    } catch (error) {
        if (error instanceof SyntaxError) {return 'unreadable';}
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;}
        throw error;
    }
}

/** Removal fails on Windows while antivirus or a lingering process holds a file. The
 * owner record outlives a failed removal, so the next claim retries it. */
async function tryRemove(storage: string, identity: string, log: Log): Promise<void> {
    try {
        await removeOutput(path.join(storage, identity));
        await fs.rm(path.join(storage, `${identity}.owner.json`), { force: true });
    } catch (error) {log(`A stale private output could not be removed yet; it will be retried. ${String(error)}\n`);}
}

/** Call under the storage lock. Unknown directories and live owners are preserved. */
async function reclaim(storage: string, signal?: AbortSignal, log: Log = () => undefined): Promise<void> {
    await fs.mkdir(storage, { recursive: true });
    for (const name of await fs.readdir(storage)) {
        signal?.throwIfAborted();
        const identity = name.slice(0, -'.owner.json'.length);
        if (!name.endsWith('.owner.json') || !identityPattern.test(identity)) {continue;}
        const file = path.join(storage, name), owner = await readOwner(file);
        if (owner === 'unreadable') {
            // No process can be checked, so only age says the record was abandoned.
            if (await unreadableOwnerExpired(file)) {await tryRemove(storage, identity, log);}
            continue;
        }
        if (!owner || owner.identity !== identity || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {continue;}
        if (await isProcessAlive(owner.pid, isProcessStamp(owner.process) ? owner.process : undefined)) {continue;}
        await tryRemove(storage, identity, log);
    }
}

export async function reclaimRunOutputs(storage: string, signal?: AbortSignal, log?: Log): Promise<void> {
    await withLock(`${storage}.lock`, signal, () => reclaim(storage, signal, log));
}

export async function claimRunOutputs(storage: string, identity: string = randomUUID(), signal?: AbortSignal, log?: Log): Promise<RunOutputLease> {
    if (!identityPattern.test(identity)) {throw new Error('Invalid private run output identity.');}
    const directory = path.join(storage, identity), owner = path.join(storage, `${identity}.owner.json`);
    await withLock(`${storage}.lock`, signal, async () => {
        await reclaim(storage, signal, log);
        // Publishing the owner first leaves no unmarked output if the host dies.
        const temporary = path.join(storage, `${identity}.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, JSON.stringify({ identity, pid: process.pid, process: await currentProcessStamp() }), { signal });
            // Exclusive creation prevents two sessions from claiming one identity.
            await fs.link(temporary, owner);
            try {await fs.mkdir(directory);}
            catch (error) {await fs.unlink(owner); throw error;}
        } finally {await fs.rm(temporary, { force: true });}
    });
    let disposed = false;
    return { directory, async dispose() {
        if (disposed) {return;}
        await removeOutput(directory);
        await fs.rm(owner, { force: true });
        disposed = true;
    } };
}
