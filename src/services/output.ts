import * as fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

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
                void copy(job).then(children => {if (!failed) {for (const child of children) {queued.push(child);}}})
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
    if ((stat.mode & 0o700) !== 0o700) {await fs.chmod(directory, stat.mode | 0o700);}
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {await makeAccessible(path.join(directory, entry.name), signal);}
    }
}

export async function removeOutput(directory: string): Promise<void> {
    await makeAccessible(directory);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function stamp(file: string): Promise<string> {
    const stat = await fs.lstat(file, { bigint: true });
    return `${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.dev}:${stat.ino}:${stat.mode}`;
}

async function entries(directory: string, signal?: AbortSignal, prefix = ''): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
        signal?.throwIfAborted();
        const relative = path.join(prefix, entry.name);
        const value = await stamp(path.join(directory, relative));
        result.set(relative, value);
        if (value.startsWith('dir:')) {for (const [file, value] of await entries(directory, signal, relative)) {result.set(file, value);}}
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
        this.stamps = await entries(this.directory, signal);
        this.rootMode = (await fs.stat(this.directory)).mode;
        this.advanceClock(await stamp(this.directory));
    }

    async restore(signal?: AbortSignal): Promise<void> {
        const root = await fs.lstat(this.directory).catch(error => {if (error.code === 'ENOENT') {return undefined;} throw error;});
        if (!root?.isDirectory() || root.isSymbolicLink()) {
            await removeOutput(this.directory); await this.initialize(signal); return;
        }
        await makeAccessible(this.directory, signal);
        const current = await entries(this.directory, signal);
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
                restored.set(file, await stamp(path.join(this.directory, file)));
            }
        }
        // Apply directory modes last, after all children have been repaired.
        for (const [file, previous] of [...this.stamps].reverse()) {
            if (previous.startsWith('dir:')) {await fs.chmod(path.join(this.directory, file), Number(previous.split(':').at(-1)));}
        }
        await fs.chmod(this.directory, this.rootMode);
        this.stamps = restored;
        this.advanceClock(await stamp(this.directory));
    }

    private advanceClock(root: string): void {
        for (const value of [...this.stamps.values(), root]) {
            const time = BigInt(value.split(':')[3]);
            if (time > this.collisionTime) {this.collisionTime = time;}
        }
    }
}
