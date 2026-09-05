import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoveredLine, FileCoverage } from '../core/model';
import { Cancelled } from './process';
import type { CoverageRequest, CoverageResponse } from './coverageWorker';

interface Pending {
    readonly worker: Worker;
    readonly resolve: (response: CoverageResponse) => void;
    readonly reject: (error: Error) => void;
}

/** A run reuses one parser worker; cancellation terminates its synchronous work. */
export class CoverageReader {
    private worker: Worker | undefined;
    private readonly pending = new Map<number, Pending>();
    private sequence = 0;

    async read(report: string, cwd: string, hashes: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<readonly FileCoverage[]> {
        signal?.throwIfAborted();
        const worker = this.worker ?? this.start(), id = ++this.sequence;
        const abort = (): void => {this.fail(worker, new Cancelled()); void worker.terminate();};
        signal?.addEventListener('abort', abort, { once: true });
        try {
            const response = await new Promise<CoverageResponse>((resolve, reject) => {
                this.pending.set(id, { worker, resolve, reject });
                worker.postMessage({ id, report, cwd, allowedFiles: [...hashes.keys()] } satisfies CoverageRequest);
            });
            if (response.error) {throw new Error(response.error);}
            const files: FileCoverage[] = [];
            let converted = 0;
            for (const file of response.files ?? []) {
                const lines: CoveredLine[] = [];
                for (let index = 0; index < file.values.length; index += 2) {
                    if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                    lines.push({ line: file.values[index], hits: file.values[index + 1] });
                }
                files.push({ file: file.file, hash: hashes.get(file.file)!, lines });
            }
            signal?.throwIfAborted();
            return files;
        } finally {
            this.pending.delete(id); signal?.removeEventListener('abort', abort);
        }
    }

    async dispose(): Promise<void> {
        const worker = this.worker;
        if (worker) {this.fail(worker, new Cancelled()); await worker.terminate();}
    }

    private start(): Worker {
        const worker = new Worker(path.join(__dirname, 'coverageWorker.js'));
        this.worker = worker;
        worker.on('message', (response: CoverageResponse) => this.pending.get(response.id)?.resolve(response));
        worker.on('error', error => this.fail(worker, error));
        worker.on('exit', code => this.fail(worker, new Error(`The coverage parser exited unexpectedly (exit ${code}).`)));
        return worker;
    }

    private fail(worker: Worker, error: Error): void {
        if (this.worker === worker) {this.worker = undefined;}
        for (const [id, pending] of this.pending) {
            if (pending.worker === worker) {this.pending.delete(id); pending.reject(error);}
        }
    }
}
