import { availableParallelism } from 'node:os';

/** Project preparation can itself schedule parallel MSBuild and analysis work. */
export function resolveConcurrency(value = 0, cpus = availableParallelism()): number {
    return configuredOrAutomatic(value, Math.max(1, Math.min(4, cpus - 1)));
}

/** File workers own one isolated test process at a time; reserve one CPU for the editor. */
export function resolveTestFileConcurrency(value = 0, cpus = availableParallelism()): number {
    return configuredOrAutomatic(value, Math.max(1, cpus - 1));
}

function configuredOrAutomatic(value: number, automatic: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {throw new Error('Concurrency must be a nonnegative integer.');}
    return value || automatic;
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
    // Workers set failed; `as boolean` keeps reads after the awaits from narrowing to false.
    let next = 0, failed = false as boolean, failure: unknown;
    try {
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, worker) => {
            while (!controller.signal.aborted) {
                const index = next++;
                if (index >= items.length) {return;}
                // The bound check above guarantees the element exists.
                try {results[index] = await work(items[index] as T, index, controller.signal, worker);}
                catch (error) {
                    if (!failed) {failed = true; failure = error; controller.abort(error);
                        // A notification failure must not bypass draining admitted work.
                        try {onFailure?.(error);} catch { /* Preserve the first worker failure. */ }
                    }
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
    for (const [index, item] of items.entries()) {
        const id = key(item);
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
    // Workers set failed; `as boolean` keeps reads after the awaits from narrowing to false.
    let admitted = 0, failed = false as boolean, failure: unknown;
    const take = (): { target: Target; index: number } | undefined => {
        let chosen: Target | undefined, exclusive = false;
        for (const target of targets.values()) {
            if (target.next === target.indices.length || target.exclusive || (chosen && target.active >= chosen.active)) {continue;}
            // target.next < target.indices.length, and every index came from items.
            const index = target.indices[target.next]!, parallel = parallelEligible(items[index] as T, index);
            if (target.active && !parallel) {continue;}
            chosen = target; exclusive = !parallel;
            if (!target.active) {break;}
        }
        if (!chosen) {return undefined;}
        const index = chosen.indices[chosen.next++]!;
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
                    results[selected.index] = await work(items[selected.index] as T, selected.index, controller.signal, worker);
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

/** Wait for shared work, but stop waiting when the caller is cancelled; the work itself continues. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {return Promise.reject(signal.reason as Error);}
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason as Error);
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** A shared I/O budget; release before recursively scheduling more work. */
export class Semaphore {
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    constructor(private readonly limit: number) {}
    async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
        signal?.throwIfAborted();
        if (this.active >= this.limit) {
            // An aborted waiter leaves the queue; a granted permit is never abandoned.
            await new Promise<void>((resolve, reject) => {
                const grant = (): void => {signal?.removeEventListener('abort', abort); resolve();};
                const abort = (): void => {
                    const index = this.waiting.indexOf(grant);
                    if (index >= 0) {this.waiting.splice(index, 1);}
                    reject(signal!.reason);
                };
                this.waiting.push(grant);
                signal?.addEventListener('abort', abort, { once: true });
            });
        }
        else {this.active++;}
        try {signal?.throwIfAborted(); return await work();}
        finally {this.release();}
    }

    /** Borrow idle capacity without queuing behind another permit's owner. */
    tryRun<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> | undefined {
        signal?.throwIfAborted();
        if (this.waiting.length || this.active >= this.limit) {return undefined;}
        this.active++;
        return (async () => {
            // The work retains its permit through cancellation and cleanup.
            try {return await work();}
            finally {this.release();}
        })();
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) {next();} else {this.active--;}
    }
}

/** Breadth-unordered tree walk with one bounded pool for the whole tree. Each
 * visit returns its children; the first failure stops admission and is thrown
 * after every admitted visit has settled. */
export function walkTree<T>(roots: readonly T[], visit: (job: T) => Promise<readonly T[]>, budget: Semaphore, signal?: AbortSignal, width = 8): Promise<void> {
    const queued = [...roots];
    let active = 0, failed = false, failure: unknown;
    return new Promise<void>((resolve, reject) => {
        const pump = (): void => {
            if (failed) {queued.length = 0;}
            while (active < width && queued.length) {
                const job = queued.pop()!; active++;
                void budget.run(signal, () => visit(job)).then(children => {if (!failed) {queued.push(...children);}})
                    .catch((error: unknown) => {if (!failed) {failed = true; failure = error;}})
                    .finally(() => {active--; pump();});
            }
            if (!active && !queued.length) {if (failed) {reject(failure);} else {resolve();}}
        };
        pump();
    });
}
