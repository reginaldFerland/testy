import * as fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { Declaration } from '../core/model';
import { parseCobertura } from './reports';

export interface CoverageRequest {
    readonly id: number;
    readonly report: string;
    readonly cwd: string;
    /** The version of the allowed file list this request was issued against. */
    readonly filesVersion: number;
}
/** The workspace's tracked files, sent once per worker and again only when they change. */
export interface CoverageFiles {
    readonly version: number;
    readonly files: readonly string[];
}
export interface CoverageResponse {
    readonly id: number;
    readonly error?: string;
    readonly files?: readonly { readonly file: string; readonly values: Float64Array; readonly declarations?: readonly Declaration[] | undefined }[];
}

let allowed: { readonly version: number; readonly files: ReadonlySet<string> } = { version: 0, files: new Set() };

async function handle(request: CoverageRequest, list: typeof allowed): Promise<void> {
    try {
        if (list.version !== request.filesVersion) {throw new Error('The coverage parser received an outdated file list.');}
        const xml = await fs.readFile(request.report, 'utf8');
        const declarations = new Map<string, readonly Declaration[]>();
        const parsed = parseCobertura(xml, request.cwd, list.files, declarations);
        const files = [...parsed].map(([file, lines]) => {
            const values = new Float64Array(lines.length * 2);
            let index = 0;
            for (const { line, hits } of lines) {values[index++] = line; values[index++] = hits;}
            return { file, values, declarations: declarations.get(file) };
        });
        // Transfer compact buffers, rather than cloning hundreds of thousands
        // of line objects back onto the extension host in a single operation.
        parentPort!.postMessage({ id: request.id, files } satisfies CoverageResponse, files.map(file => file.values.buffer));
    } catch (error) {
        parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies CoverageResponse);
    }
}

// Messages arrive in order, so each request binds the list current at its arrival.
// handle() reports every failure back to the requester.
parentPort?.on('message', (message: CoverageRequest | CoverageFiles) => {
    if ('files' in message) {allowed = { version: message.version, files: new Set(message.files) }; return;}
    void handle(message, allowed);
});
