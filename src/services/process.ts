import { ChildProcess, spawn } from 'node:child_process';
import { helperPath, scriptPath } from './assets';
import { randomUUID } from 'node:crypto';
import { constants, setPriority } from 'node:os';
import { cleanupPosixOwner } from './posixProcesses';
import { OutputTail } from '../core/outputTail';
import { Cancelled, EnvironmentError } from '../core/errors';
import { resolveOwnedCommand } from './executable';

export { Cancelled };

/** Exit code and stderr prefix of Testy.ProcessHost's own failures (backend/Testy.ProcessHost/Program.cs). */
const processHostFailure = 125;
const processHostMarker = 'Testy could not own the process tree:';

/** Abort reason for disposal: owned processes are killed at once, skipping the graceful phase. */
export class Shutdown extends Cancelled {}

/** After a child error (for example a failed signal) its tree is force-killed; completion
 * waits this long for it to close before reporting the error anyway. */
export const processTiming = { errorCloseMs: 5_000 };

/** Whether owned commands start below normal priority (see setProcessPriority). */
let belowNormal = false;
/** POSIX nice value for below-normal priority. */
const belowNormalNice = 10;

/** Start later owned commands (builds, instrumentation, test hosts) below normal priority, so a busy run leaves the editor
 * responsive, or at normal priority. Descendants inherit it. Already running processes keep theirs. */
export function setProcessPriority(priority: 'belowNormal' | 'normal'): void { belowNormal = priority === 'belowNormal'; }

/** The tail of each stream kept in a ProcessResult. */
const capturedOutputChars = 1024 * 1024;

export interface ProcessResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ProcessOptions {
    readonly cwd: string;
    readonly signal?: AbortSignal | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly output?: ((text: string) => void) | undefined;
    readonly timeoutMs?: number;
    readonly dotnetHost?: string;
    /** Build commands may leave shared compiler servers; test processes may not. */
    readonly cleanupDescendants?: boolean;
    /** A short-lived tool that starts no processes of its own, such as a coverage snapshot: spawned directly, without the process
     * owner (whose start-up would cost more than the tool), in its own process group, and killed directly on cancellation or timeout. */
    readonly direct?: boolean;
    /** Record a stretch of preparation work on the run timeline (see Timeline.begin); call the result when it ends. */
    readonly track?: ((name: string, category: 'build' | 'discovery' | 'instrumentation', details?: Readonly<Record<string, string | number | boolean>>) => (more?: Readonly<Record<string, string | number | boolean>>) => void) | undefined;
}

export interface OwnedProcess {
    readonly child: ChildProcess;
    readonly done: Promise<ProcessResult>;
    readonly interruption?: Error | undefined;
    stop(): void;
}

/** Variables that make every .NET process load code. The owner is itself a .NET
 * process, so it receives them under another name and restores them for the
 * command alone (see Testy.ProcessHost). */
const ownerHidden = new Set(['DOTNET_STARTUP_HOOKS', 'TESTY_RUNTIME_OBSERVATION']);
const ownerHiddenPrefix = 'TESTY_CHILD_ENV_';

function hideFromOwner(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(env).map(([name, value]) =>
        ownerHidden.has(name.toUpperCase()) ? [ownerHiddenPrefix + name.toUpperCase(), value] : [name, value]));
}

/** Every subprocess tree has an owner. Never use global process-name cancellation. */
export function startProcess(command: string, args: readonly string[], options: ProcessOptions): OwnedProcess {
    options.signal?.throwIfAborted();
    const windowsOwner = process.platform === 'win32' && options.cleanupDescendants !== false && !options.direct;
    const posixOwner = process.platform !== 'win32' && !options.direct;
    const owner = randomUUID();
    const started = Date.now();
    const env: NodeJS.ProcessEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...options.env, TESTY_PROCESS_OWNER: owner };
    const lowered = belowNormal;
    const executable = windowsOwner ? options.dotnetHost ?? 'dotnet' : posixOwner ? process.execPath : command;
    const arguments_ = windowsOwner ? [helperPath('processhost', 'Testy.ProcessHost.dll'), command, ...args]
        : posixOwner ? [scriptPath('posixOwner')] : [...args];
    const child = spawn(executable, arguments_, {
        cwd: options.cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: [windowsOwner || posixOwner ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: posixOwner ? { ...env, TESTY_PROCESS_OWNER: undefined, ELECTRON_RUN_AS_NODE: '1' }
            : windowsOwner ? { ...hideFromOwner(env), ...lowered ? { TESTY_PROCESS_PRIORITY: 'belowNormal' } : {} } : env
    });
    // An unowned Windows command (one that may leave shared servers) is lowered directly; owners lower the command themselves.
    if (lowered && !windowsOwner && !posixOwner && child.pid) {try {setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);} catch { /* unchanged */ }}
    let cancelled = false;
    let timedOut = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let failure: Error | undefined;
    let failureTimer: NodeJS.Timeout | undefined;
    // Callers use the captured text only for diagnostics and short answers; streaming goes through options.output.
    const stdout = new OutputTail(capturedOutputChars);
    const stderr = new OutputTail(capturedOutputChars);
    const teardowns: Promise<void>[] = [];
    let posixCleanup: Promise<void> | undefined;
    const cleanPosix = (): void => {
        if (posixCleanup) {return;}
        posixCleanup = cleanupPosixOwner(owner, started);
        void posixCleanup.catch(() => undefined); teardowns.push(posixCleanup);
    };
    let windowsKillStarted = false;
    child.stdin?.on('error', () => undefined);
    if (posixOwner) {
        child.stdin!.write(JSON.stringify({ command, args, owner, cleanupDescendants: options.cleanupDescendants !== false, electronRunAsNode: env.ELECTRON_RUN_AS_NODE,
            ...lowered ? { priority: belowNormalNice } : {} }) + '\n');
    }
    const killTree = (force: boolean): void => {
        if (!child.pid) {return;}
        try {
            if (process.platform === 'win32') {
                if (windowsOwner && !force && child.stdin?.writable) {
                    child.stdin.write('cancel\n', error => {if (error) {killTree(true);}});
                    return;
                }
                if (windowsKillStarted) {return;}
                windowsKillStarted = true;
                teardowns.push(new Promise<void>(resolve => {
                    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    killer.once('error', () => {child.kill(); resolve();});
                    killer.once('close', code => {if (code !== 0 && !closed) {child.kill();} resolve();});
                }));
            } else {
                if (!force && child.stdin?.writable) {child.stdin.write('cancel\n', error => {if (error) {killTree(true);}}); return;}
                process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {child.kill(force ? 'SIGKILL' : 'SIGTERM');}
        } finally {
            if (force && posixOwner) {cleanPosix();}
        }
    };
    const stop = (): void => {
        if (closed || cancelled) {return;}
        cancelled = true;
        if (options.signal?.reason instanceof Shutdown) {killTree(true); return;}
        killTree(false);
        killTimer = setTimeout(() => killTree(true), posixOwner ? 5000 : 1500);
        killTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 600_000);
    timeout.unref();
    const done = new Promise<ProcessResult>((resolve, reject) => {
        child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (text: string) => {
            stdout.append(text); options.output?.(text);
        });
        child.stderr?.on('data', (text: string) => {
            stderr.append(text); options.output?.(text);
        });
        const release = (): void => {
            clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(failureTimer);
            options.signal?.removeEventListener('abort', stop);
        };
        // 'error' also follows a failed kill while the child still runs. Never report
        // completion for a live tree: kill it and let 'close' settle, within a bound.
        child.on('error', error => {
            if (failure || closed) {return;}
            failure = error;
            if (child.pid === undefined) {return;} // Spawning failed; 'close' follows at once.
            killTree(true);
            failureTimer = setTimeout(() => {release(); reject(error);}, processTiming.errorCloseMs);
            failureTimer.unref();
        });
        child.once('exit', (code, signal) => {
            // A killed/crashed owner needs a fallback scan. Normal MTP failure
            // exit 2 already completed cleanup in the supervisor.
            if (posixOwner && (signal || ((code === 1 || code === 127) && (cancelled || options.cleanupDescendants !== false)))) {cleanPosix();}
        });
        child.once('close', code => {
            closed = true;
            // Kill any remaining descendants of our own detached process group
            // before reporting cancellation complete.
            if ((cancelled || failure) && !windowsOwner && !posixOwner) {killTree(true);}
            release();
            void Promise.all(teardowns).then((): unknown => undefined, (error: unknown) => {
                options.output?.(`Process cleanup failed: ${String(error)}\n`); return error;
            }).then(cleanupError => settle(code, cleanupError), reject);
        });
        const settle = (code: number | null, cleanupError: unknown): void => {
            if (failure) {reject(failure);}
            else if (timedOut) {reject(new Error(`The command exceeded its time limit: ${command}`));}
            else if (cancelled) {reject(new Cancelled());}
            else if (cleanupError !== undefined) {reject(cleanupError instanceof Error ? cleanupError : new Error('Process cleanup failed.', { cause: cleanupError }));}
            else if (windowsOwner && code === processHostFailure && stderr.text().includes(processHostMarker)) {
                // The host never started the command; do not report this as the command's own failure.
                const text = stderr.text();
                reject(new EnvironmentError('dotnet-start', `Could not start ${command}: ${text.slice(text.indexOf(processHostMarker) + processHostMarker.length).trim()}`));
            }
            else {resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text() });}
        };
    });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) {stop();}
    // Consumers may await connection establishment before awaiting exit.
    void done.catch(() => undefined);
    return { child, done, stop, get interruption() {
        return timedOut ? new Error(`The command exceeded its time limit: ${command}`) : cancelled ? new Cancelled() : undefined;
    } };
}

export async function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
    // startProcess is synchronous, so the Windows owner's bare host name is resolved from
    // absolute PATH entries here; libuv would otherwise search the workspace first.
    if (process.platform === 'win32' && options.cleanupDescendants !== false && !options.direct) {
        const dotnetHost = await resolveOwnedCommand(options.dotnetHost ?? 'dotnet', options.env, options.cwd);
        return startProcess(command, args, { ...options, dotnetHost }).done;
    }
    return startProcess(command, args, options).done;
}

export function requireSuccess(result: ProcessResult, operation: string): ProcessResult {
    if (result.code !== 0) {throw new Error(`${operation} failed (exit ${result.code}).\n${result.stderr || result.stdout}`);}
    return result;
}
