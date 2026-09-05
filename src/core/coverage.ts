import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoveredLine, Trace } from './model';
import { contentHash } from './paths';
import { finish, finishAsync, sortedUnion } from './work';

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
    private records = new Map<string, StoredTrace>();
    private sources = new Map<string, SourceRecord>();
    private byFile = new Map<string, Set<string>>();
    private byDependency = new Map<string, Set<string>>();
    private summaries = new Map<string, CoverageSummary>();
    private dirtyFiles = new Set<string>();
    private changedSources = new Set<string>();
    private changedTraces = new Set<string>();
    private removedSources = new Set<string>();
    private removedTraces = new Set<string>();
    private hashes: ReadonlyMap<string, string> = new Map();
    private cached: readonly CoverageSummary[] | undefined;
    private version = 0;
    get revision(): number { return this.version; }

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
        if (changed) {this.cached = undefined; this.version++;}
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
        if (changed) {this.cached = undefined; this.version++;}
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
        finish(this.replacement(traces, liveGroupIds));
    }

    async replaceAsync(traces: readonly Trace[], liveGroupIds: ReadonlySet<string>, signal?: AbortSignal): Promise<void> {
        await finishAsync(this.replacement(traces, liveGroupIds), signal);
    }

    private *replacement(traces: readonly Trace[], liveGroupIds: ReadonlySet<string>): Generator<void, void> {
        const sources = new Map<string, CoverageSource>(), packed: StoredTrace[] = [];
        let files = 0;
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
                if (++files % 32 === 0) {yield;}
                const id = contentHash(`${file.file}\0${file.hash}`);
                const geometry: number[] = [], hits: CoveredLine[] = [];
                let count = 0;
                for (const line of file.lines) {
                    geometry.push(line.line); if (line.hits > 0) {hits.push(line);}
                    if (++count % 4096 === 0) {yield;}
                }
                const previous = sources.get(id) ?? this.sources.get(id)?.source;
                const lines = yield* sortedUnion(previous?.lines ?? [], geometry);
                sources.set(id, previous && previous.lines.length === lines.length ? previous : { id, file: file.file, hash: file.hash, lines });
                sourceIds.push(id);
                if (hits.length) {coverage.push({ ...file, lines: hits });}
            }
            packed.push({
                ...trace, dependencies, coverage, sourceIds,
                inputs: trace.inputs ?? Object.fromEntries(dependencies.filter(file => inputHashes.has(file)).map(file => [file, inputHashes.get(file)!])),
                stale: trace.stale ?? false
            });
        }
        // No asynchronous boundary after this point: cancellation cannot publish
        // half a contribution or discard the previous complete checkpoint.
        for (const id of this.records.keys()) {if (!liveGroupIds.has(id)) {this.remove(id);}}
        for (const source of sources.values()) {this.registerSource(source, true, true);}
        for (const trace of packed) {this.install(trace);}
        this.pruneSources();
    }

    restore(traces: readonly Trace[]): void { this.replace(traces, new Set(traces.map(trace => trace.groupId))); }

    restorePacked(sources: readonly CoverageSource[], traces: readonly StoredTrace[], canonical = false): void {
        for (const source of sources) {this.registerSource(source, canonical);}
        for (const trace of traces) {
            if (trace.sourceIds.every(id => this.sources.has(id))) {this.install({ ...trace, reliable: false, stale: true });}
        }
        this.pruneSources();
        this.clearDelta();
    }

    /** Stage the entire restored checkpoint before publishing any of its indexes. */
    async restorePackedAsync(sources: readonly CoverageSource[], traces: readonly StoredTrace[], signal?: AbortSignal, version = this.version): Promise<void> {
        if (version !== this.version) {return;}
        const staged = new CoverageStore();
        function* prepare(): Generator<void, void> {
            let count = 0;
            for (const source of sources) {
                staged.registerSource(source, true);
                if (++count % 512 === 0) {yield;}
            }
            for (const trace of traces) {
                let valid = true;
                for (const id of trace.sourceIds) {
                    valid &&= staged.sources.has(id);
                    if (++count % 512 === 0) {yield;}
                }
                if (valid) {yield* staged.installation({ ...trace, reliable: false, stale: true });}
            }
            for (const [id, source] of staged.sources) {
                if (!source.groups.size) {staged.sources.delete(id); staged.byFile.get(source.source.file)?.delete(id);}
                if (++count % 512 === 0) {yield;}
            }
        }
        await finishAsync(prepare(), signal);
        signal?.throwIfAborted();
        // A live run or invalidation that arrived during restoration takes
        // precedence over an older disk snapshot.
        if (version !== this.version) {return;}
        this.records = staged.records; this.sources = staged.sources;
        this.byFile = staged.byFile; this.byDependency = staged.byDependency;
        this.summaries = staged.summaries; this.dirtyFiles = staged.dirtyFiles;
        this.changedSources = new Set(); this.changedTraces = new Set();
        this.removedSources = new Set(); this.removedTraces = new Set();
        this.cached = undefined; this.version++;
    }

    private clearDelta(): void {
        this.changedSources.clear(); this.changedTraces.clear(); this.removedSources.clear(); this.removedTraces.clear();
    }

    takeDelta(): CoverageDelta {
        const delta = {
            sources: [...new Set([...this.changedSources, ...[...this.changedTraces].flatMap(id => this.records.get(id)?.sourceIds ?? [])])].map(id => this.sources.get(id)?.source).filter((source): source is CoverageSource => !!source),
            traces: [...this.changedTraces].map(id => this.records.get(id)).filter((trace): trace is StoredTrace => !!trace),
            removedSources: [...this.removedSources], removedTraces: [...this.removedTraces]
        };
        this.clearDelta();
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
        this.cached = [...this.summaries.values()]; this.version++;
        return this.cached;
    }

    async summarizeAsync(hashes: ReadonlyMap<string, string>, signal?: AbortSignal): Promise<readonly CoverageSummary[]> {
        this.updateHashes(hashes);
        while (!this.cached) {
            const version = this.version;
            const summaries = new Map(this.summaries);
            let files = 0;
            for (const file of this.dirtyFiles) {
                if (++files % 32 === 0) {await yieldTurn(); signal?.throwIfAborted();}
                const summary = await finishAsync(this.calculation(file), signal);
                if (summary) {summaries.set(file, summary);} else {summaries.delete(file);}
            }
            if (version !== this.version) {continue;}
            this.summaries.clear(); for (const [file, summary] of summaries) {this.summaries.set(file, summary);}
            this.dirtyFiles.clear(); this.cached = [...summaries.values()];
        }
        return this.cached;
    }

    summary(file: string, hashes: ReadonlyMap<string, string>): CoverageSummary | undefined {
        this.updateHashes(hashes);
        if (this.dirtyFiles.delete(file)) {
            this.version++;
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
        this.hashes = hashes; this.markStale(stale); this.cached = undefined; this.version++;
    }

    private registerSource(source: CoverageSource, canonical = false, merged = false): void {
        const previous = this.sources.get(source.id);
        const lines = merged ? source.lines : previous ? finish(sortedUnion(previous.source.lines, source.lines)) : canonical ? source.lines : finish(sortedUnion([], source.lines));
        if (previous && lines.length === previous.source.lines.length) {return;}
        this.sources.set(source.id, { source: { ...source, lines }, groups: previous?.groups ?? new Set(), hits: previous?.hits ?? new Map() });
        const versions = this.byFile.get(source.file) ?? new Set<string>(); versions.add(source.id); this.byFile.set(source.file, versions);
        this.changedSources.add(source.id); this.removedSources.delete(source.id); this.dirtyFiles.add(source.file); this.cached = undefined; this.version++;
    }

    private install(trace: StoredTrace): void { finish(this.installation(trace)); }

    private *installation(trace: StoredTrace): Generator<void, void> {
        let count = 0;
        this.remove(trace.groupId);
        this.records.set(trace.groupId, trace); this.changedTraces.add(trace.groupId); this.removedTraces.delete(trace.groupId);
        for (const file of trace.dependencies) {
            const groups = this.byDependency.get(file) ?? new Set<string>(); groups.add(trace.groupId); this.byDependency.set(file, groups);
            if (++count % 512 === 0) {yield;}
        }
        for (const id of trace.sourceIds) {
            const source = this.sources.get(id)!;
            source.groups.add(trace.groupId); this.dirtyFiles.add(source.source.file);
            if (++count % 512 === 0) {yield;}
        }
        for (const file of trace.coverage) {
            this.sources.get(contentHash(`${file.file}\0${file.hash}`))?.hits.set(trace.groupId, file.lines);
            if (++count % 512 === 0) {yield;}
        }
        this.cached = undefined; this.version++;
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
        this.cached = undefined; this.version++;
    }

    private pruneSources(): void {
        for (const [id, source] of this.sources) {
            if (source.groups.size) {continue;}
            this.sources.delete(id); this.byFile.get(source.source.file)?.delete(id);
            this.changedSources.delete(id); this.removedSources.add(id);
        }
    }

    private calculate(file: string): CoverageSummary | undefined {
        return finish(this.calculation(file));
    }

    private *calculation(file: string): Generator<void, CoverageSummary | undefined> {
        const versions = [...this.byFile.get(file) ?? []].map(id => this.sources.get(id)!).filter(Boolean);
        if (!versions.length) {return undefined;}
        const current = versions.find(version => version.source.hash === this.hashes.get(file));
        const displayed = current ?? versions[versions.length - 1];
        const hits = new Map<number, number>();
        const groups = new Set<string>();
        let stale = !current;
        let count = 0;
        for (const version of versions) {
            // Zero-hit reports still assert that these lines were uncovered.
            // That assertion becomes stale when the reporting test changes.
            for (const group of version.groups) {
                groups.add(group);
                if (this.records.get(group)?.stale) {stale = true;}
            }
            for (const [group, contribution] of version.hits) {
                if (version !== current || this.records.get(group)?.stale) {stale = true;}
                if (version === displayed) {for (const line of contribution) {
                    hits.set(line.line, Math.max(hits.get(line.line) ?? 0, line.hits));
                    if (++count % 4096 === 0) {yield;}
                }}
            }
        }
        const previous = this.summaries.get(file);
        const calculated: CoveredLine[] = [];
        let sameLines = !!previous && previous.lines.length === displayed.source.lines.length;
        for (const line of displayed.source.lines) {
            const covered = { line, hits: hits.get(line) ?? 0 }, old = previous?.lines[calculated.length];
            sameLines &&= covered.line === old?.line && covered.hits === old?.hits;
            calculated.push(covered);
            if (++count % 4096 === 0) {yield;}
        }
        const lines = sameLines ? previous!.lines : calculated;
        const groupIds = [...groups].sort();
        if (previous && sameLines && previous.stale === stale && previous.covered === hits.size
            && previous.groupIds.length === groupIds.length && groupIds.every((id, index) => id === previous.groupIds[index])) {return previous;}
        return { file, lines, stale, covered: hits.size, total: lines.length, groupIds };
    }
}
