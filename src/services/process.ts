import { ChildProcess, spawn } from 'node:child_process';

export class Cancelled extends Error {
    constructor() { super('Run cancelled'); this.name = 'AbortError'; }
}

export interface ProcessResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ProcessOptions {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly env?: NodeJS.ProcessEnv;
    readonly output?: (text: string) => void;
    readonly timeoutMs?: number;
}

export interface OwnedProcess {
    readonly child: ChildProcess;
    readonly done: Promise<ProcessResult>;
    stop(): void;
}

/** Every subprocess tree has an owner. Never use global process-name cancellation. */
export function startProcess(command: string, args: readonly string[], options: ProcessOptions): OwnedProcess {
    options.signal?.throwIfAborted();
    const child = spawn(command, [...args], {
        cwd: options.cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...options.env }
    });
    let cancelled = false;
    let timedOut = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stdout = '';
    let stderr = '';
    const teardowns: Promise<void>[] = [];
    let windowsKillStarted = false;
    const limit = 8 * 1024 * 1024;
    const killTree = (force: boolean): void => {
        if (!child.pid) {return;}
        try {
            if (process.platform === 'win32') {
                if (windowsKillStarted) {return;}
                windowsKillStarted = true;
                teardowns.push(new Promise<void>(resolve => {
                    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    killer.once('error', () => {child.kill(); resolve();});
                    killer.once('close', code => {if (code !== 0 && !closed) {child.kill();} resolve();});
                }));
            } else {
                process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {child.kill(force ? 'SIGKILL' : 'SIGTERM');}
        }
    };
    const stop = (): void => {
        if (closed || cancelled) {return;}
        cancelled = true;
        killTree(false);
        killTimer = setTimeout(() => killTree(true), 1500);
        killTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 600_000);
    timeout.unref();
    const done = new Promise<ProcessResult>((resolve, reject) => {
        child.stdout?.on('data', (data: Buffer) => {
            const text = data.toString(); stdout = (stdout + text).slice(-limit); options.output?.(text);
        });
        child.stderr?.on('data', (data: Buffer) => {
            const text = data.toString(); stderr = (stderr + text).slice(-limit); options.output?.(text);
        });
        child.once('error', reject);
        child.once('close', async code => {
            closed = true;
            clearTimeout(timeout);
            // Kill any remaining descendants of our own detached process group
            // before reporting cancellation complete.
            if (cancelled) {killTree(true);}
            if (killTimer) {clearTimeout(killTimer);}
            options.signal?.removeEventListener('abort', stop);
            await Promise.all(teardowns);
            if (timedOut) {reject(new Error(`The command exceeded its time limit: ${command}`));}
            else if (cancelled) {reject(new Cancelled());}
            else {resolve({ code: code ?? -1, stdout, stderr });}
        });
    });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) {stop();}
    // Consumers may await connection establishment before awaiting exit.
    void done.catch(() => undefined);
    return { child, done, stop };
}

export async function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
    return startProcess(command, args, options).done;
}

export function requireSuccess(result: ProcessResult, operation: string): ProcessResult {
    if (result.code !== 0) {throw new Error(`${operation} failed (exit ${result.code}).\n${result.stderr || result.stdout}`);}
    return result;
}
