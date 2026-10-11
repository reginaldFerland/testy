import { execFile } from 'node:child_process';

/** Resident memory, in bytes, of a process and every descendant, or undefined when the system cannot tell. A reused test host runs
 * under owners and a coverage collector, so the whole tree counts. */
export async function treeMemory(root: number, signal?: AbortSignal): Promise<number | undefined> {
    const table = await processTable(signal).catch(() => undefined);
    if (!table) {return undefined;}
    const children = new Map<number, number[]>();
    for (const row of table) {const list = children.get(row.parent) ?? []; list.push(row.pid); children.set(row.parent, list);}
    const memory = new Map(table.map(row => [row.pid, row.bytes]));
    if (!memory.has(root)) {return undefined;}
    let total = 0;
    for (const pending = [root], seen = new Set<number>(); pending.length;) {
        const pid = pending.pop()!;
        if (seen.has(pid)) {continue;}
        seen.add(pid); total += memory.get(pid) ?? 0; pending.push(...children.get(pid) ?? []);
    }
    return total;
}

export interface ProcessRow { readonly pid: number; readonly parent: number; readonly bytes: number }

/** Every process with its parent and resident memory: `ps` on macOS and Linux, CIM through PowerShell on Windows. */
async function processTable(signal?: AbortSignal): Promise<readonly ProcessRow[]> {
    if (process.platform === 'win32') {
        const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }'], signal);
        return rows(text, 1);
    }
    // rss is in KiB on macOS and Linux.
    return rows(await run('ps', ['-A', '-o', 'pid=,ppid=,rss='], signal), 1024);
}

/** Rows of `pid parent size` lines, sizes in `unit` bytes (KiB from `ps`, bytes from CIM). Exported for tests. */
export function rows(text: string, unit: number): ProcessRow[] {
    return text.split(/\r?\n/).flatMap(line => {
        const [pid, parent, size] = line.trim().split(/\s+/).map(Number);
        return pid !== undefined && parent !== undefined && size !== undefined && [pid, parent, size].every(Number.isFinite) ? [{ pid, parent, bytes: size * unit }] : [];
    });
}

function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...signal ? { signal } : {} },
            (error: Error | null, stdout: string) => {if (error) {reject(error);} else {resolve(stdout);}});
    });
}
