import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanupPosixOwner } from './posixProcesses';

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
    readonly dotnetHost?: string;
    /** Build commands may leave shared compiler servers; test processes may not. */
    readonly cleanupDescendants?: boolean;
}

export interface OwnedProcess {
    readonly child: ChildProcess;
    readonly done: Promise<ProcessResult>;
    readonly interruption?: Error;
    stop(): void;
}

/** Every subprocess tree has an owner. Never use global process-name cancellation. */
export function startProcess(command: string, args: readonly string[], options: ProcessOptions): OwnedProcess {
    options.signal?.throwIfAborted();
    const windowsOwner = process.platform === 'win32' && options.cleanupDescendants !== false;
    const posixOwner = process.platform !== 'win32';
    const owner = randomUUID();
    const env: NodeJS.ProcessEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...options.env, TESTY_PROCESS_OWNER: owner };
    const executable = windowsOwner ? options.dotnetHost ?? 'dotnet' : posixOwner ? process.execPath : command;
    const arguments_ = windowsOwner ? [path.join(__dirname, '../../dist/processhost/Testy.ProcessHost.dll'), command, ...args]
        : posixOwner ? [path.join(__dirname, 'posixOwner.js')] : [...args];
    const child = spawn(executable, arguments_, {
        cwd: options.cwd, shell: false, detached: process.platform !== 'win32',
        windowsHide: true, stdio: [windowsOwner || posixOwner ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: posixOwner ? { ...env, TESTY_PROCESS_OWNER: undefined, ELECTRON_RUN_AS_NODE: '1' } : env
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
    child.stdin?.on('error', () => undefined);
    if (posixOwner) {
        child.stdin!.write(JSON.stringify({ command, args, owner, cleanupDescendants: options.cleanupDescendants !== false, electronRunAsNode: env.ELECTRON_RUN_AS_NODE }) + '\n');
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
                if (!force && child.stdin?.writable) {child.stdin.write('cancel\n'); return;}
                process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
                if (force) {
                    const cleanup = cleanupPosixOwner(owner);
                    void cleanup.catch(() => undefined); teardowns.push(cleanup);
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {child.kill(force ? 'SIGKILL' : 'SIGTERM');}
        }
    };
    const stop = (): void => {
        if (closed || cancelled) {return;}
        cancelled = true;
        killTree(false);
        killTimer = setTimeout(() => killTree(true), posixOwner ? 5000 : 1500);
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
        child.once('exit', (_code, signal) => {
            // If the independent owner itself is killed, the surviving host
            // makes a final ownership scan. Ordinary exits clean up in the owner.
            if (posixOwner && signal) {
                const cleanup = cleanupPosixOwner(owner);
                void cleanup.catch(() => undefined); teardowns.push(cleanup);
            }
        });
        child.once('close', async code => {
            closed = true;
            clearTimeout(timeout);
            // Kill any remaining descendants of our own detached process group
            // before reporting cancellation complete.
            if (cancelled && !windowsOwner && !posixOwner) {killTree(true);}
            if (killTimer) {clearTimeout(killTimer);}
            options.signal?.removeEventListener('abort', stop);
            let cleanupError: unknown;
            try {await Promise.all(teardowns);} catch (error) {
                cleanupError = error; options.output?.(`Process cleanup failed: ${String(error)}\n`);
            }
            if (timedOut) {reject(new Error(`The command exceeded its time limit: ${command}`));}
            else if (cancelled) {reject(new Cancelled());}
            else if (cleanupError) {reject(cleanupError);}
            else {resolve({ code: code ?? -1, stdout, stderr });}
        });
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
    return startProcess(command, args, options).done;
}

export function requireSuccess(result: ProcessResult, operation: string): ProcessResult {
    if (result.code !== 0) {throw new Error(`${operation} failed (exit ${result.code}).\n${result.stderr || result.stdout}`);}
    return result;
}
