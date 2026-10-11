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

/** Shared resources an item needs (see mapConcurrentByKey): items naming the same `exclusive` resource never run together,
 * and a `serial` item runs with nothing else at all. */
/** What an item needs besides a worker: resources no other item may hold (`exclusive`), resources it shares with other inclusive
 * holders but not with an exclusive one (`inclusive`), no other item at all (`serial`), or several worker slots (`workers`). */
export interface ItemResources {
    readonly exclusive: readonly string[];
    readonly serial: boolean;
    readonly inclusive?: readonly string[] | undefined;
    readonly workers?: number | undefined;
}

export interface KeyedScheduling<T> {
    /** Called once, with the first worker failure, before draining. */
    readonly onFailure?: ((error: unknown) => void) | undefined;
    /** Whether the item may run beside other items of its target; checked again at each admission. */
    readonly parallelEligible?: ((item: T, index: number) => boolean) | undefined;
    /** Worker 0 takes items from the end of the queue: items ordered longest first then report early results from the short
     * end while the other workers start the long ones. */
    readonly fastLane?: boolean | undefined;
    /** The shared resources each item needs; read once per item. */
    readonly resources?: ((item: T, index: number) => ItemResources | undefined) | undefined;
    /** Once aborted, no further item starts: admitted items finish, and the call resolves without results for the others. */
    readonly drain?: AbortSignal | undefined;
    /** A worker was idle from `start` to `end` (epoch milliseconds) while items were still queued: their resources or targets were busy. */
    readonly onWait?: ((worker: number, start: number, end: number) => void) | undefined;
}

/**
 * Prefer idle targets, then share spare workers between active targets; between
 * equally busy targets, the earliest queued item goes first. Each target retains
 * input order, and a nonparallel item owns its target exclusively. Eligibility is
 * checked again at admission so newly learned restrictions apply to queued items.
 * Workers waiting for an exclusive target remain available to other targets.
 * An item whose resources are in use waits, and later items of its target may
 * start before it. Results retain input order, regardless of admission order.
 */
export async function mapConcurrentByKey<T, R>(
    items: readonly T[], limit: number, signal: AbortSignal | undefined,
    key: (item: T) => string,
    work: (item: T, index: number, signal: AbortSignal, worker: number) => Promise<R>,
    scheduling: KeyedScheduling<T> = {}
): Promise<R[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {throw new Error('Worker limit must be a positive integer.');}
    signal?.throwIfAborted();
    const { onFailure, parallelEligible = () => true, fastLane = false, drain } = scheduling;
    const needs = scheduling.resources ? items.map((item, index) => scheduling.resources!(item, index)) : [];
    /** A target's queued item indices, in order. */
    type Target = { queue: number[]; active: number; exclusive: boolean };
    const targets = new Map<string, Target>();
    for (const [index, item] of items.entries()) {
        const id = key(item);
        let target = targets.get(id);
        if (!target) {target = { queue: [], active: 0, exclusive: false }; targets.set(id, target);}
        target.queue.push(index);
    }
    /** Active items by the exclusive and inclusive resources they hold, worker slots in use, and whether a serial item runs. */
    const held = new Map<string, number>(), shared = new Map<string, number>();
    let running = 0, serial = false, slots = 0;
    /** Worker slots an item takes: more for one that needs several, never more than the limit. */
    const weight = (index: number): number => Math.max(1, Math.min(limit, Math.floor(needs[index]?.workers ?? 1)));
    const available = (index: number): boolean => {
        const need = needs[index];
        if (!need) {return slots < limit;}
        if (need.serial) {return !running;}
        return need.exclusive.every(resource => !held.has(resource) && !shared.has(resource)) && (need.inclusive ?? []).every(resource => !held.has(resource))
            && (!running || slots + weight(index) <= limit);
    };
    const controller = new AbortController();
    const waiting = new Set<() => void>();
    const wake = (): void => {const callbacks = [...waiting]; waiting.clear(); for (const callback of callbacks) {callback();}};
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', wake, { once: true });
    drain?.addEventListener('abort', wake, { once: true });
    const results = new Array<R>(items.length);
    // Workers set failed; `as boolean` keeps reads after the awaits from narrowing to false.
    let admitted = 0, failed = false as boolean, failure: unknown;
    /** The target's next item whose resources are free, from the front or the end. */
    const candidate = (target: Target, fromEnd: boolean): number | undefined => {
        const { queue } = target;
        for (let step = 0; step < queue.length; step++) {
            const position = fromEnd ? queue.length - 1 - step : step;
            if (available(queue[position]!)) {return position;}
        }
        return undefined;
    };
    const take = (fromEnd: boolean): { target: Target; index: number } | undefined => {
        if (serial) {return undefined;}
        let chosen: Target | undefined, chosenPosition = 0, chosenIndex = 0, exclusive = false;
        for (const target of targets.values()) {
            if (!target.queue.length || target.exclusive || (chosen && target.active > chosen.active)) {continue;}
            const position = candidate(target, fromEnd);
            if (position === undefined) {continue;}
            const index = target.queue[position]!;
            if (chosen && target.active === chosen.active && (fromEnd ? index < chosenIndex : index > chosenIndex)) {continue;}
            const parallel = parallelEligible(items[index] as T, index);
            if (target.active && !parallel) {continue;}
            chosen = target; chosenPosition = position; chosenIndex = index; exclusive = !parallel;
        }
        if (!chosen) {return undefined;}
        chosen.queue.splice(chosenPosition, 1);
        chosen.active++; chosen.exclusive = exclusive; admitted++;
        const need = needs[chosenIndex];
        running++; serial = !!need?.serial; slots += weight(chosenIndex);
        for (const resource of need?.exclusive ?? []) {held.set(resource, (held.get(resource) ?? 0) + 1);}
        for (const resource of need?.inclusive ?? []) {shared.set(resource, (shared.get(resource) ?? 0) + 1);}
        return { target: chosen, index: chosenIndex };
    };
    const unhold = (map: Map<string, number>, resource: string): void => {const count = (map.get(resource) ?? 1) - 1; if (count) {map.set(resource, count);} else {map.delete(resource);}};
    const release = (index: number): void => {
        const need = needs[index];
        running--; slots -= weight(index); if (need?.serial) {serial = false;}
        for (const resource of need?.exclusive ?? []) {unhold(held, resource);}
        for (const resource of need?.inclusive ?? []) {unhold(shared, resource);}
    };
    try {
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async (_, worker) => {
            while (!controller.signal.aborted) {
                let selected: ReturnType<typeof take>;
                try {
                    selected = drain?.aborted ? undefined : take(fastLane && worker === 0);
                    if (!selected) {
                        if (admitted === items.length || drain?.aborted) {return;}
                        const idle = Date.now();
                        await new Promise<void>(resolve => waiting.add(resolve));
                        scheduling.onWait?.(worker, idle, Date.now());
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
                    if (selected) {selected.target.active--; selected.target.exclusive = false; release(selected.index); wake();}
                }
            }
        }));
        if (failed) {throw failure;}
        signal?.throwIfAborted();
        return results;
    } finally {
        signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', wake);
        drain?.removeEventListener('abort', wake);
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
