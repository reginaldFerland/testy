import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock';
import { removeOutput } from './output';
import { uuidPattern as identityPattern } from '../core/paths';
import { currentProcessStamp, isProcessAlive, isProcessStamp } from './processStamp';
import { readOwnerRecord, scanOwnerRecords, tryRemoveOwned } from './ownerRecords';
export interface RunOutputLease { readonly directory: string; dispose(): Promise<void>; }
type Log = (text: string) => void;
interface OwnerRecord { identity?: unknown; pid?: unknown; process?: unknown }
/** Real records hold a PID and a stamp; anything larger is damaged. */
const maximumOwnerBytes = 64 * 1024;

/** Call under the storage lock. Unknown directories and live owners are preserved. */
async function reclaim(storage: string, signal?: AbortSignal, log: Log = () => undefined): Promise<void> {
    await fs.mkdir(storage, { recursive: true });
    const discard = (identity: string): Promise<boolean> => tryRemoveOwned(async () => {
        await removeOutput(path.join(storage, identity));
        await fs.rm(path.join(storage, `${identity}.owner.json`), { force: true });
    }, log, 'A stale private output');
    await scanOwnerRecords<OwnerRecord>(storage, { suffix: '.owner.json', discard,
        read: (_identity, file) => readOwnerRecord(file, maximumOwnerBytes, value => value as OwnerRecord | undefined),
        async visit(identity, owner) {
            if (owner.identity !== identity || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {return;}
            if (await isProcessAlive(owner.pid, isProcessStamp(owner.process) ? owner.process : undefined)) {return;}
            await discard(identity);
        } }, signal);
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
