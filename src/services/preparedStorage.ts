import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from './lock';
import { removeOutput } from './output';

const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const suffix = '.owner.json';
const maximumMetadataBytes = 4 * 1024 * 1024;
interface Retention { readonly entries: number; readonly bytes: number; }
export interface PreparedStorageLimits { readonly maxEntries?: number; readonly maxBytes?: number; }
export interface PreparedStorageLease {
    readonly directory: string;
    readonly snapshot?: unknown;
    /** Publish only after every process and mutable artifact lease has drained. */
    park(snapshot: unknown, retention: Retention): Promise<void>;
    dispose(): Promise<void>;
}
interface Owner {
    readonly version: 1;
    readonly identity: string;
    readonly token: string;
    readonly pid: number;
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

async function readOwner(storage: string, identity: string): Promise<Owner | undefined> {
    try {
        const file = path.join(storage, identity + suffix);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumMetadataBytes) {return undefined;}
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as Owner;
        if (!value || value.version !== 1 || value.identity !== identity || typeof value.token !== 'string' || !identityPattern.test(value.token)
            || !count(value.pid) || (value.state !== 'active' && value.state !== 'parked')
            || (value.state === 'active' ? value.pid === 0 : value.pid !== 0)) {return undefined;}
        return value;
    } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;}
        throw error;
    }
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

async function discard(storage: string, owner: Owner): Promise<void> {
    await removeOutput(path.join(storage, owner.identity));
    await fs.rm(path.join(storage, owner.identity + suffix), { force: true });
}

/** Unknown formats and possibly live owners are never reclaimed. */
async function inventory(storage: string, signal?: AbortSignal): Promise<Parked[]> {
    const result: Parked[] = [];
    for (const name of await fs.readdir(storage)) {
        signal?.throwIfAborted();
        const temporary = name.split('.');
        if (temporary.length === 3 && temporary[2] === 'tmp' && identityPattern.test(temporary[0]) && identityPattern.test(temporary[1])) {
            // All metadata writers hold this lock, so these are interrupted writes.
            await fs.rm(path.join(storage, name), { force: true }).catch(() => undefined); continue;
        }
        const identity = name.slice(0, -suffix.length);
        if (!name.endsWith(suffix) || !identityPattern.test(identity)) {continue;}
        const owner = await readOwner(storage, identity);
        if (!owner) {continue;}
        if (owner.state === 'active') {
            try {process.kill(owner.pid, 0);}
            catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') {await discard(storage, owner);}}
            continue;
        }
        const stat = await fs.lstat(path.join(storage, identity)).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;} throw error;
        });
        if (!parked(owner) || !stat?.isDirectory() || stat.isSymbolicLink() || !owner.retention.entries) {
            await discard(storage, owner); continue;
        }
        result.push(owner);
    }
    return result;
}

async function trim(storage: string, owners: Parked[], limits: Required<PreparedStorageLimits>): Promise<Parked[]> {
    owners.sort((a, b) => a.parkedAt - b.parkedAt || a.identity.localeCompare(b.identity));
    let entries = owners.reduce((total, owner) => total + owner.retention.entries, 0);
    let bytes = owners.reduce((total, owner) => total + owner.retention.bytes, 0);
    while (owners.length && (entries > limits.maxEntries || bytes > limits.maxBytes)) {
        const owner = owners[0];
        await discard(storage, owner);
        owners.shift(); entries -= owner.retention.entries; bytes -= owner.retention.bytes;
    }
    return owners;
}

/** Cleanly parked containers transfer exclusively, in place. Crashed active owners never transfer. */
export async function claimPreparedStorage(storage: string, signal?: AbortSignal, options: PreparedStorageLimits = {}): Promise<PreparedStorageLease> {
    const limits = { maxEntries: options.maxEntries ?? 16, maxBytes: options.maxBytes ?? 512 * 1024 * 1024 };
    if (!count(limits.maxEntries) || !count(limits.maxBytes)) {throw new Error('Invalid prepared output storage limit.');}
    const token = randomUUID();
    const claimed = await withLock(`${storage}.lock`, signal, async () => {
        await fs.mkdir(storage, { recursive: true });
        const candidates = await trim(storage, await inventory(storage, signal), limits);
        const previous = candidates.at(-1);
        signal?.throwIfAborted();
        const owner: Owner = { version: 1, identity: previous?.identity ?? randomUUID(), token, pid: process.pid, state: 'active' };
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
            await withLock(`${storage}.lock`, undefined, async () => {
                const current = await readOwner(storage, claimed.owner.identity);
                if (!current || current.state !== 'active' || current.token !== token || current.pid !== process.pid) {closed = true; return;}
                await work(current); closed = true;
            });
        });
        pending = next; return next;
    };
    return { directory: path.join(storage, claimed.owner.identity), snapshot: claimed.snapshot,
        park(snapshot, retention) {
            if (!validRetention(retention)) {return Promise.reject(new Error('Invalid prepared output retention.'));}
            return finish(async owner => {
                if (!retention.entries || retention.entries > limits.maxEntries || retention.bytes > limits.maxBytes) {
                    await discard(storage, owner); return;
                }
                await writeOwner(storage, { ...owner, state: 'parked', pid: 0, parkedAt: Date.now(), snapshot, retention });
                // Ownership has ended even if trimming another container fails.
                closed = true;
                try {await trim(storage, await inventory(storage), limits);}
                catch { /* Retry pruning on the next storage operation; never revoke a published transfer. */ }
            });
        },
        dispose: () => finish(owner => discard(storage, owner)) };
}
