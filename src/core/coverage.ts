import { CoveredLine, Trace } from './model';
import { contentHash } from './paths';

export interface CoverageSummary {
    readonly file: string;
    readonly lines: readonly CoveredLine[];
    readonly stale: boolean;
    readonly covered: number;
    readonly total: number;
    readonly groupIds: readonly string[];
}
export interface CoverageSource { readonly id: string; readonly file: string; readonly hash: string; readonly lines: readonly number[]; }
export interface StoredTrace extends Trace { readonly sourceIds: readonly string[]; }
export interface CoverageDelta {
    readonly sources: readonly CoverageSource[];
    readonly traces: readonly StoredTrace[];
    readonly removedSources: readonly string[];
    readonly removedTraces: readonly string[];
}
interface SourceRecord {
    source: CoverageSource;
    readonly groups: Set<string>;
    readonly hits: Map<string, readonly CoveredLine[]>;
}

/** Line geometry is shared; each test file stores only its positive hits. */
export class CoverageStore {
    private readonly records = new Map<string, StoredTrace>();
    private readonly sources = new Map<string, SourceRecord>();
    private readonly byFile = new Map<string, Set<string>>();
    private readonly byDependency = new Map<string, Set<string>>();
    private readonly summaries = new Map<string, CoverageSummary>();
    private readonly dirtyFiles = new Set<string>();
    private readonly changedSources = new Set<string>();
    private readonly changedTraces = new Set<string>();
    private readonly removedSources = new Set<string>();
    private readonly removedTraces = new Set<string>();
    private hashes: ReadonlyMap<string, string> = new Map();
    private cached: readonly CoverageSummary[] | undefined;

    get traces(): ReadonlyMap<string, StoredTrace> { return this.records; }

    dependentGroups(files: readonly string[]): Set<string> {
        const ids = new Set<string>();
        for (const file of files) {for (const id of this.byDependency.get(file) ?? []) {ids.add(id);}}
        return ids;
    }

    invalidate(groupIds: ReadonlySet<string>, stale = true): void {
        let changed = false;
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (!trace || (!trace.reliable && (!stale || trace.stale))) {continue;}
            this.records.set(id, { ...trace, reliable: false, stale: stale || trace.stale });
            changed = true;
            this.changedTraces.add(id);
            for (const sourceId of trace.sourceIds) {const source = this.sources.get(sourceId); if (source) {this.dirtyFiles.add(source.source.file);}}
        }
        if (changed) {this.cached = undefined;}
    }

    markStale(groupIds: ReadonlySet<string>, stale = true): void {
        let changed = false;
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (!trace || (!stale && trace.historical) || !!trace.stale === stale) {continue;}
            this.records.set(id, { ...trace, stale }); this.changedTraces.add(id);
            changed = true;
            for (const sourceId of trace.sourceIds) {const source = this.sources.get(sourceId); if (source) {this.dirtyFiles.add(source.source.file);}}
        }
        if (changed) {this.cached = undefined;}
    }

    markHistorical(groupIds: ReadonlySet<string>): void {
        this.markStale(groupIds);
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (trace && !trace.historical) {
                this.records.set(id, { ...trace, reliable: false, historical: true }); this.changedTraces.add(id);
            }
        }
    }

    replace(traces: readonly Trace[], liveGroupIds: ReadonlySet<string>): void {
        for (const id of this.records.keys()) {if (!liveGroupIds.has(id)) {this.remove(id);}}
        for (const trace of traces) {
            if (!liveGroupIds.has(trace.groupId)) {continue;}
            const previous = this.records.get(trace.groupId);
            const dependencies = trace.reliable ? trace.dependencies : [...new Set([...previous?.dependencies ?? [], ...trace.dependencies])];
            const sourceIds: string[] = [];
            const coverage = [];
            const inputHashes = new Map(trace.coverage.map(file => [file.file, file.hash]));
            // Register geometry before removing old references so shared records
            // survive replacement without duplicating their line tables.
            for (const file of trace.coverage) {
                const id = contentHash(`${file.file}\0${file.hash}`);
                this.registerSource({ id, file: file.file, hash: file.hash, lines: file.lines.map(line => line.line) });
                sourceIds.push(id);
                const hits = file.lines.filter(line => line.hits > 0);
                if (hits.length) {coverage.push({ ...file, lines: hits });}
            }
            this.install({
                ...trace, dependencies, coverage, sourceIds,
                inputs: trace.inputs ?? Object.fromEntries(dependencies.filter(file => inputHashes.has(file)).map(file => [file, inputHashes.get(file)!])),
                stale: trace.stale ?? false
            });
        }
        this.pruneSources();
    }

    restore(traces: readonly Trace[]): void { this.replace(traces, new Set(traces.map(trace => trace.groupId))); }

    restorePacked(sources: readonly CoverageSource[], traces: readonly StoredTrace[], canonical = false): void {
        for (const source of sources) {this.registerSource(source, canonical);}
        for (const trace of traces) {
            if (trace.sourceIds.every(id => this.sources.has(id))) {this.install({ ...trace, reliable: false, stale: true });}
        }
        this.pruneSources();
        this.takeDelta();
    }

    takeDelta(): CoverageDelta {
        const delta = {
            sources: [...new Set([...this.changedSources, ...[...this.changedTraces].flatMap(id => this.records.get(id)?.sourceIds ?? [])])].map(id => this.sources.get(id)?.source).filter((source): source is CoverageSource => !!source),
            traces: [...this.changedTraces].map(id => this.records.get(id)).filter((trace): trace is StoredTrace => !!trace),
            removedSources: [...this.removedSources], removedTraces: [...this.removedTraces]
        };
        this.changedSources.clear(); this.changedTraces.clear(); this.removedSources.clear(); this.removedTraces.clear();
        return delta;
    }

    retryDelta(delta: CoverageDelta): void {
        for (const source of delta.sources) {if (this.sources.has(source.id)) {this.changedSources.add(source.id);}}
        for (const trace of delta.traces) {if (this.records.has(trace.groupId)) {this.changedTraces.add(trace.groupId);}}
        for (const id of delta.removedTraces) {if (!this.records.has(id)) {this.removedTraces.add(id);}}
    }

    summarize(hashes: ReadonlyMap<string, string>): readonly CoverageSummary[] {
        this.updateHashes(hashes);
        if (this.cached) {return this.cached;}
        for (const file of this.dirtyFiles) {
            const summary = this.calculate(file);
            if (summary) {this.summaries.set(file, summary);} else {this.summaries.delete(file);}
        }
        this.dirtyFiles.clear();
        this.cached = [...this.summaries.values()];
        return this.cached;
    }

    summary(file: string, hashes: ReadonlyMap<string, string>): CoverageSummary | undefined {
        this.updateHashes(hashes);
        if (this.dirtyFiles.delete(file)) {
            const summary = this.calculate(file);
            if (summary) {this.summaries.set(file, summary);} else {this.summaries.delete(file);}
        }
        return this.summaries.get(file);
    }

    private updateHashes(hashes: ReadonlyMap<string, string>): void {
        if (this.hashes === hashes) {return;}
        const changed = new Set([...hashes.keys(), ...this.hashes.keys()].filter(file => hashes.get(file) !== this.hashes.get(file)));
        for (const file of changed) {this.dirtyFiles.add(file);}
        const stale = new Set<string>();
        for (const id of this.dependentGroups([...changed])) {
            const trace = this.records.get(id)!;
            if (Object.entries(trace.inputs ?? {}).some(([file, hash]) => hashes.get(file) !== hash)) {stale.add(id);}
        }
        this.hashes = hashes; this.markStale(stale); this.cached = undefined;
    }

    private registerSource(source: CoverageSource, canonical = false): void {
        const previous = this.sources.get(source.id);
        const lines = previous ? [...new Set([...previous.source.lines, ...source.lines])].sort((a, b) => a - b) : canonical ? source.lines : [...new Set(source.lines)].sort((a, b) => a - b);
        if (previous && lines.length === previous.source.lines.length) {return;}
        this.sources.set(source.id, { source: { ...source, lines }, groups: previous?.groups ?? new Set(), hits: previous?.hits ?? new Map() });
        const versions = this.byFile.get(source.file) ?? new Set<string>(); versions.add(source.id); this.byFile.set(source.file, versions);
        this.changedSources.add(source.id); this.removedSources.delete(source.id); this.dirtyFiles.add(source.file); this.cached = undefined;
    }

    private install(trace: StoredTrace): void {
        this.remove(trace.groupId);
        this.records.set(trace.groupId, trace); this.changedTraces.add(trace.groupId); this.removedTraces.delete(trace.groupId);
        for (const file of trace.dependencies) {
            const groups = this.byDependency.get(file) ?? new Set<string>(); groups.add(trace.groupId); this.byDependency.set(file, groups);
        }
        for (const id of trace.sourceIds) {
            const source = this.sources.get(id)!;
            source.groups.add(trace.groupId); this.dirtyFiles.add(source.source.file);
        }
        for (const file of trace.coverage) {this.sources.get(contentHash(`${file.file}\0${file.hash}`))?.hits.set(trace.groupId, file.lines);}
        this.cached = undefined;
    }

    private remove(id: string): void {
        const trace = this.records.get(id);
        if (!trace) {return;}
        this.records.delete(id); this.removedTraces.add(id); this.changedTraces.delete(id);
        for (const file of trace.dependencies) {
            const groups = this.byDependency.get(file); groups?.delete(id); if (!groups?.size) {this.byDependency.delete(file);}
        }
        for (const sourceId of trace.sourceIds) {
            const source = this.sources.get(sourceId)!;
            source.groups.delete(id); source.hits.delete(id); this.dirtyFiles.add(source.source.file);
        }
        this.cached = undefined;
    }

    private pruneSources(): void {
        for (const [id, source] of this.sources) {
            if (source.groups.size) {continue;}
            this.sources.delete(id); this.byFile.get(source.source.file)?.delete(id);
            this.changedSources.delete(id); this.removedSources.add(id);
        }
    }

    private calculate(file: string): CoverageSummary | undefined {
        const versions = [...this.byFile.get(file) ?? []].map(id => this.sources.get(id)!).filter(Boolean);
        if (!versions.length) {return undefined;}
        const current = versions.find(version => version.source.hash === this.hashes.get(file));
        const displayed = current ?? versions[versions.length - 1];
        const hits = new Map<number, number>();
        const groups = new Set<string>();
        let stale = !current;
        for (const version of versions) {
            // Zero-hit reports still assert that these lines were uncovered.
            // That assertion becomes stale when the reporting test changes.
            for (const group of version.groups) {
                groups.add(group);
                if (this.records.get(group)?.stale) {stale = true;}
            }
            for (const [group, contribution] of version.hits) {
                if (version !== current || this.records.get(group)?.stale) {stale = true;}
                if (version === displayed) {for (const line of contribution) {hits.set(line.line, Math.max(hits.get(line.line) ?? 0, line.hits));}}
            }
        }
        const previous = this.summaries.get(file);
        const calculated = displayed.source.lines.map(line => ({ line, hits: hits.get(line) ?? 0 }));
        const sameLines = previous && previous.lines.length === calculated.length
            && calculated.every((line, index) => line.line === previous.lines[index].line && line.hits === previous.lines[index].hits);
        const lines = sameLines ? previous.lines : calculated;
        const groupIds = [...groups].sort();
        if (previous && sameLines && previous.stale === stale && previous.covered === hits.size
            && previous.groupIds.length === groupIds.length && groupIds.every((id, index) => id === previous.groupIds[index])) {return previous;}
        return { file, lines, stale, covered: hits.size, total: lines.length, groupIds };
    }
}
