import { Cancelled } from '../services/process';

export interface ChangeBatch { readonly files: readonly string[]; readonly full: boolean; }
export type SchedulerState = 'idle' | 'waiting' | 'running' | 'paused';
export interface SchedulerOptions {
    readonly run: (batch: ChangeBatch, signal: AbortSignal) => Promise<void>;
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

/** Serializes builds/runs while preserving every change across cancellation. */
export class Scheduler {
    private revision = 0;
    private readonly pending = new Map<string, number>();
    private fullRevision: number | undefined;
    private active: { readonly kind: 'auto' | 'manual'; readonly controller: AbortController } | undefined;
    private readonly manual: ManualJob[] = [];
    private cancelTimer: (() => void) | undefined;
    private ready = false;
    private paused = false;
    private disposed = false;
    private debounce: number;
    private readonly schedule: NonNullable<SchedulerOptions['schedule']>;

    constructor(private readonly options: SchedulerOptions) {
        this.debounce = options.debounce;
        this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer); });
    }

    get isRunning(): boolean { return !!this.active; }
    get isPaused(): boolean { return this.paused; }

    request(files: readonly string[], full = false): void {
        if (this.disposed) {return;}
        for (const file of files) {this.pending.set(file, ++this.revision);}
        if (full) {this.fullRevision = ++this.revision;}
        if (this.active?.kind === 'auto') {this.active.controller.abort();}
        this.arm();
    }

    setDebounce(delay: number): void {
        this.debounce = Math.max(0, delay);
        if (this.cancelTimer) {this.arm();}
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        if (paused) {
            this.cancelTimer?.(); this.cancelTimer = undefined; this.ready = false;
            if (this.active?.kind === 'auto') {this.active.controller.abort();}
        } else if (this.pending.size || this.fullRevision !== undefined) {this.arm();}
        this.publish();
    }

    runManual(run: ManualJob['run'], signal?: AbortSignal, coversPending = false): Promise<void> {
        if (this.disposed || signal?.aborted) {return Promise.reject(new Cancelled());}
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const snapshot = new Map(this.pending);
        const full = this.fullRevision;
        return new Promise((resolve, reject) => {
            this.manual.push({ controller, run, resolve: () => {
                if (coversPending && !controller.signal.aborted) {
                    for (const [file, revision] of snapshot) {if (this.pending.get(file) === revision) {this.pending.delete(file);}}
                    if (this.fullRevision === full) {this.fullRevision = undefined;}
                }
                resolve();
            }, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
            if (this.active?.kind === 'auto') {
                this.active.controller.abort();
                this.ready = true;
            }
            this.pump();
        });
    }

    dispose(): void {
        this.disposed = true;
        this.cancelTimer?.(); this.cancelTimer = undefined;
        this.active?.controller.abort();
        for (const job of this.manual.splice(0)) { job.cleanup(); job.reject(new Cancelled()); }
    }

    private arm(): void {
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
            void job.run(job.controller.signal).then(job.resolve, job.reject).finally(() => {
                job.cleanup(); this.active = undefined; this.publish(); this.pump();
            });
            return;
        }
        if (this.paused || !this.ready || (!this.pending.size && this.fullRevision === undefined)) { this.publish(); return; }
        const snapshot = new Map(this.pending);
        const full = this.fullRevision;
        const controller = new AbortController();
        this.active = { kind: 'auto', controller };
        this.ready = false;
        this.publish();
        void this.options.run({ files: [...snapshot.keys()], full: full !== undefined }, controller.signal).then(() => {
            if (controller.signal.aborted) {return;}
            for (const [file, revision] of snapshot) {if (this.pending.get(file) === revision) {this.pending.delete(file);}}
            if (this.fullRevision === full) {this.fullRevision = undefined;}
        }).catch(error => {
            if (!controller.signal.aborted && (error as Error)?.name !== 'AbortError') {this.options.error?.(error);}
        }).finally(() => {
            this.active = undefined; this.publish(); this.pump();
        });
    }

    private publish(): void {
        this.options.state?.(this.paused ? 'paused' : this.active ? 'running' : this.cancelTimer ? 'waiting' : 'idle');
    }
}
