import type { SelectionCause } from './selection';

/** One test batch of a run as the queue view shows it (see engine/execute). */
export interface QueueEntry {
    /** The batch's first file; its parts share it, distinguished by `part`. */
    readonly id: string;
    readonly name: string;
    readonly part?: { readonly index: number; readonly count: number } | undefined;
    readonly state: 'queued' | 'running' | 'passed' | 'failed' | 'stopped';
    readonly tests: number;
    readonly failed?: number | undefined;
    /** The learned time it is expected to take, in milliseconds. */
    readonly expected?: number | undefined;
    /** Epoch milliseconds it started, and how long it took once done. */
    readonly started?: number | undefined;
    readonly elapsed?: number | undefined;
    readonly cause?: SelectionCause | undefined;
}

/** The entries of a finished or cancelled run: what never started is stopped, what was still running (cancelled) too. */
export function settleQueue(entries: readonly QueueEntry[], now: number): QueueEntry[] {
    return entries.map(entry => entry.state === 'queued' || entry.state === 'running'
        ? { ...entry, state: 'stopped', ...entry.started === undefined ? {} : { elapsed: now - entry.started } } : entry);
}
