import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RunnerOptions } from './runnerTypes';

export function assemblyName(file: string): string {
    const name = path.basename(file);
    return process.platform === 'win32' ? name.toLowerCase() : name;
}

export async function workspaceOutputs(directory: string, names: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {files.push(...await workspaceOutputs(file, names, signal));}
        else if (entry.isFile() && names.has(assemblyName(entry.name))) {files.push(file);}
    }
    return files;
}

/** Keep one inherited worker progressing even when every other preparation owns a permit. */
export async function instrumentWithSpareCapacity<T>(
    assemblies: readonly string[], signal: AbortSignal | undefined, borrow: NonNullable<RunnerOptions['tryInstrumentation']>,
    work: (assembly: string, signal: AbortSignal) => Promise<T>
): Promise<T[]> {
    signal?.throwIfAborted();
    const controller = new AbortController(), results = new Array<T>(assemblies.length);
    const running = new Set<Promise<void>>();
    // Callbacks set these; `as boolean` keeps reads after the awaits from narrowing to false.
    let next = 0, inheritedBusy = false as boolean, failed = false as boolean, failure: unknown;
    const fail = (error: unknown): void => {
        if (!failed) {failed = true; failure = error; controller.abort(error);}
    };
    const abort = (): void => fail(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    // Callers admit only indices below assemblies.length.
    const start = (index: number): Promise<T> => Promise.resolve().then(() => work(assemblies[index]!, controller.signal));
    const admit = (index: number, borrowed?: Promise<T>): void => {
        if (!borrowed) {inheritedBusy = true;}
        const pending = (borrowed ?? start(index))
            .then(result => {results[index] = result;}, fail).finally(() => {
                if (!borrowed) {inheritedBusy = false;}
                running.delete(pending);
            });
        running.add(pending);
    };
    try {
        while ((!failed && next < assemblies.length) || running.size) {
            if (!failed && !inheritedBusy && next < assemblies.length) {admit(next++);}
            while (!failed && next < assemblies.length) {
                const index = next;
                const borrowed = borrow(controller.signal, () => start(index));
                if (!borrowed) {break;}
                next++; admit(index, borrowed);
            }
            if (running.size) {await Promise.race(running);}
        }
    } catch (error) {fail(error);}
    finally {
        // No rollback, cache release or output removal may race an admitted instrument process.
        await Promise.all(running);
        signal?.removeEventListener('abort', abort);
    }
    if (failed) {throw failure;}
    signal?.throwIfAborted();
    return results;
}
