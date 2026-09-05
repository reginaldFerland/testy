import { CoveredLine, FileCoverage, Trace } from './model';

export interface CoverageSummary {
    readonly file: string;
    readonly lines: readonly CoveredLine[];
    readonly stale: boolean;
    readonly covered: number;
    readonly total: number;
    readonly groupIds: readonly string[];
}

/** Contributions belong to test files: rerunning one replaces only its own data. */
export class CoverageStore {
    private records = new Map<string, Trace>();

    get traces(): ReadonlyMap<string, Trace> { return this.records; }

    invalidate(groupIds: ReadonlySet<string>): void {
        this.records = new Map([...this.records].map(([id, trace]) => [id, groupIds.has(id) ? { ...trace, reliable: false } : trace]));
    }

    replace(traces: readonly Trace[], liveGroupIds: ReadonlySet<string>): void {
        const next = new Map([...this.records].filter(([id]) => liveGroupIds.has(id)));
        for (const trace of traces) {
            if (!liveGroupIds.has(trace.groupId)) {continue;}
            const previous = next.get(trace.groupId);
            // A failed test may exit before it reaches previously used code. Keep
            // those edges and treat the file conservatively until a successful run.
            next.set(trace.groupId, trace.reliable ? trace : {
                ...trace, dependencies: [...new Set([...previous?.dependencies ?? [], ...trace.dependencies])]
            });
        }
        this.records = next;
    }

    restore(traces: readonly Trace[]): void {
        this.records = new Map(traces.map(trace => [trace.groupId, trace]));
    }

    summarize(currentHashes: ReadonlyMap<string, string>): readonly CoverageSummary[] {
        const files = new Map<string, { groupId: string; coverage: FileCoverage }[]>();
        for (const [groupId, trace] of this.records) {
            for (const coverage of trace.coverage) {
                const list = files.get(coverage.file) ?? [];
                list.push({ groupId, coverage });
                files.set(coverage.file, list);
            }
        }
        return [...files].map(([file, contributions]) => {
            const current = currentHashes.get(file);
            const fresh = contributions.filter(item => item.coverage.hash === current);
            const staleHits = contributions.some(item => item.coverage.hash !== current && item.coverage.lines.some(line => line.hits > 0));
            const lines = new Map<number, number>();
            // Do not combine line numbers from different versions of a source file.
            const displayed = fresh.length ? fresh : contributions.filter(item => item.coverage.hash === contributions[contributions.length - 1].coverage.hash);
            for (const { coverage } of displayed) {
                for (const line of coverage.lines) {lines.set(line.line, Math.max(lines.get(line.line) ?? 0, line.hits));}
            }
            const merged = [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits }));
            return {
                file, lines: merged, stale: !fresh.length || staleHits,
                covered: merged.filter(line => line.hits > 0).length, total: merged.length,
                groupIds: contributions.filter(item => item.coverage.lines.some(line => line.hits > 0)).map(item => item.groupId)
            };
        });
    }
}
