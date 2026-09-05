import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePath } from '../core/paths';
import { ProcessOptions, requireSuccess, runProcess } from './process';

/** Declaration fingerprints catch dependencies that runtime coverage cannot see. */
export async function sourceShapes(dotnet: string, analyzer: string, files: readonly string[], storage: string, options: ProcessOptions): Promise<ReadonlyMap<string, string | null>> {
    if (!files.length) {return new Map();}
    await fs.mkdir(storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(storage, 'analysis-'));
    try {
        const input = path.join(directory, 'files.json');
        await fs.writeFile(input, JSON.stringify(files));
        const output = requireSuccess(await runProcess(dotnet, [analyzer, input], { ...options, output: undefined }), 'Analyzing C# declarations').stdout;
        const parsed: unknown = JSON.parse(output);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {throw new Error('Invalid source analysis response.');}
        const result = new Map<string, string | null>();
        for (const file of files) {
            const value = (parsed as Record<string, unknown>)[file];
            result.set(normalizePath(file), typeof value === 'string' && /^[A-F0-9]{64}$/.test(value) ? value : null);
        }
        return result;
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}
