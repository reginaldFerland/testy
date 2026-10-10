import { Cancelled, ProcessOptions, requireSuccess, runProcess } from '../process';
import { EnvironmentError } from '../../core/errors';
import { compareCodeUnits } from '../../core/paths';

/** Wait for shared work without letting one waiter's cancellation reject it for others. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {return work;}
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(new Cancelled());
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

export class SdkChecks {
    private readonly contexts = new Set<string>();
    private readonly versions = new Map<string, string>();
    private readonly checks = new Map<string, Promise<void>>();
    /** Every SDK check still running, including ones a reset or configuration change detached. */
    private readonly running = new Set<Promise<void>>();
    private controller = new AbortController();
    private generation = 0;

    /** One version check per SDK context, shared by concurrent callers. The check is
     * bound to the engine, not to any caller's cancellation (each caller stops waiting on
     * its own); reset and disposal stop it. */
    async ensure(dotnet: string, options: ProcessOptions, sdkContext = options.cwd): Promise<void> {
        const key = `${dotnet}\0${sdkContext}`; if (this.contexts.has(key)) {return;}
        let check = this.checks.get(key);
        if (!check) {
            const signal = this.controller.signal, generation = this.generation;
            const pending = check = (async () => {
                const version = requireSuccess(await runProcess(dotnet, ['--version'], { ...options, signal, output: undefined }), `Finding the .NET SDK for ${options.cwd}`).stdout.trim();
                if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 10) {throw new EnvironmentError('sdk-unsupported', `Testy requires .NET SDK 10 or later; ${options.cwd} selects ${version}. Check its global.json.`);}
                // A check detached by a reset or configuration change established nothing.
                if (generation === this.generation) {this.contexts.add(key); this.versions.set(key, version);}
            })();
            this.checks.set(key, pending); this.running.add(pending);
            const settle = (): void => {if (this.checks.get(key) === pending) {this.checks.delete(key);} this.running.delete(pending);};
            void pending.then(settle, settle);
        }
        await untilAborted(check, options.signal);
    }

    /** The distinct SDK versions the checks found, sorted: a roll-forward to a newly installed SDK changes them. */
    get resolved(): readonly string[] { return [...new Set(this.versions.values())].sort(compareCodeUnits); }

    /** Forget established SDK contexts; checks still running cannot establish theirs. */
    forget(): void { this.contexts.clear(); this.checks.clear(); this.generation++; }

    /** Signal every running check to stop without waiting for it. */
    abort(): void { this.controller.abort(); }

    /** Stop every SDK check, wait for its process, and forget what the checks established. */
    async stop(): Promise<void> {
        this.controller.abort(); this.forget(); this.versions.clear();
        await Promise.allSettled([...this.running]);
        this.controller = new AbortController();
    }
}
