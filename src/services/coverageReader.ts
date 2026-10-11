import { scriptPath } from './assets';
import { Worker } from 'node:worker_threads';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoveredLine, FileCoverage } from '../core/model';
import { Cancelled } from './process';
import type { CoverageFiles, CoverageRequest, CoverageResponse } from './coverageWorker';

interface Pending {
    readonly worker: Worker;
    readonly resolve: (response: CoverageResponse) => void;
    readonly reject: (error: Error) => void;
}

/** A run reuses one parser worker. Cancelling a read drops only that request; the
 * worker, which parses synchronously, is terminated once nothing else awaits it. */
export class CoverageReader {
    private worker: Worker | undefined;
    private disposed = false;
    private readonly pending = new Map<number, Pending>();
    private sequence = 0;
    private filesVersion = 0;
    /** The file list the current worker holds. */
    private sent?: { readonly worker: Worker; readonly hashes: ReadonlyMap<string, string>; readonly size: number; readonly version: number };

    /** `hashes` is an immutable snapshot (the engine replaces its map on change), so its
     * file list is sent to a worker once and again only for a different snapshot. `layout` names the instrumented output the
     * report comes from, whose later reports the worker reads faster (see CoverageRequest.layout). */
    async read(report: string, cwd: string, hashes: ReadonlyMap<string, string>, signal?: AbortSignal, layout?: string): Promise<readonly FileCoverage[]> {
        signal?.throwIfAborted();
        if (this.disposed) {throw new Cancelled();}
        const worker = this.worker ?? this.start(), id = ++this.sequence;
        if (this.sent?.worker !== worker || this.sent.hashes !== hashes || this.sent.size !== hashes.size) {
            this.sent = { worker, hashes, size: hashes.size, version: ++this.filesVersion };
            worker.postMessage({ version: this.sent.version, files: [...hashes.keys()] } satisfies CoverageFiles);
        }
        const filesVersion = this.sent.version;
        let abort = (): void => {};
        let response: CoverageResponse;
        try {
            response = await new Promise<CoverageResponse>((resolve, reject) => {
                const entry: Pending = { worker, resolve, reject };
                // A late reply finds no entry and is ignored.
                abort = (): void => {
                    if (this.pending.get(id) !== entry) {return;}
                    this.pending.delete(id); reject(new Cancelled()); this.retire(worker);
                };
                this.pending.set(id, entry);
                signal?.addEventListener('abort', abort, { once: true });
                worker.postMessage({ id, report, cwd, filesVersion, layout } satisfies CoverageRequest);
            });
        } finally {
            // Conversion below observes the signal itself and must not stop a shared worker.
            this.pending.delete(id); signal?.removeEventListener('abort', abort);
        }
        if (response.error) {throw new Error(response.error);}
        const files: FileCoverage[] = [];
        let converted = 0;
        for (const file of response.files ?? []) {
            const lines: CoveredLine[] = [];
            // Values are (line, hits) pairs; the bound covers both reads.
            for (let index = 0; index + 1 < file.values.length; index += 2) {
                if (++converted % 4096 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                lines.push({ line: file.values[index]!, hits: file.values[index + 1]! });
            }
            files.push({ file: file.file, hash: hashes.get(file.file)!, lines, ...file.declarations ? { declarations: file.declarations } : {} });
        }
        signal?.throwIfAborted();
        return files;
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const worker = this.worker;
        if (worker) {this.fail(worker, new Cancelled()); await worker.terminate();}
    }

    /** Stop a worker that no remaining request is waiting on. */
    private retire(worker: Worker): void {
        for (const pending of this.pending.values()) {if (pending.worker === worker) {return;}}
        if (this.worker === worker) {this.worker = undefined;}
        void worker.terminate();
    }

    private start(): Worker {
        const worker = new Worker(scriptPath('coverageWorker'));
        this.worker = worker;
        worker.on('message', (response: CoverageResponse) => this.pending.get(response.id)?.resolve(response));
        worker.on('error', (error: Error) => this.fail(worker, error));
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
