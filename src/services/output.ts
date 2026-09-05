import * as fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

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
    signal?.throwIfAborted();
    const resolved = await fs.realpath(source);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {await copyFile(resolved, destination, signal); return;}
    if (ancestors.has(resolved)) {throw new Error(`A cycle in the build output prevents safe test isolation: ${source}`);}
    const next = new Set([...ancestors, resolved]);
    await fs.mkdir(destination, { recursive: true });
    const entries = (await fs.readdir(resolved)).filter(name => name !== 'TestResults');
    let index = 0;
    const copies = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
        for (;;) {
            signal?.throwIfAborted();
            const name = entries[index++]; if (!name) {return;}
            await copyOutput(path.join(resolved, name), path.join(destination, name), signal, next);
        }
    }));
    const failed = copies.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) {throw failed.reason;}
}

async function entries(directory: string, signal?: AbortSignal, prefix = ''): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
        signal?.throwIfAborted();
        const relative = path.join(prefix, entry.name);
        const stat = await fs.lstat(path.join(directory, relative), { bigint: true });
        result.set(relative, `${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
        if (stat.isDirectory()) {for (const [file, stamp] of await entries(directory, signal, relative)) {result.set(file, stamp);}}
    }
    return result;
}

/** Keep a pristine instrumented template, repairing only files changed by tests. */
export class PreparedOutput {
    private stamps = new Map<string, string>();
    constructor(readonly template: string, readonly directory: string) {}

    async initialize(signal?: AbortSignal): Promise<void> {
        await copyOutput(this.template, this.directory, signal);
        this.stamps = await entries(this.directory, signal);
    }

    async restore(signal?: AbortSignal): Promise<void> {
        const current = await entries(this.directory, signal);
        for (const [file, stamp] of [...current].reverse()) {
            signal?.throwIfAborted();
            if (!this.stamps.has(file) || stamp.split(':')[0] !== this.stamps.get(file)?.split(':')[0]) {
                await fs.rm(path.join(this.directory, file), { recursive: true, force: true }); current.delete(file);
            }
        }
        for (const [file, stamp] of this.stamps) {
            signal?.throwIfAborted();
            if (stamp.startsWith('dir:')) {await fs.mkdir(path.join(this.directory, file), { recursive: true }); continue;}
            if (current.get(file) !== stamp) {await copyFile(path.join(this.template, file), path.join(this.directory, file), signal);}
        }
        this.stamps = await entries(this.directory, signal);
    }
}
