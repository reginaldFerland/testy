import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { contentHash } from '../core/paths';
import { OutputTail } from '../core/outputTail';
import { Cancelled, ProcessOptions } from './process';

/** The server could not serve a request (it failed to start, crashed, or broke the protocol).
 * Callers fall back to a one-shot analyzer process. `retryable` marks a server that was
 * stopped on purpose (idle, disposed, evicted) while the request waited. */
export class AnalyzerServerUnavailable extends Error {
    constructor(message: string, readonly retryable = false) { super(message); this.name = 'AnalyzerServerUnavailable'; }
}
/** The analyzer reported an error for this request. The server remains usable. */
export class AnalyzerRequestFailed extends Error {
    constructor(message: string) { super(message); this.name = 'AnalyzerRequestFailed'; }
}

interface Pending {
    resolve(response: string): void;
    reject(error: Error): void;
    /** The request line was written, so the server may be working on it. */
    sent: boolean;
    /** Rejected to the caller already; the entry stays until the server acknowledges the cancel. */
    abandoned?: NodeJS.Timeout;
    settle(): void;
}

interface Refable { ref?(): unknown; unref?(): unknown }

const protocol = 1;
const responseHead = /^\{"id":(\d+),"(result|error)":/;

/** One analyzer process speaking the line protocol of backend/Testy.Analysis/AnalyzerServer.cs.
 * Requests run concurrently. Aborting one sends a cancel and rejects it at once; a server that
 * does not answer the cancel is killed, so an abandoned request cannot poison later ones. */
class AnalyzerServer {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, Pending>();
    private readonly stderr = new OutputTail(16 * 1024);
    private readonly ready: Promise<void>;
    private readonly exited: Promise<void>;
    private signalReady: () => void = () => undefined;
    private signalFailure: (error: Error) => void = () => undefined;
    private nextId = 1;
    private partial: string[] = [];
    private partialLength = 0;
    private idle?: NodeJS.Timeout;
    private started = false;
    private gone = false;
    /** No longer accepts requests; set before the process has necessarily exited. */
    closed = false;

    constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv, private readonly idleMs: number, startupMs: number,
        private readonly cancelMs: number, private readonly maxLine: number, private readonly onClosed: () => void) {
        this.ready = new Promise<void>((resolve, reject) => {this.signalReady = resolve; this.signalFailure = reject;});
        void this.ready.catch(() => undefined);
        // A neutral working directory never locks the workspace (Windows) and requests carry their own.
        this.child = spawn(command, args, { cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let exit!: () => void;
        this.exited = new Promise<void>(resolve => {exit = resolve;});
        this.child.once('close', (code, signal) => {
            const tail = this.stderr.text().trim();
            this.gone = true;
            this.terminate(new AnalyzerServerUnavailable(`The analyzer server exited unexpectedly (${signal ?? code}).${tail ? `\n${tail}` : ''}`), false);
            exit();
        });
        this.child.once('error', error => {
            this.gone = true;
            this.terminate(new AnalyzerServerUnavailable(`The analyzer server could not start: ${error.message}`), false);
            exit();
        });
        this.child.stdin!.on('error', () => undefined);
        this.child.stdout!.setEncoding('utf8'); this.child.stderr!.setEncoding('utf8');
        this.child.stdout!.on('data', (text: string) => this.receive(text));
        this.child.stderr!.on('data', (text: string) => this.stderr.append(text));
        const timer = setTimeout(() => this.terminate(new AnalyzerServerUnavailable('The analyzer server did not start in time.'), false), startupMs);
        timer.unref();
        void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
        this.refresh();
    }

    /** Whether the process ever reported readiness (a start failure is not a crash). */
    get hasStarted(): boolean { return this.started; }
    get busy(): boolean { return this.pending.size > 0; }

    /** Lines are bounded: a peer that never ends one would otherwise grow the buffer without limit. */
    private receive(text: string): void {
        if (this.overflowed) {return;}
        this.partial.push(text); this.partialLength += text.length;
        if (!text.includes('\n')) {
            if (this.partialLength > this.maxLine) {this.overflow();}
            return;
        }
        const lines = this.partial.join('').split('\n'), rest = lines.pop()!;
        this.partial = [rest]; this.partialLength = rest.length;
        for (const line of lines) {
            if (line.length > this.maxLine) {this.overflow(); return;}
            if (line.length) {this.line(line);}
        }
        if (rest.length > this.maxLine) {this.overflow();}
    }

    private overflowed = false;
    private overflow(): void {
        this.overflowed = true; this.partial = []; this.partialLength = 0;
        this.terminate(new AnalyzerServerUnavailable(`The analyzer server sent a line longer than ${this.maxLine} characters.`), false);
    }

    private line(line: string): void {
        if (!this.started) {
            let ready = false;
            try {ready = (JSON.parse(line) as { ready?: unknown }).ready === protocol;} catch {/* reported below */}
            if (!ready) {this.terminate(new AnalyzerServerUnavailable(`Unexpected analyzer server output: ${line.slice(0, 200)}`), false); return;}
            this.started = true; this.signalReady(); this.refresh(); return;
        }
        const head = responseHead.exec(line);
        if (!head || !line.endsWith('}')) {this.terminate(new AnalyzerServerUnavailable(`Invalid analyzer server response: ${line.slice(0, 200)}`), false); return;}
        // The answer to an abandoned request, or to one that already timed out.
        const entry = this.pending.get(Number(head[1]));
        if (!entry) {return;}
        const body = line.slice(head[0].length, -1);
        entry.settle();
        if (head[2] === 'result') {entry.resolve(body);}
        else {
            let message = body;
            try {message = JSON.parse(body) as string;} catch {/* keep the raw text */}
            entry.reject(new AnalyzerRequestFailed(message));
        }
    }

    /** Stop accepting requests and reject everything in flight. A graceful stop closes the
     * input so the server exits by itself; otherwise (or if it lingers) the process is killed. */
    private terminate(error: Error, graceful: boolean): void {
        if (!this.closed) {
            this.closed = true; this.onClosed(); clearTimeout(this.idle);
            if (graceful) {
                this.child.stdin?.end();
                const kill = setTimeout(() => this.child.kill('SIGKILL'), 2000);
                kill.unref();
                void this.exited.then(() => clearTimeout(kill));
            } else {this.child.kill('SIGKILL');}
        }
        this.signalFailure(error);
        for (const entry of [...this.pending.values()]) {entry.settle(); entry.reject(error);}
        this.refresh();
    }

    /** Hold the event loop only while startup, a request or a shutdown is outstanding. */
    private refresh(): void {
        const active = !this.gone && (this.closed || this.pending.size > 0 || !this.started);
        for (const handle of [this.child, this.child.stdin, this.child.stdout, this.child.stderr] as (Refable | null)[]) {
            if (active) {handle?.ref?.();} else {handle?.unref?.();}
        }
        clearTimeout(this.idle);
        if (!active && !this.closed) {
            this.idle = setTimeout(() => {void this.close(new AnalyzerServerUnavailable('The analyzer server was stopped.', true));}, this.idleMs);
            this.idle.unref();
        }
    }

    request(request: string, cwd: string, options: ProcessOptions): Promise<string> {
        const signal = options.signal;
        signal?.throwIfAborted();
        if (this.closed) {return Promise.reject(new AnalyzerServerUnavailable('The analyzer server was stopped.', true));}
        // One request per line: a raw newline would split it.
        if (/[\r\n]/.test(request)) {return Promise.reject(new AnalyzerServerUnavailable('The request cannot be sent as a single line.'));}
        const id = this.nextId++;
        return new Promise<string>((resolve, reject) => {
            const entry: Pending = { resolve, reject, sent: false, settle: () => {
                clearTimeout(timer); clearTimeout(entry.abandoned); signal?.removeEventListener('abort', onAbort);
                this.pending.delete(id); this.refresh();
            } };
            const onAbort = (): void => {
                const sent = entry.sent;
                entry.settle(); reject(new Cancelled());
                if (!sent) {return;}
                // The server may still be working on it. Ask it to stop, and keep the id
                // reserved until it answers; a server that does not answer is replaced.
                this.send(`{"cancel":${id}}`);
                entry.resolve = entry.reject = () => undefined;
                this.pending.set(id, entry); this.refresh();
                entry.abandoned = setTimeout(() => this.terminate(new AnalyzerServerUnavailable('The analyzer server did not acknowledge a cancelled request.'), false), this.cancelMs);
                entry.abandoned.unref();
            };
            this.pending.set(id, entry);
            signal?.addEventListener('abort', onAbort, { once: true });
            const timer = setTimeout(() => {
                // Its work cannot be recovered; replace the server, and let the others retry elsewhere.
                entry.settle(); reject(new Error('The command exceeded its time limit: analyzer'));
                this.terminate(new AnalyzerServerUnavailable('The analyzer server was stopped after a request exceeded its time limit.'), false);
            }, options.timeoutMs ?? 600_000);
            timer.unref();
            this.refresh();
            void this.ready.then(() => {
                if (this.pending.get(id) !== entry) {return;}
                entry.sent = true;
                if (!this.send(`{"id":${id},"cwd":${JSON.stringify(cwd)},"request":${request}}`)) {
                    this.terminate(new AnalyzerServerUnavailable('The analyzer server input is closed.'), false);
                }
            }, () => undefined);
        });
    }

    private send(line: string): boolean {
        const input = this.child.stdin;
        if (!input?.writable || this.closed) {return false;}
        input.write(line + '\n', error => {
            if (error) {this.terminate(new AnalyzerServerUnavailable(`The analyzer server input failed: ${error.message}`), false);}
        });
        return true;
    }

    /** Stop the process and wait for it to exit. */
    async close(reason: Error): Promise<void> {
        this.terminate(reason, true);
        await this.exited;
    }
}

export interface AnalyzerServerOptions {
    /** Stop a server after this long without a request. */
    readonly idleMs?: number;
    /** Give up on a server that is not ready by then. */
    readonly startupMs?: number;
    /** After a failed start, skip the server for this long. */
    readonly retryMs?: number;
    /** Replace a server that has not answered a cancelled request by then. */
    readonly cancelMs?: number;
    /** Servers kept at once; idle least recently used ones are stopped beyond this. */
    readonly limit?: number;
    /** Longest protocol line, in characters; a longer one stops the server. */
    readonly maxLineLength?: number;
}

/** Servers keyed by everything that can change an analysis: the host, the helper
 * (including a rebuilt file), the working directory and the environment. */
export class AnalyzerServers {
    private readonly servers = new Map<string, AnalyzerServer>();
    private readonly failedUntil = new Map<string, number>();
    private readonly idleMs: number; private readonly startupMs: number; private readonly retryMs: number; private readonly cancelMs: number; private readonly limit: number;
    private readonly maxLine: number;
    constructor(options: AnalyzerServerOptions = {}) {
        this.idleMs = options.idleMs ?? 120_000; this.startupMs = options.startupMs ?? 30_000;
        this.retryMs = options.retryMs ?? 30_000; this.cancelMs = options.cancelMs ?? 3000; this.limit = options.limit ?? 4;
        // Far above real responses, and well below V8's maximum string length.
        this.maxLine = options.maxLineLength ?? 256 * 1024 * 1024;
    }

    get size(): number { return this.servers.size; }

    /** Send one request, in the one-shot request format, and return the response JSON text.
     * `identity` names anything outside the key that the helper depends on, such as the Roslyn it loads. */
    async request(dotnet: string, analyzer: string, request: string, options: ProcessOptions, identity = ''): Promise<string> {
        options.signal?.throwIfAborted();
        const cwd = path.resolve(options.cwd), helper = path.resolve(cwd, analyzer);
        const command = /[\\/]/.test(dotnet) ? path.resolve(cwd, dotnet) : dotnet;
        let stat;
        try {stat = await fs.stat(helper);} catch (error) {throw new AnalyzerServerUnavailable(`The analyzer is unavailable: ${(error as Error).message}`);}
        options.signal?.throwIfAborted();
        const env: NodeJS.ProcessEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', TESTINGPLATFORM_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...options.env };
        const environment = contentHash(JSON.stringify(Object.entries(env).filter(([, value]) => value !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
        const key = JSON.stringify([command, helper, stat.size, stat.mtimeMs, stat.ino, cwd, environment, identity]);
        for (let attempt = 0;; attempt++) {
            let server = this.servers.get(key);
            if (!server || server.closed) {
                if ((this.failedUntil.get(key) ?? 0) > Date.now()) {throw new AnalyzerServerUnavailable('The analyzer server failed to start recently.');}
                server = this.start(key, command, [helper, '--server'], env);
            }
            this.servers.delete(key); this.servers.set(key, server);
            try {return await server.request(request, cwd, options);}
            catch (error) {
                if (error instanceof AnalyzerServerUnavailable) {
                    // A server stopped on purpose while a request waited is simply replaced.
                    if (error.retryable && attempt === 0 && !options.signal?.aborted) {continue;}
                    if (!server.hasStarted && !error.retryable) {this.failedUntil.set(key, Date.now() + this.retryMs); this.forgetOldFailures();}
                }
                throw error;
            }
        }
    }

    private start(key: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv): AnalyzerServer {
        const server: AnalyzerServer = new AnalyzerServer(command, args, env, this.idleMs, this.startupMs, this.cancelMs, this.maxLine, () => {
            if (this.servers.get(key) === server) {this.servers.delete(key);}
        });
        this.servers.set(key, server);
        for (const [other, candidate] of [...this.servers]) {
            if (this.servers.size <= this.limit) {break;}
            if (candidate !== server && !candidate.busy) {this.servers.delete(other); void candidate.close(new AnalyzerServerUnavailable('The analyzer server was stopped.', true));}
        }
        return server;
    }

    private forgetOldFailures(): void {
        const now = Date.now();
        for (const [key, until] of this.failedUntil) {if (until <= now) {this.failedUntil.delete(key);}}
    }

    /** Stop every server and wait for the processes to exit. New requests start fresh servers. */
    async dispose(): Promise<void> {
        const servers = [...this.servers.values()];
        this.servers.clear(); this.failedUntil.clear();
        await Promise.allSettled(servers.map(server => server.close(new AnalyzerServerUnavailable('The analyzer server was stopped.', true))));
    }
}

export const analyzerServers = new AnalyzerServers();

/** Stop the shared analyzer servers (engine disposal). */
export function disposeAnalyzerServers(): Promise<void> { return analyzerServers.dispose(); }
