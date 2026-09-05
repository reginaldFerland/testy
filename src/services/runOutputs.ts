import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock';
import { removeOutput } from './output';

const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface RunOutputLease { readonly directory: string; dispose(): Promise<void>; }

/** Call under the storage lock. Unknown directories and live owners are preserved. */
async function reclaim(storage: string, signal?: AbortSignal): Promise<void> {
    await fs.mkdir(storage, { recursive: true });
    for (const name of await fs.readdir(storage)) {
        signal?.throwIfAborted();
        const identity = name.slice(0, -'.owner.json'.length);
        if (!name.endsWith('.owner.json') || !identityPattern.test(identity)) {continue;}
        let owner: { identity?: unknown; pid?: unknown };
        try {owner = JSON.parse(await fs.readFile(path.join(storage, name), 'utf8'));}
        catch (error) {if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {continue;} throw error;}
        if (!owner || owner.identity !== identity || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {continue;}
        try {process.kill(owner.pid, 0);}
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {continue;}
            await removeOutput(path.join(storage, identity));
            await fs.unlink(path.join(storage, name));
        }
    }
}

export async function reclaimRunOutputs(storage: string, signal?: AbortSignal): Promise<void> {
    await withLock(`${storage}.lock`, signal, () => reclaim(storage, signal));
}

export async function claimRunOutputs(storage: string, identity: string = randomUUID(), signal?: AbortSignal): Promise<RunOutputLease> {
    if (!identityPattern.test(identity)) {throw new Error('Invalid private run output identity.');}
    const directory = path.join(storage, identity), owner = path.join(storage, `${identity}.owner.json`);
    await withLock(`${storage}.lock`, signal, async () => {
        await reclaim(storage, signal);
        // Publishing the owner first leaves no unmarked output if the host dies.
        const temporary = path.join(storage, `${identity}.${randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, JSON.stringify({ identity, pid: process.pid }), { signal });
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
