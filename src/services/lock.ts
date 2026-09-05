import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** A process-owned directory serializes shared storage without blocking the host. */
export async function withLock<T>(directory: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(directory), { recursive: true });
    const owner = `${process.pid}-${randomUUID()}`;
    const began = Date.now();
    for (;;) {
        signal?.throwIfAborted();
        if (Date.now() - began > 120_000) {throw new Error(`Timed out waiting for another Testy window to release ${path.basename(directory)}.`);}
        try {await fs.mkdir(directory); break;}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error;}}
        try {
            const names = await fs.readdir(directory);
            for (const name of names) {
                const pid = Number(name.split('-')[0]);
                if (!Number.isSafeInteger(pid) || pid <= 0) {continue;}
                try {process.kill(pid, 0);}
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {continue;}
                    // Only the contender that removes this unique owner may
                    // remove the directory. It cannot remove a successor's lock.
                    await fs.unlink(path.join(directory, name)); await fs.rmdir(directory);
                }
            }
            // Recover a process that died between mkdir and publishing its PID.
            if (!names.length && Date.now() - (await fs.stat(directory)).mtimeMs > 10_000) {await fs.rmdir(directory);}
        } catch (error) {if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;}}
        await delay(50, undefined, { signal });
    }
    try {
        await fs.writeFile(path.join(directory, owner), '');
        signal?.throwIfAborted(); return await work();
    } finally {
        await fs.unlink(path.join(directory, owner)).catch(() => undefined);
        await fs.rmdir(directory).catch(() => undefined);
    }
}
