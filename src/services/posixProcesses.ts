import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

async function linuxOwnedPids(owner: string): Promise<number[]> {
    const marker = `TESTY_PROCESS_OWNER=${owner}`;
    const names = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name) && Number(name) !== process.pid);
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
async function ownedPids(owner: string): Promise<number[]> {
    if (process.platform === 'linux') {return linuxOwnedPids(owner);}
    const marker = new RegExp(`(?:^|\\s)TESTY_PROCESS_OWNER=${owner}(?:\\s|$)`);
    return new Promise((resolve, reject) => {
        const query = spawn('ps', ['eww', '-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
        const pids: number[] = [];
        let pending = '';
        const read = (line: string): void => {
            if (!marker.test(line)) {return;}
            const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
            if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== query.pid) {pids.push(pid);}
        };
        query.stdout.setEncoding('utf8');
        query.stdout.on('data', (text: string) => {
            pending += text;
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {read(pending.slice(0, end)); pending = pending.slice(end + 1);}
        });
        query.once('error', reject);
        query.once('close', code => {
            if (code !== 0) {reject(new Error('Unable to inspect owned POSIX descendants.')); return;}
            read(pending); pending = ''; resolve(pids);
        });
    });
}

export async function cleanupPosixOwner(owner: string): Promise<void> {
    // Repeat after signalling to catch a child forked during the preceding scan.
    for (let attempt = 0; attempt < 10; attempt++) {
        const pids = await ownedPids(owner);
        if (!pids.length) {return;}
        for (const pid of pids) {
            try {process.kill(pid, 'SIGKILL');}
            catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {throw error;}}
        }
    }
    throw new Error('Owned POSIX descendants did not exit during cleanup.');
}
