import { isAbortError } from './errors';

export interface BackgroundSweepOptions {
    /** Stat every known input and return those that changed; see SourceTracker.sweep. */
    readonly sweep: (signal: AbortSignal) => Promise<readonly string[]>;
    /** Changes the sweep found, which no watcher reported: they are marked and requested as an automatic run. */
    readonly changed: (files: readonly string[]) => Promise<void>;
    readonly error: (error: unknown) => void;
}

/** In `fileSystem` trigger mode, incremental runs read only the files watchers reported. After such a run this stats every
 * known input off the critical path, so a dropped event still leads to a follow-up run. A starting run stops the sweep, so it
 * never delays the run's own refresh; changes a sweep already applied are delivered even when it is stopped late. */
export class BackgroundSweep {
    private controller: AbortController | undefined;
    private running: Promise<void> = Promise.resolve();
    /** Changes requested by the latest sweep; a run of only these does not sweep again, so a file that keeps changing cannot loop. */
    private readonly requested = new Set<string>();
    private disposed = false;

    constructor(private readonly options: BackgroundSweepOptions) {}

    /** The settled state of the latest sweep, for tests and disposal. */
    get idle(): Promise<void> { return this.running; }

    /** A run is starting: stop any sweep. Returns whether the run's files are only the latest sweep's findings. */
    runStarting(files: readonly string[]): boolean {
        this.stop();
        const fromSweep = files.length > 0 && files.every(file => this.requested.has(file));
        this.requested.clear();
        return fromSweep;
    }

    start(): void {
        if (this.disposed) {return;}
        this.stop();
        const controller = this.controller = new AbortController();
        this.running = (async () => {
            try {
                const changed = await this.options.sweep(controller.signal);
                // Applied changes are delivered even if a run started meanwhile: its refresh no longer reports them.
                if (!changed.length || this.disposed) {return;}
                for (const file of changed) {this.requested.add(file);}
                await this.options.changed(changed);
            } catch (error) {
                if (!controller.signal.aborted && !isAbortError(error)) {this.options.error(error);}
            } finally {
                if (this.controller === controller) {this.controller = undefined;}
            }
        })();
    }

    stop(): void { this.controller?.abort(); this.controller = undefined; }

    dispose(): void { this.disposed = true; this.stop(); }
}
