import * as fs from 'node:fs/promises';
import { BigIntStats, constants, createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { mapConcurrent, Semaphore } from '../core/concurrency';

const copyWorkers = new Semaphore(8);
const metadataWorkers = new Semaphore(8);
// Windows chmod exposes write access but cannot add POSIX directory execute bits.
const directoryAccess = process.platform === 'win32' ? 0o600 : 0o700;

async function copyFile(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try { await fs.copyFile(source, destination, constants.COPYFILE_FICLONE_FORCE); }
    catch (error) {
        if (!['ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;}
        await pipeline(createReadStream(source), createWriteStream(destination, { mode: (await fs.stat(source)).mode }), { signal });
    }
    signal?.throwIfAborted();
}

/** Dereference output links into private copies; never instrument their targets. */
export async function copyOutput(source: string, destination: string, signal?: AbortSignal, ancestors: ReadonlySet<string> = new Set()): Promise<void> {
    interface Copy { readonly source: string; readonly destination: string; readonly ancestors: ReadonlySet<string>; }
    const queued: Copy[] = [{ source, destination, ancestors }];
    let active = 0, failed = false, failure: unknown;
    const copy = async (job: Copy): Promise<Copy[]> => {
        signal?.throwIfAborted();
        const resolved = await fs.realpath(job.source), stat = await fs.stat(resolved);
        if (!stat.isDirectory()) {await copyFile(resolved, job.destination, signal); return [];}
        if (job.ancestors.has(resolved)) {throw new Error(`A cycle in the build output prevents safe test isolation: ${job.source}`);}
        const next = new Set([...job.ancestors, resolved]);
        await fs.mkdir(job.destination, { recursive: true });
        return (await fs.readdir(resolved)).filter(name => name !== 'TestResults')
            .map(name => ({ source: path.join(resolved, name), destination: path.join(job.destination, name), ancestors: next }));
    };
    // One pool for the whole tree, not eight workers per recursive directory.
    await new Promise<void>((resolve, reject) => {
        const pump = (): void => {
            if (failed) {queued.length = 0;}
            while (active < 8 && queued.length) {
                const job = queued.pop()!; active++;
                void copyWorkers.run(signal, () => copy(job)).then(children => {if (!failed) {for (const child of children) {queued.push(child);}}})
                    .catch(error => {if (!failed) {failed = true; failure = error;}})
                    .finally(() => {active--; pump();});
            }
            if (!active && !queued.length) {if (failed) {reject(failure);} else {resolve();}}
        };
        pump();
    });
}

/** Only call for extension-owned output. Never follow links while repairing permissions. */
async function makeAccessible(directory: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let stat;
    try {stat = await fs.lstat(directory);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return;} throw error;}
    if (!stat.isDirectory() || stat.isSymbolicLink()) {return;}
    if ((stat.mode & directoryAccess) !== directoryAccess) {await fs.chmod(directory, stat.mode | directoryAccess);}
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {await makeAccessible(path.join(directory, entry.name), signal);}
    }
}

export async function removeOutput(directory: string): Promise<void> {
    await makeAccessible(directory);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function stampValue(stat: BigIntStats): string {
    return `${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.dev}:${stat.ino}:${stat.mode}`;
}

async function stamp(file: string, signal?: AbortSignal): Promise<string> {
    return metadataWorkers.run(signal, async () => stampValue(await fs.lstat(file, { bigint: true })));
}

/** Repair access before listing each directory; links are inventoried, never followed. */
async function inventory(directory: string, signal?: AbortSignal, repairAccess = false, root?: BigIntStats): Promise<{ root: string; entries: Map<string, string> }> {
    const result = { root: '', entries: new Map<string, string>() };
    const access = BigInt(directoryAccess);
    let queued = [''];
    while (queued.length) {
        const visited = await mapConcurrent(queued, 8, signal, (relative, _index, workerSignal) => metadataWorkers.run(workerSignal, async () => {
            const file = path.join(directory, relative);
            let stat = relative === '' && root ? root : await fs.lstat(file, { bigint: true });
            if (repairAccess && stat.isDirectory() && (stat.mode & access) !== access) {
                workerSignal.throwIfAborted();
                await fs.chmod(file, Number(stat.mode | access));
                stat = await fs.lstat(file, { bigint: true });
            }
            workerSignal.throwIfAborted();
            const children = stat.isDirectory() ? await fs.readdir(file) : [];
            return { relative, stamp: stampValue(stat), children };
        }));
        queued = [];
        // Breadth-first results retain parent-before-child repair order even
        // when metadata calls finish out of order. One budget covers all lanes.
        for (const entry of visited) {
            if (entry.relative) {result.entries.set(entry.relative, entry.stamp);} else {result.root = entry.stamp;}
            for (const name of entry.children) {queued.push(path.join(entry.relative, name));}
        }
    }
    return result;
}

export async function fileHash(file: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) {hash.update(chunk);}
    return hash.digest('hex');
}

/** Keep a pristine instrumented template, repairing only files changed by tests. */
export class PreparedOutput {
    private stamps = new Map<string, string>();
    private rootMode = 0o755;
    private readonly templateHashes = new Map<string, string>();
    private collisionTime = 0n;
    constructor(readonly template: string, readonly directory: string) {}

    async initialize(signal?: AbortSignal): Promise<void> {
        await copyOutput(this.template, this.directory, signal);
        const current = await inventory(this.directory, signal);
        this.stamps = current.entries;
        this.rootMode = Number(current.root.split(':').at(-1));
        this.advanceClock(await stamp(this.directory, signal));
    }

    async restore(signal?: AbortSignal): Promise<void> {
        const root = await metadataWorkers.run(signal, () => fs.lstat(this.directory, { bigint: true }))
            .catch(error => {if (error?.code === 'ENOENT') {return undefined;} throw error;});
        if (!root?.isDirectory() || root.isSymbolicLink()) {
            await removeOutput(this.directory); await this.initialize(signal); return;
        }
        const snapshot = await inventory(this.directory, signal, true, root), current = snapshot.entries;
        const restored = new Map(this.stamps);
        for (const [file, stamp] of [...current].reverse()) {
            signal?.throwIfAborted();
            if (!this.stamps.has(file) || stamp.split(':')[0] !== this.stamps.get(file)?.split(':')[0]) {
                await fs.rm(path.join(this.directory, file), { recursive: true, force: true }); current.delete(file);
            }
        }
        for (const [file, previous] of this.stamps) {
            signal?.throwIfAborted();
            if (previous.startsWith('dir:')) {
                if (!current.has(file)) {await fs.mkdir(path.join(this.directory, file), { recursive: true });}
                continue;
            }
            let changed = current.get(file) !== previous;
            // Earlier timestamps prove the filesystem clock advanced before
            // tests started. Only the newest timestamp cohort can hide a write
            // in the same tick; compare its bytes when metadata is unchanged.
            if (!changed && BigInt(previous.split(':')[3]) === this.collisionTime) {
                let expected = this.templateHashes.get(file);
                if (!expected) {expected = await fileHash(path.join(this.template, file), signal); this.templateHashes.set(file, expected);}
                changed = expected !== await fileHash(path.join(this.directory, file), signal);
            }
            if (changed) {
                await fs.rm(path.join(this.directory, file), { force: true });
                await copyFile(path.join(this.template, file), path.join(this.directory, file), signal);
                restored.set(file, await stamp(path.join(this.directory, file), signal));
            }
        }
        // Apply directory modes last, after all children have been repaired.
        for (const [file, previous] of [...this.stamps].reverse()) {
            if (previous.startsWith('dir:') && previous.split(':').at(-1) !== current.get(file)?.split(':').at(-1)) {
                await metadataWorkers.run(signal, () => fs.chmod(path.join(this.directory, file), Number(previous.split(':').at(-1))));
            }
        }
        // Advancing the root clock retires same-tick file cohorts. Keep this
        // write when needed, including on coarse-timestamp filesystems.
        const advance = [...restored.values()].some(value => !value.startsWith('dir:') && BigInt(value.split(':')[3]) >= this.collisionTime);
        if (advance || Number(snapshot.root.split(':').at(-1)) !== this.rootMode) {
            await metadataWorkers.run(signal, () => fs.chmod(this.directory, this.rootMode));
        }
        const rootStamp = await stamp(this.directory, signal);
        signal?.throwIfAborted();
        this.stamps = restored;
        this.advanceClock(rootStamp);
    }

    private advanceClock(root: string): void {
        for (const value of [...this.stamps.values(), root]) {
            const time = BigInt(value.split(':')[3]);
            if (time > this.collisionTime) {this.collisionTime = time;}
        }
    }
}
