import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageDelta, CoverageSource, CoverageStore, StoredTrace } from '../core/coverage';
import { contentHash } from '../core/paths';
import { withLock } from './lock';

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function validSource(value: unknown): value is CoverageSource {
    const source = record(value);
    return !!source && typeof source.id === 'string' && typeof source.file === 'string' && typeof source.hash === 'string'
        && source.id === contentHash(`${source.file}\0${source.hash}`) && Array.isArray(source.lines) && source.lines.every(positive);
}

export function validTrace(value: unknown): value is StoredTrace {
    const trace = record(value);
    return !!trace && typeof trace.groupId === 'string' && strings(trace.sourceIds) && strings(trace.dependencies)
        && typeof trace.reliable === 'boolean' && (trace.stale === undefined || typeof trace.stale === 'boolean')
        && typeof trace.timestamp === 'number' && Number.isFinite(trace.timestamp) && !!record(trace.inputs)
        && Object.values(trace.inputs as object).every(hash => typeof hash === 'string')
        && Array.isArray(trace.coverage) && trace.coverage.every(value => {
            const file = record(value);
            return !!file && typeof file.file === 'string' && typeof file.hash === 'string'
                && (trace.sourceIds as string[]).includes(contentHash(`${file.file}\0${file.hash}`))
                && Array.isArray(file.lines) && file.lines.every(value => {
                    const line = record(value); return !!line && positive(line.line) && typeof line.hits === 'number' && Number.isFinite(line.hits) && line.hits > 0;
                });
        });
}

/** Immutable source records and independently atomic traces avoid full-cache rewrites. */
export class CoverageCache {
    private readonly directory: string;
    private writes = 0;
    constructor(storage: string, private readonly output: (text: string) => void) { this.directory = path.join(storage, 'coverage-v2'); }

    async restore(store: CoverageStore): Promise<void> {
        await withLock(`${this.directory}.lock`, undefined, async () => {
            const sources = (await this.read('sources')).filter(validSource);
            const byId = new Map(sources.map(source => [source.id, new Set(source.lines)]));
            const traces = (await this.read('traces')).filter(validTrace).filter(trace => trace.sourceIds.every(id => byId.has(id))
                && trace.coverage.every(file => file.lines.every(line => byId.get(contentHash(`${file.file}\0${file.hash}`))?.has(line.line))));
            store.restorePacked(sources, traces);
            await this.prune(traces);
        });
    }

    async save(delta: CoverageDelta): Promise<void> {
        if (!delta.sources.length && !delta.traces.length && !delta.removedTraces.length) {return;}
        await withLock(`${this.directory}.lock`, undefined, async () => {
            await Promise.all(['sources', 'traces'].map(kind => fs.mkdir(path.join(this.directory, kind), { recursive: true })));
            for (const source of delta.sources) {
                let previous: unknown;
                try {previous = JSON.parse(await fs.readFile(path.join(this.directory, 'sources', `${source.id}.json`), 'utf8'));} catch { /* Missing or corrupt. */ }
                const lines = validSource(previous) ? [...new Set([...previous.lines, ...source.lines])].sort((a, b) => a - b) : source.lines;
                if (!validSource(previous) || lines.length !== previous.lines.length) {await this.write('sources', source.id, { ...source, lines });}
            }
            for (const trace of delta.traces) {await this.write('traces', contentHash(trace.groupId), trace);}
            for (const id of delta.removedTraces) {await fs.rm(path.join(this.directory, 'traces', `${contentHash(id)}.json`), { force: true });}
            if (++this.writes % 128 === 0) {await this.prune((await this.read('traces')).filter(validTrace));}
        });
    }

    private async prune(traces: readonly StoredTrace[]): Promise<void> {
        const live = new Set(traces.flatMap(trace => [...trace.sourceIds]));
        const directory = path.join(this.directory, 'sources');
        for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
            if (/^[a-f0-9]{64}\.json$/.test(name) && !live.has(name.slice(0, -5))) {await fs.rm(path.join(directory, name), { force: true });}
        }
    }

    private async write(kind: string, id: string, value: unknown): Promise<void> {
        const destination = path.join(this.directory, kind, `${id}.json`);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, destination); }
        finally { await fs.rm(temporary, { force: true }); }
    }

    private async read(kind: string): Promise<unknown[]> {
        const directory = path.join(this.directory, kind);
        let names: string[];
        try { names = (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {this.output(`Unable to read the coverage cache: ${String(error)}\n`);} return []; }
        const values: unknown[] = [];
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(16, names.length) }, async () => {
            for (;;) {
                const name = names[index++]; if (!name) {return;}
                try {
                    const file = path.join(directory, name);
                    if ((await fs.stat(file)).size > 16 * 1024 * 1024) {continue;}
                    values.push(JSON.parse(await fs.readFile(file, 'utf8')));
                } catch { this.output(`Ignoring an unreadable coverage cache entry: ${name}\n`); }
            }
        }));
        return values;
    }
}
