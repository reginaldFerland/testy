import { availableParallelism } from 'node:os';

/** Zero (and omitted settings) choose a conservative budget for .NET processes. */
export function resolveConcurrency(value = 0, cpus = availableParallelism()): number {
    if (!Number.isSafeInteger(value) || value < 0) {throw new Error('Concurrency must be a nonnegative integer.');}
    return value || Math.max(1, Math.min(4, cpus - 1));
}

/** Stop on the first error, cancel siblings, and drain them before returning. */
export async function mapConcurrent<T, R>(
    items: readonly T[], limit: number, signal: AbortSignal | undefined,
    work: (item: T, index: number, signal: AbortSignal, worker: number) => Promise<R>,
    onFailure?: (error: unknown) => void
): Promise<R[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {throw new Error('Worker limit must be a positive integer.');}
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const results = new Array<R>(items.length);
    let next = 0, failed = false, failure: unknown;
    try {
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, worker) => {
            while (!controller.signal.aborted) {
                const index = next++;
                if (index >= items.length) {return;}
                try {results[index] = await work(items[index], index, controller.signal, worker);}
                catch (error) {
                    if (!failed) {failed = true; failure = error; controller.abort(error); onFailure?.(error);}
                    return;
                }
            }
        }));
        if (failed) {throw failure;}
        signal?.throwIfAborted();
        return results;
    } finally {signal?.removeEventListener('abort', abort);}
}

/** Serialize state commits while allowing process work to overlap. */
export class SerialQueue {
    private tail: Promise<unknown> = Promise.resolve();
    run<T>(work: () => Promise<T>): Promise<T> {
        const result = this.tail.then(work);
        this.tail = result.catch(() => undefined);
        return result;
    }
}

/** A shared I/O budget; release before recursively scheduling more work. */
export class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    constructor(private readonly limit: number) {}
    async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
        signal?.throwIfAborted();
        if (this.active >= this.limit) {await new Promise<void>(resolve => this.waiting.push(resolve));}
        else {this.active++;}
        try {signal?.throwIfAborted(); return await work();}
        finally {
            const next = this.waiting.shift();
            if (next) {next();} else {this.active--;}
        }
    }
}
