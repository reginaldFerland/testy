import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { withLock } from './lock';

export async function installCoverageTool(dotnet: string, storage: string, options: ProcessOptions, run: typeof runProcess = runProcess): Promise<string> {
    const directory = path.join(storage, 'coverage-18.1.0');
    const name = process.platform === 'win32' ? 'dotnet-coverage.exe' : 'dotnet-coverage';
    return withLock(`${directory}.lock`, options.signal, async () => {
        try {await fs.access(path.join(directory, '.ready')); await fs.access(path.join(directory, name)); return path.join(directory, name);}
        catch { /* First use or an interrupted installation. */ }
        const staging = `${directory}.install-${randomUUID()}`;
        try {
            await fs.mkdir(staging, { recursive: true });
            requireSuccess(await run(dotnet, ['tool', 'install', 'dotnet-coverage', '--version', '18.1.0', '--tool-path', staging], options), 'Installing the coverage collector');
            options.signal?.throwIfAborted();
            await fs.access(path.join(staging, name));
            await fs.writeFile(path.join(staging, '.ready'), '18.1.0');
            await fs.rm(directory, { recursive: true, force: true });
            await fs.rename(staging, directory);
            return path.join(directory, name);
        } finally {await fs.rm(staging, { recursive: true, force: true, maxRetries: 5 });}
    });
}
