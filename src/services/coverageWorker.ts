import * as fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { parseCobertura } from './reports';

export interface CoverageRequest {
    readonly id: number;
    readonly report: string;
    readonly cwd: string;
    readonly allowedFiles: readonly string[];
}
export interface CoverageResponse {
    readonly id: number;
    readonly error?: string;
    readonly files?: readonly { readonly file: string; readonly values: Float64Array }[];
}

parentPort?.on('message', async (request: CoverageRequest) => {
    try {
        const xml = await fs.readFile(request.report, 'utf8');
        const parsed = parseCobertura(xml, request.cwd, new Set(request.allowedFiles));
        const files = [...parsed].map(([file, lines]) => {
            const values = new Float64Array(lines.length * 2);
            for (let index = 0; index < lines.length; index++) {values[index * 2] = lines[index].line; values[index * 2 + 1] = lines[index].hits;}
            return { file, values };
        });
        // Transfer compact buffers, rather than cloning hundreds of thousands
        // of line objects back onto the extension host in a single operation.
        parentPort!.postMessage({ id: request.id, files } satisfies CoverageResponse, files.map(file => file.values.buffer as ArrayBuffer));
    } catch (error) {
        parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies CoverageResponse);
    }
});
