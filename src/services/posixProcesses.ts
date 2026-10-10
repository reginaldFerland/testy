import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

/** Run a query whose output is only process identifiers, ages or environments. */
function psOutput(args: readonly string[], tolerateEmpty = false): Promise<string> {
    return new Promise((resolve, reject) => {
        const query = spawn('ps', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        let text = '';
        query.stdout.setEncoding('utf8');
        query.stdout.on('data', (chunk: string) => {text += chunk;});
        query.once('error', reject);
        query.once('close', code => {
            // BSD ps exits 1 when none of the requested processes remain.
            if (code !== 0 && !(tolerateEmpty && code === 1 && !text.trim())) {reject(new Error('Unable to inspect owned POSIX descendants.')); return;}
            resolve(text);
        });
    });
}

/** [[dd-]hh:]mm:ss, the only elapsed-time format common to Linux and macOS ps. */
function elapsedSeconds(etime: string): number {
    const match = /^(?:(?:(\d+)-)?(?:(\d+):))?(\d+):(\d+)$/.exec(etime);
    return match ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4]) : Number.NaN;
}

/** Every owned process descends from the launch, so it started after it. This is
 * a cheap superset (no environments are read) that excludes long-running
 * processes; undefined means the table was unavailable and every process is a candidate. */
async function startedSince(since: number): Promise<number[] | undefined> {
    try {
        const limit = Math.ceil((Date.now() - since) / 1000) + 2; // etime has one-second resolution
        const pids: number[] = [];
        for (const line of (await psOutput(['-axo', 'pid=,etime='])).split('\n')) {
            const [pid, etime] = line.trim().split(/\s+/);
            // An unparsable age stays a candidate rather than risking an escape.
            if (!/^\d+$/.test(pid ?? '') || Number(pid) === process.pid) {continue;}
            if (!(elapsedSeconds(etime ?? '') > limit)) {pids.push(Number(pid));}
        }
        return pids;
    } catch {return undefined;}
}

async function linuxOwnedPids(owner: string, candidates?: readonly number[]): Promise<number[]> {
    const marker = `TESTY_PROCESS_OWNER=${owner}`;
    const names = (candidates?.map(String) ?? await fs.readdir('/proc')).filter(name => /^\d+$/.test(name) && Number(name) !== process.pid);
    const pids: number[] = [];
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
        for (;;) {
            const name = names[index++]; if (!name) {return;}
            try {
                const environment = await fs.readFile(`/proc/${name}/environ`, 'utf8');
                if (environment.split('\0').includes(marker)) {pids.push(Number(name));}
            } catch (error) {
                // Other users' processes and exits during enumeration are normal.
                if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;}
            }
        }
    }));
    return pids;
}

/** An inherited nonce follows ordinary detached/reparented children too. Read
 * process environments only for matching; never retain or log their contents. */
async function ownedPids(owner: string, candidates?: readonly number[]): Promise<number[]> {
    if (process.platform === 'linux') {return linuxOwnedPids(owner, candidates);}
    const marker = new RegExp(`(?:^|\\s)TESTY_PROCESS_OWNER=${owner}(?:\\s|$)`);
    // `ps eww` prints every selected process's environment: select only candidates.
    const output = await psOutput(candidates ? ['eww', '-o', 'pid=,command=', '-p', candidates.join(',')] : ['eww', '-axo', 'pid=,command='], !!candidates);
    const pids: number[] = [];
    for (const line of output.split('\n')) {
        if (!marker.test(line)) {continue;}
        const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
        if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {pids.push(pid);}
    }
    return pids;
}

/** `since` is when the owned launch began (epoch ms); it bounds which processes
 * have their environments inspected. Without it, every process is inspected. */
export async function cleanupPosixOwner(owner: string, since?: number): Promise<void> {
    // Repeat after signalling to catch a child forked during the preceding scan.
    for (let attempt = 0; attempt < 10; attempt++) {
        const candidates = since === undefined ? undefined : await startedSince(since);
        if (candidates && !candidates.length) {return;}
        const pids = await ownedPids(owner, candidates);
        if (!pids.length) {return;}
        const errors: unknown[] = [];
        for (const pid of pids) {
            try {process.kill(pid, 'SIGKILL');}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {errors.push(error);}}
        }
        if (errors.length) {throw new AggregateError(errors, 'Unable to terminate owned POSIX descendants.');}
    }
    throw new Error('Owned POSIX descendants did not exit during cleanup.');
}
