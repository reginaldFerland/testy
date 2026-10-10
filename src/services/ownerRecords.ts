import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { uuidPattern as identityPattern } from '../core/paths';
import { unreadableOwnerExpired } from './processStamp';

/** 'unreadable' marks a record that no version can parse (damaged or oversized). */
export type OwnerRead<T> = T | 'unreadable' | undefined;

/** Read a JSON owner record. `parse` returns undefined for a shape that must be left alone. */
export async function readOwnerRecord<T>(file: string, maximumBytes: number, parse: (value: unknown) => T | undefined): Promise<OwnerRead<T>> {
    try {
        const stat = await fs.lstat(file);
        if (!stat.isFile()) {return undefined;}
        if (stat.size > maximumBytes) {return 'unreadable';}
        return parse(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
        if (error instanceof SyntaxError) {return 'unreadable';}
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;}
        throw error;
    }
}

/** Removal fails on Windows while antivirus or a lingering process holds a file. The
 * owner record outlives a failed removal, so the next storage operation retries it. */
export async function tryRemoveOwned(remove: () => Promise<unknown>, log: (text: string) => void, description: string): Promise<boolean> {
    try {await remove(); return true;}
    catch (error) {log(`${description} could not be removed yet; it will be retried. ${String(error)}\n`); return false;}
}

/** An interrupted `<identity>.<uuid>.tmp` write. */
function interruptedWrite(name: string): boolean {
    const parts = name.split('.'), [target, writer, kind] = parts;
    return parts.length === 3 && kind === 'tmp' && !!target && !!writer && identityPattern.test(target) && identityPattern.test(writer);
}

export interface OwnerScan<T> {
    readonly suffix: string;
    readonly read: (identity: string, file: string) => Promise<OwnerRead<T>>;
    /** Remove the output and record of an identity that was found abandoned. */
    readonly discard: (identity: string) => Promise<unknown>;
    /** Called for each readable record. */
    readonly visit: (identity: string, owner: T) => Promise<void>;
}

/** Call under the storage lock, which every record writer holds: temporary files found here are
 * interrupted writes. Records no version can read are discarded once old enough. */
export async function scanOwnerRecords<T>(storage: string, scan: OwnerScan<T>, signal?: AbortSignal): Promise<void> {
    for (const name of await fs.readdir(storage)) {
        signal?.throwIfAborted();
        if (interruptedWrite(name)) {await fs.rm(path.join(storage, name), { force: true }).catch(() => undefined); continue;}
        const identity = name.slice(0, -scan.suffix.length);
        if (!name.endsWith(scan.suffix) || !identityPattern.test(identity)) {continue;}
        const file = path.join(storage, name), owner = await scan.read(identity, file);
        if (owner === 'unreadable') {
            // No process can be checked, so only age says the record was abandoned.
            if (await unreadableOwnerExpired(file)) {await scan.discard(identity);}
            continue;
        }
        if (owner) {await scan.visit(identity, owner);}
    }
}
