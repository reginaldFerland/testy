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

/**
 * Prefer idle targets, then share spare workers between active targets. Each
 * target retains input order, and a nonparallel item owns its target exclusively.
 * Eligibility is checked again at admission so newly learned restrictions apply
 * to queued items. Workers waiting for an exclusive target remain available to
 * other targets. Results retain input order, regardless of admission order.
 */
export async function mapConcurrentByKey<T, R>(
    items: readonly T[], limit: number, signal: AbortSignal | undefined,
    key: (item: T) => string,
    work: (item: T, index: number, signal: AbortSignal, worker: number) => Promise<R>,
    onFailure?: (error: unknown) => void,
    parallelEligible: (item: T, index: number) => boolean = () => true
): Promise<R[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {throw new Error('Worker limit must be a positive integer.');}
    signal?.throwIfAborted();
    type Target = { indices: number[]; next: number; active: number; exclusive: boolean };
    const targets = new Map<string, Target>();
    for (let index = 0; index < items.length; index++) {
        const id = key(items[index]);
        let target = targets.get(id);
        if (!target) {target = { indices: [], next: 0, active: 0, exclusive: false }; targets.set(id, target);}
        target.indices.push(index);
    }
    const controller = new AbortController();
    const waiting = new Set<() => void>();
    const wake = (): void => {const callbacks = [...waiting]; waiting.clear(); for (const callback of callbacks) {callback();}};
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', wake, { once: true });
    const results = new Array<R>(items.length);
    let admitted = 0, failed = false, failure: unknown;
    const take = (): { target: Target; index: number } | undefined => {
        let chosen: Target | undefined, exclusive = false;
        for (const target of targets.values()) {
            if (target.next === target.indices.length || target.exclusive || (chosen && target.active >= chosen.active)) {continue;}
            const index = target.indices[target.next], parallel = parallelEligible(items[index], index);
            if (target.active && !parallel) {continue;}
            chosen = target; exclusive = !parallel;
            if (!target.active) {break;}
        }
        if (!chosen) {return undefined;}
        const index = chosen.indices[chosen.next++];
        chosen.active++; chosen.exclusive = exclusive; admitted++;
        return { target: chosen, index };
    };
    try {
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, worker) => {
            while (!controller.signal.aborted) {
                let selected: ReturnType<typeof take>;
                try {
                    selected = take();
                    if (!selected) {
                        if (admitted === items.length) {return;}
                        await new Promise<void>(resolve => waiting.add(resolve));
                        continue;
                    }
                    results[selected.index] = await work(items[selected.index], selected.index, controller.signal, worker);
                } catch (error) {
                    if (!failed) {
                        failed = true; failure = error; controller.abort(error);
                        // A notification failure must not bypass draining admitted work.
                        try {onFailure?.(error);} catch { /* Preserve the first worker failure. */ }
                    }
                    return;
                } finally {
                    if (selected) {selected.target.active--; selected.target.exclusive = false; wake();}
                }
            }
        }));
        if (failed) {throw failure;}
        signal?.throwIfAborted();
        return results;
    } finally {
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', wake);
    }
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
