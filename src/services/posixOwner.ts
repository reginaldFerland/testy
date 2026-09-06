import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanupPosixOwner } from './posixProcesses';

interface Launch {
    readonly command: string;
    readonly args: readonly string[];
    readonly owner: string;
    readonly cleanupDescendants: boolean;
    readonly electronRunAsNode?: string;
}

// This process outlives the extension host. Its stdin is held exclusively by
// that host; EOF also covers SIGKILL and crashes, where host callbacks cannot run.
// The host also owns the readers of our output pipes. Diagnostics after its
// death must not crash the supervisor with EPIPE before cleanup finishes.
process.stdout.on('error', () => undefined);
process.stderr.on('error', () => undefined);
const control = createInterface({ input: process.stdin });
let child: ChildProcess | undefined, launch: Launch | undefined;
let stopping = false, finishing = false;
let escalation: NodeJS.Timeout | undefined;

function signalTree(signal: NodeJS.Signals): boolean {
    if (!child?.pid) {return true;}
    try {process.kill(-child.pid, signal);}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        process.stderr.write(`Process group signal failed; checking owned descendants: ${String(error)}\n`);
        return false;
    }}
    return true;
}

function stop(): void {
    if (stopping || finishing) {return;}
    stopping = true;
    if (!child) {process.exit(1);}
    if (!signalTree('SIGTERM')) {void finish(1); return;}
    escalation = setTimeout(() => {void finish(1);}, 1500);
}

async function finish(code: number): Promise<void> {
    if (finishing) {return;}
    finishing = true;
    if (escalation) {clearTimeout(escalation);}
    try {
        if (launch && (stopping || launch.cleanupDescendants)) {
            signalTree('SIGKILL');
            await cleanupPosixOwner(launch.owner);
        }
    } catch (error) {process.stderr.write(`Process cleanup failed: ${String(error)}\n`); code = 1;}
    // Descendants may inherit output handles. Cleanup must finish before we
    // release this owner, without waiting for those descendants to close pipes.
    process.exit(code);
}

control.on('line', line => {
    if (launch) {stop(); return;}
    try {
        launch = JSON.parse(line) as Launch;
        if (!launch.command || !Array.isArray(launch.args) || !/^[\da-f-]{36}$/.test(launch.owner)) {throw new Error('Invalid process launch.');}
        const env: NodeJS.ProcessEnv = { ...process.env, TESTY_PROCESS_OWNER: launch.owner };
        if (launch.electronRunAsNode === undefined) {delete env.ELECTRON_RUN_AS_NODE;}
        else {env.ELECTRON_RUN_AS_NODE = launch.electronRunAsNode;}
        child = spawn(launch.command, launch.args, { shell: false, detached: true, stdio: ['ignore', 'inherit', 'inherit'], env });
        child.once('error', error => {process.stderr.write(`${error.message}\n`); void finish(127);});
        child.once('exit', code => {void finish(code ?? 1);});
    } catch (error) {process.stderr.write(`${String(error)}\n`); void finish(127);}
});
control.once('close', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
