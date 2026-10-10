import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { withLock } from './lock';

/** The dotnet-coverage version Testy installs when testy.coverageToolPath is unset. */
export const coverageToolVersion = '18.1.0';

export async function installCoverageTool(dotnet: string, storage: string, options: ProcessOptions, run: typeof runProcess = runProcess): Promise<string> {
    const directory = path.join(storage, `coverage-${coverageToolVersion}`);
    const name = process.platform === 'win32' ? 'dotnet-coverage.exe' : 'dotnet-coverage';
    return withLock(`${directory}.lock`, options.signal, async () => {
        try {await fs.access(path.join(directory, '.ready')); await fs.access(path.join(directory, name)); return path.join(directory, name);}
        catch { /* First use or an interrupted installation. */ }
        const staging = `${directory}.install-${randomUUID()}`;
        try {
            await fs.mkdir(staging, { recursive: true });
            requireSuccess(await run(dotnet, ['tool', 'install', 'dotnet-coverage', '--version', coverageToolVersion, '--tool-path', staging], options), 'Installing the coverage collector');
            options.signal?.throwIfAborted();
            await fs.access(path.join(staging, name));
            await fs.writeFile(path.join(staging, '.ready'), coverageToolVersion);
            await fs.rm(directory, { recursive: true, force: true });
            await fs.rename(staging, directory);
            return path.join(directory, name);
        } finally {await fs.rm(staging, { recursive: true, force: true, maxRetries: 5 });}
    });
}
