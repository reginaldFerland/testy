import { Cancelled } from './errors';
import { isAbortError } from './errors';

/** `explicit`: the user asked to run what the files affect, as for a save, but whether or not they changed since the last run. */
export interface ChangeBatch { readonly files: readonly string[]; readonly full: boolean; readonly generation?: number; readonly explicit?: boolean; }
export type SchedulerState = 'idle' | 'waiting' | 'running' | 'paused';
export interface SchedulerOptions {
    /** `superseded` aborts, with the newly changed files as its reason (see Superseded), when changes arrive while an automatic run
     * tests: the run may let test processes the changes cannot affect finish, and must then end. `signal` still aborts it at once,
     * or once the grace period (see setGrace) has passed. */
    readonly run: (batch: ChangeBatch, signal: AbortSignal, superseded: AbortSignal) => Promise<void>;
    readonly state?: (state: SchedulerState) => void;
    readonly error?: (error: unknown) => void;
    readonly schedule?: (callback: () => void, delay: number) => () => void;
    readonly debounce: number;
}
interface ManualJob {
    readonly controller: AbortController;
    readonly run: (signal: AbortSignal) => Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
}

/** The reason of a run's `superseded` signal: the files that changed since it started, growing with each later change. */
export class Superseded extends Error {
    private readonly changed: string[];
    private readonly listeners = new Set<(files: readonly string[]) => void>();
    constructor(files: readonly string[]) { super('Superseded by newer changes'); this.name = 'AbortError'; this.changed = [...files]; }
    get files(): readonly string[] { return this.changed; }
    /** Call `listener` with the files of each later change, until the returned function removes it. */
    onChange(listener: (files: readonly string[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    add(files: readonly string[]): void { this.changed.push(...files); for (const listener of [...this.listeners]) {listener(files);} }
}

/** Serializes builds/runs while preserving every change across cancellation. */
export class Scheduler {
    private revision = 0;
    private readonly pending = new Map<string, number>();
    private fullRevision: number | undefined;
    private active: { readonly kind: 'auto' | 'manual'; readonly controller: AbortController; readonly superseded?: AbortController; idle?: boolean; deadline?: () => void } | undefined;
    /** How long a superseded automatic run may take to finish its running test processes; 0 aborts it at once. */
    private grace = 0;
    private readonly manual: ManualJob[] = [];
    private cancelTimer: (() => void) | undefined;
    private ready = false;
    private paused = false;
    private disposed = false;
    private debounce: number;
    private readonly schedule: NonNullable<SchedulerOptions['schedule']>;
    /** Low-priority work that starts once everything is quiet for its delay (see setIdle). */
    private idle: { readonly run: (signal: AbortSignal) => Promise<void>; readonly delay: number } | undefined;
    private cancelIdle: (() => void) | undefined;

    constructor(private readonly options: SchedulerOptions) {
        this.debounce = options.debounce;
        this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
    }

    get isRunning(): boolean { return !!this.active; }
    get isPaused(): boolean { return this.paused; }
    /** Accumulated changes as one batch, for running them on demand. */
    get pendingBatch(): ChangeBatch {
        return { files: [...this.pending.keys()], full: this.fullRevision !== undefined, ...(this.fullRevision !== undefined ? { generation: this.fullRevision } : {}) };
    }

    /** Stop the active run. Its changes stay pending for the next run. */
    cancel(): void { this.active?.controller.abort(); }

    /** How long, in milliseconds, an automatic run that newer changes supersede may keep running to finish its test processes. */
    setGrace(milliseconds: number): void { this.grace = Math.max(0, milliseconds); }

    /** Newer changes arrived during an automatic run: let it finish what it is running within the grace period, or abort it. */
    private supersede(files: readonly string[]): void {
        const active = this.active;
        if (active?.kind !== 'auto') {return;}
        if (!this.grace || active.idle || !active.superseded || !files.length) {active.controller.abort(); return;}
        if (active.superseded.signal.aborted) {(active.superseded.signal.reason as Superseded).add(files); return;}
        active.superseded.abort(new Superseded(files));
        active.deadline = this.schedule(() => active.controller.abort(), this.grace);
    }

    /** Run `job` once nothing has been pending, running or waiting for `delay` milliseconds. Any change, manual run or pause
     * cancels it like an automatic run, and it waits for the next quiet period again; it ends once it completes or a later call
     * replaces it (undefined removes it). Its errors are reported like an automatic run's. */
    setIdle(job: ((signal: AbortSignal) => Promise<void>) | undefined, delay = 0): void {
        this.idle = job && { run: job, delay: Math.max(0, delay) };
        this.armIdle();
    }

    request(files: readonly string[], full = false): void {
        if (this.disposed) {return;}
        for (const file of files) {this.pending.set(file, ++this.revision);}
        if (full) {this.fullRevision = ++this.revision;}
        if (full) {if (this.active?.kind === 'auto') {this.active.controller.abort();}} else {this.supersede(files);}
        this.arm();
    }

    setDebounce(delay: number): void {
        this.debounce = Math.max(0, delay);
        if (this.cancelTimer) {this.arm();}
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        if (paused) {
            this.cancelIdle?.(); this.cancelIdle = undefined;
            this.cancelTimer?.(); this.cancelTimer = undefined; this.ready = false;
            if (this.active?.kind === 'auto') {this.active.controller.abort();}
        } else if (this.pending.size || this.fullRevision !== undefined) {this.arm();} else {this.armIdle();}
        this.publish();
    }

    runManual(run: ManualJob['run'], signal?: AbortSignal, coversPending = false): Promise<void> {
        if (this.disposed || signal?.aborted) {return Promise.reject(new Cancelled());}
        const controller = new AbortController();
        const snapshot = new Map(this.pending);
        const full = this.fullRevision;
        return new Promise((resolve, reject) => {
            const abort = (): void => {
                controller.abort();
                const index = this.manual.indexOf(job);
                if (index !== -1) {
                    this.manual.splice(index, 1); job.cleanup(); job.reject(new Cancelled());
                }
            };
            const job: ManualJob = { controller, run, resolve: () => {
                if (coversPending && !controller.signal.aborted) {
                    for (const [file, revision] of snapshot) {if (this.pending.get(file) === revision) {this.pending.delete(file);}}
                    if (this.fullRevision === full) {this.fullRevision = undefined;}
                }
                resolve();
            }, reject, cleanup: () => signal?.removeEventListener('abort', abort) };
            this.manual.push(job);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) {abort(); return;}
            if (this.active?.kind === 'auto') {
                this.active.controller.abort();
                this.ready = true;
            }
            this.pump();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.cancelIdle?.(); this.cancelIdle = undefined; this.idle = undefined;
        this.cancelTimer?.(); this.cancelTimer = undefined;
        this.active?.controller.abort();
        for (const job of this.manual.splice(0)) { job.cleanup(); job.reject(new Cancelled()); }
    }

    private arm(): void {
        this.cancelIdle?.(); this.cancelIdle = undefined;
        this.cancelTimer?.(); this.cancelTimer = undefined; this.ready = false;
        if (!this.paused && (this.pending.size || this.fullRevision !== undefined)) {
            this.cancelTimer = this.schedule(() => {
                this.cancelTimer = undefined; this.ready = true; this.pump();
            }, this.debounce);
        }
        this.publish();
    }

    private pump(): void {
        if (this.disposed || this.active) {return;}
        const job = this.manual.shift();
        if (job) {
            if (job.controller.signal.aborted) { job.cleanup(); job.reject(new Cancelled()); this.pump(); return; }
            this.active = { kind: 'manual', controller: job.controller };
            this.publish();
            // An async wrapper keeps synchronous throws from wedging `active`.
            void (async () => job.run(job.controller.signal))().then(job.resolve, job.reject).finally(() => {
                job.cleanup(); this.active = undefined; this.publish(); this.pump();
            });
            return;
        }
        if (this.paused || !this.ready || (!this.pending.size && this.fullRevision === undefined)) { this.publish(); this.armIdle(); return; }
        const snapshot = new Map(this.pending);
        const full = this.fullRevision;
        const controller = new AbortController(), superseded = new AbortController();
        const active: NonNullable<Scheduler['active']> = { kind: 'auto', controller, superseded };
        this.active = active;
        this.ready = false;
        this.publish();
        void (async () => this.options.run({ files: [...snapshot.keys()], full: full !== undefined, ...(full !== undefined ? { generation: full } : {}) }, controller.signal, superseded.signal))().then(() => {
            // A superseded run did not run everything its changes select, even when it resolves.
            if (controller.signal.aborted || superseded.signal.aborted) {return;}
            for (const [file, revision] of snapshot) {if (this.pending.get(file) === revision) {this.pending.delete(file);}}
            if (this.fullRevision === full) {this.fullRevision = undefined;}
        }).catch((error: unknown) => {
            if (!controller.signal.aborted && !isAbortError(error)) {this.options.error?.(error);}
        }).finally(() => {
            active.deadline?.();
            this.active = undefined; this.publish(); this.pump();
        });
    }

    /** Start the idle job's quiet period when nothing else is pending, running or waiting. */
    private armIdle(): void {
        this.cancelIdle?.(); this.cancelIdle = undefined;
        if (!this.quiet()) {return;}
        this.cancelIdle = this.schedule(() => {this.cancelIdle = undefined; this.startIdle();}, this.idle!.delay);
    }

    private quiet(): boolean {
        return !!this.idle && !this.disposed && !this.paused && !this.active && !this.manual.length && !this.cancelTimer && !this.pending.size && this.fullRevision === undefined;
    }

    private startIdle(): void {
        if (!this.quiet()) {return;}
        const job = this.idle!, controller = new AbortController();
        this.idle = undefined;
        this.active = { kind: 'auto', controller, idle: true };
        this.publish();
        void (async () => job.run(controller.signal))().catch((error: unknown) => {
            if (!controller.signal.aborted && !isAbortError(error)) {this.options.error?.(error);}
        }).finally(() => {
            // Cancelled before it finished: it waits for the next quiet period, unless something replaced it.
            if (controller.signal.aborted) {this.idle ??= job;}
            this.active = undefined; this.publish(); this.pump();
        });
    }

    private publish(): void {
        this.options.state?.(this.paused ? 'paused' : this.active ? 'running' : this.cancelTimer ? 'waiting' : 'idle');
    }
}
