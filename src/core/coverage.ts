import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoveredLine, Trace } from './model';
import { contentHash, sourceVersion } from './paths';
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
    staleCount: number;
    aggregate?: { readonly lines: readonly CoveredLine[]; readonly covered: number };
    aggregateVersion: number;
}
const moduleKey = (project: string): string => `\0module:${project}`;
const dependencyKeys = (trace: Trace): readonly string[] => [...trace.dependencies, ...trace.moduleProjects?.map(moduleKey) ?? []];

/** Line geometry is shared; each test file stores only its positive hits. */
export class CoverageStore {
    private records = new Map<string, StoredTrace>();
    private sources = new Map<string, SourceRecord>();
    private byFile = new Map<string, Set<string>>();
    private byDependency = new Map<string, Set<string>>();
    private summaries = new Map<string, CoverageSummary>();
    private dirtyFiles = new Set<string>();
    private dirtyGroups = new Set<string>();
    private appliedStale = new Map<string, boolean>();
    private owners = new Map<string, readonly string[]>();
    private readonly staleOrigins = new Map<string, { trace: StoredTrace; dirty: boolean }>();
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

    dependentProjects(projects: readonly string[]): Set<string> { return this.dependentGroups(projects.map(moduleKey)); }

    invalidate(groupIds: ReadonlySet<string>, stale = true): void {
        let changed = false;
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (!trace || (!trace.reliable && (!stale || trace.stale))) {continue;}
            this.records.set(id, { ...trace, reliable: false, stale: stale || trace.stale });
            this.staleOrigins.delete(id);
            changed = true;
            this.changedTraces.add(id);
            this.dirtyGroups.add(id);
        }
        if (changed) {this.version++;}
    }

    markStale(groupIds: ReadonlySet<string>, stale = true): void {
        let changed = false;
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (!trace || (!stale && trace.historical) || !!trace.stale === stale) {continue;}
            const origin = this.staleOrigins.get(id) ?? { trace, dirty: this.changedTraces.has(id) };
            if (!!origin.trace.stale === stale) {
                this.records.set(id, origin.trace); this.staleOrigins.delete(id);
                if (!origin.dirty) {this.changedTraces.delete(id);}
            } else {
                this.staleOrigins.set(id, origin);
                this.records.set(id, { ...trace, stale }); this.changedTraces.add(id);
            }
            changed = true;
            this.dirtyGroups.add(id);
        }
        if (changed) {this.version++;}
    }

    markHistorical(groupIds: ReadonlySet<string>): void {
        this.markStale(groupIds);
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (trace && !trace.historical) {
                this.records.set(id, { ...trace, reliable: false, historical: true }); this.changedTraces.add(id);
                this.staleOrigins.delete(id); this.version++;
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
            const moduleProjects = trace.reliable ? trace.moduleProjects : [...new Set([...previous?.moduleProjects ?? [], ...trace.moduleProjects ?? []])];
            const sourceIds: string[] = [];
            const coverage = [];
            const inputHashes = new Map(trace.coverage.map(file => [file.file, file.hash]));
            // Register geometry before removing old references so shared records
            // survive replacement without duplicating their line tables.
            for (const file of trace.coverage) {
                if (++files % 32 === 0) {yield;}
                const id = contentHash(`${file.file}\0${file.hash}`);
                const geometry: number[] = [], hits: CoveredLine[] = [];
                const previousHits = this.sources.get(id)?.hits.get(trace.groupId);
                let sameHits = previousHits !== undefined;
                let count = 0;
                for (const line of file.lines) {
                    geometry.push(line.line);
                    if (line.hits > 0) {
                        if (sameHits) {
                            const old = previousHits![hits.length];
                            if (!old || old.line !== line.line || old.hits !== line.hits) {sameHits = false;}
                        }
                        hits.push(line);
                    }
                    if (++count % 4096 === 0) {yield;}
                }
                const previous = sources.get(id) ?? this.sources.get(id)?.source;
                const lines = yield* sortedUnion(previous?.lines ?? [], geometry);
                sources.set(id, previous && previous.lines.length === lines.length ? previous : { id, file: file.file, hash: file.hash, lines });
                sourceIds.push(id);
                // Compare while packing can still yield. Installation checks the
                // current array identity again; a concurrent replacement cannot
                // authorize reuse of an aggregate for different hit data.
                if (hits.length) {coverage.push({ ...file, lines: sameHits && previousHits!.length === hits.length ? previousHits! : hits });}
            }
            packed.push({
                ...trace, dependencies, moduleProjects, coverage, sourceIds,
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
                if (valid) {
                    const restored = { ...trace, reliable: false, stale: true };
                    if (staged.records.has(trace.groupId)) {yield* staged.installation(restored);}
                    else {yield* staged.initialInstallation(restored);}
                }
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
        this.dirtyGroups = staged.dirtyGroups; this.staleOrigins.clear();
        this.appliedStale = staged.appliedStale; this.owners = staged.owners;
        this.changedSources = new Set(); this.changedTraces = new Set();
        this.removedSources = new Set(); this.removedTraces = new Set();
        this.cached = undefined; this.version++;
    }

    private clearDelta(): void {
        this.changedSources.clear(); this.changedTraces.clear(); this.removedSources.clear(); this.removedTraces.clear();
        this.staleOrigins.clear();
    }

    takeDelta(): CoverageDelta {
        const delta = finish(this.delta());
        this.clearDelta();
        return delta;
    }

    async takeDeltaAsync(signal?: AbortSignal): Promise<CoverageDelta> {
        for (;;) {
            const version = this.version;
            const delta = await finishAsync(this.delta(), signal);
            signal?.throwIfAborted();
            if (version !== this.version) {continue;}
            this.clearDelta(); return delta;
        }
    }

    private *delta(): Generator<void, CoverageDelta> {
        const ids = new Set(this.changedSources), traces: StoredTrace[] = [];
        let count = 0;
        for (const id of [...this.changedTraces]) {
            const trace = this.records.get(id); if (!trace) {continue;}
            traces.push(trace);
            for (const source of trace.sourceIds) {ids.add(source); if (++count % 4096 === 0) {yield;}}
        }
        const sources: CoverageSource[] = [];
        for (const id of ids) {
            const source = this.sources.get(id)?.source; if (source) {sources.push(source);}
            if (++count % 4096 === 0) {yield;}
        }
        return { sources, traces, removedSources: [...this.removedSources], removedTraces: [...this.removedTraces] };
    }

    retryDelta(delta: CoverageDelta): void {
        for (const source of delta.sources) {if (this.sources.has(source.id)) {this.changedSources.add(source.id);}}
        for (const trace of delta.traces) {if (this.records.has(trace.groupId)) {
            this.changedTraces.add(trace.groupId);
            const origin = this.staleOrigins.get(trace.groupId); if (origin) {this.staleOrigins.set(trace.groupId, { ...origin, dirty: true });}
        }}
        for (const id of delta.removedTraces) {if (!this.records.has(id)) {this.removedTraces.add(id);}}
        this.version++;
    }

    summarize(hashes: ReadonlyMap<string, string>): readonly CoverageSummary[] {
        this.updateHashes(hashes);
        finish(this.dirtySources());
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
        signal?.throwIfAborted();
        this.updateHashes(hashes);
        while (!this.cached || this.dirtyGroups.size) {
            await finishAsync(this.dirtySources(), signal);
            if (this.dirtyGroups.size) {continue;}
            if (this.cached) {break;}
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
        finish(this.dirtySources());
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
        if (!changed.size) {this.hashes = hashes; return;}
        for (const file of changed) {this.dirty(file);}
        const stale = new Set<string>();
        for (const id of this.dependentGroups([...changed])) {
            const trace = this.records.get(id)!;
            if (Object.entries(trace.inputs ?? {}).some(([file, hash]) => sourceVersion(hashes, file) !== hash)) {stale.add(id);}
        }
        this.hashes = hashes; this.markStale(stale); this.version++;
    }

    /** Delay membership traversal until the scheduled, cancellable aggregation. */
    private *dirtySources(): Generator<void, void> {
        const version = this.version, groups = [...this.dirtyGroups];
        const counts = new Map<SourceRecord, number>(), applied = new Map<string, boolean>();
        let count = 0;
        for (const id of groups) {
            const trace = this.records.get(id), stale = !!trace?.stale;
            const delta = Number(stale) - Number(this.appliedStale.get(id) ?? false);
            if (delta) {
                const seen = new Set<string>();
                for (const sourceId of trace?.sourceIds ?? []) {
                    const source = this.sources.get(sourceId);
                    if (source && !seen.has(sourceId)) {counts.set(source, (counts.get(source) ?? 0) + delta); seen.add(sourceId);}
                    if (++count % 4096 === 0) {yield;}
                }
            }
            if (trace) {applied.set(id, stale);}
            if (++count % 4096 === 0) {yield;}
        }
        // A cancelled or superseded pass cannot leave partially applied counts.
        // Bump the revision even for an unrelated synchronous summary: another
        // paused pass may have captured the same pending transitions.
        if (groups.length && version === this.version) {
            for (const [source, delta] of counts) {this.changeStale(source, delta);}
            for (const [id, stale] of applied) {this.appliedStale.set(id, stale);}
            for (const id of groups) {this.dirtyGroups.delete(id);}
            this.version++;
        }
    }

    private dirty(file: string): void {this.dirtyFiles.add(file); this.cached = undefined;}

    private changeStale(source: SourceRecord, delta: number): void {
        const stale = source.staleCount > 0;
        source.staleCount += delta;
        if (stale !== (source.staleCount > 0)) {this.dirty(source.source.file);}
    }

    private invalidateAggregate(source: SourceRecord): void {
        source.aggregate = undefined; source.aggregateVersion++; this.dirty(source.source.file);
    }

    private registerSource(source: CoverageSource, canonical = false, merged = false): void {
        const previous = this.sources.get(source.id);
        const lines = merged ? source.lines : previous ? finish(sortedUnion(previous.source.lines, source.lines)) : canonical ? source.lines : finish(sortedUnion([], source.lines));
        if (previous && lines.length === previous.source.lines.length) {return;}
        this.sources.set(source.id, { source: { ...source, lines }, groups: previous?.groups ?? new Set(), hits: previous?.hits ?? new Map(),
            staleCount: previous?.staleCount ?? 0, aggregateVersion: (previous?.aggregateVersion ?? 0) + 1 });
        const versions = this.byFile.get(source.file) ?? new Set<string>(); versions.add(source.id); this.byFile.set(source.file, versions);
        this.changedSources.add(source.id); this.removedSources.delete(source.id); this.dirty(source.file); this.version++;
    }

    private install(trace: StoredTrace): void { finish(this.installation(trace)); }

    /** Only the private restore stage: no published summaries or prior group exist. */
    private *initialInstallation(trace: StoredTrace): Generator<void, void> {
        this.records.set(trace.groupId, trace); this.appliedStale.set(trace.groupId, !!trace.stale);
        let count = 0;
        for (const file of dependencyKeys(trace)) {
            const groups = this.byDependency.get(file) ?? new Set<string>(); groups.add(trace.groupId); this.byDependency.set(file, groups);
            if (++count % 512 === 0) {yield;}
        }
        for (const id of trace.sourceIds) {
            const source = this.sources.get(id)!, previousSize = source.groups.size;
            source.groups.add(trace.groupId);
            // Duplicate IDs retain one owner and one stale contribution.
            if (source.groups.size !== previousSize) {source.staleCount += Number(!!trace.stale);}
            if (++count % 512 === 0) {yield;}
        }
        for (const file of trace.coverage) {
            // Preserve last-entry wins, including the generic restore API's
            // handling of contributions outside a trace's sourceIds.
            this.sources.get(contentHash(`${file.file}\0${file.hash}`))?.hits.set(trace.groupId, file.lines);
            if (++count % 512 === 0) {yield;}
        }
        // Registration already dirtied every source. The stage has no aggregates,
        // owner arrays or durable delta to invalidate before its atomic publication.
    }

    private *installation(trace: StoredTrace): Generator<void, void> {
        const previous = this.records.get(trace.groupId), wasStale = this.appliedStale.get(trace.groupId) ?? false, stale = !!trace.stale;
        const sourceIds = new Set<string>(), dependencies = new Set(dependencyKeys(trace));
        const contributions = new Map<string, readonly CoveredLine[]>();
        let count = 0;
        for (const id of trace.sourceIds) {sourceIds.add(id); if (++count % 512 === 0) {yield;}}
        for (const file of trace.coverage) {
            contributions.set(contentHash(`${file.file}\0${file.hash}`), file.lines);
            if (++count % 512 === 0) {yield;}
        }
        if (previous) {
            for (const file of dependencyKeys(previous)) {
                if (!dependencies.has(file)) {
                    const groups = this.byDependency.get(file); groups?.delete(trace.groupId); if (!groups?.size) {this.byDependency.delete(file);}
                }
                if (++count % 512 === 0) {yield;}
            }
            for (const id of previous.sourceIds) {
                const source = this.sources.get(id)!;
                if (!sourceIds.has(id)) {this.removeMembership(source, trace.groupId, wasStale);}
                else if (!contributions.has(id) && source.hits.delete(trace.groupId)) {this.invalidateAggregate(source);}
                if (++count % 512 === 0) {yield;}
            }
        }
        this.staleOrigins.delete(trace.groupId); this.dirtyGroups.delete(trace.groupId); this.appliedStale.set(trace.groupId, stale);
        this.records.set(trace.groupId, trace); this.changedTraces.add(trace.groupId); this.removedTraces.delete(trace.groupId);
        for (const file of dependencies) {
            const groups = this.byDependency.get(file) ?? new Set<string>(); groups.add(trace.groupId); this.byDependency.set(file, groups);
            if (++count % 512 === 0) {yield;}
        }
        for (const id of sourceIds) {
            const source = this.sources.get(id)!;
            if (!source.groups.has(trace.groupId)) {
                source.groups.add(trace.groupId); this.changeOwnership(source, trace.groupId, true); source.staleCount += Number(stale);
                this.dirty(source.source.file);
            } else {this.changeStale(source, Number(stale) - Number(wasStale));}
            if (++count % 512 === 0) {yield;}
        }
        for (const [id, lines] of contributions) {
            const source = this.sources.get(id);
            if (source && source.hits.get(trace.groupId) !== lines) {
                source.hits.set(trace.groupId, lines); this.invalidateAggregate(source);
            }
            if (++count % 512 === 0) {yield;}
        }
        this.version++;
    }

    private remove(id: string): void {
        const trace = this.records.get(id);
        if (!trace) {return;}
        const stale = this.appliedStale.get(id) ?? false;
        this.appliedStale.delete(id);
        this.staleOrigins.delete(id); this.dirtyGroups.delete(id);
        this.records.delete(id); this.removedTraces.add(id); this.changedTraces.delete(id);
        for (const file of dependencyKeys(trace)) {
            const groups = this.byDependency.get(file); groups?.delete(id); if (!groups?.size) {this.byDependency.delete(file);}
        }
        for (const sourceId of trace.sourceIds) {
            const source = this.sources.get(sourceId)!;
            this.removeMembership(source, id, stale);
        }
        this.version++;
    }

    private removeMembership(source: SourceRecord, id: string, stale: boolean): void {
        if (source.groups.delete(id)) {source.staleCount -= Number(stale); this.changeOwnership(source, id, false);}
        if (source.hits.delete(id)) {this.invalidateAggregate(source);}
        this.dirty(source.source.file);
    }

    /** Published ownership arrays stay immutable; insert only genuinely new owners. */
    private changeOwnership(source: SourceRecord, id: string, add: boolean): void {
        const file = source.source.file, previous = this.owners.get(file);
        if (!previous) {return;}
        if (!add) {for (const version of this.byFile.get(file) ?? []) {
            if (this.sources.get(version)?.groups.has(id)) {return;}
        }}
        let low = 0, high = previous.length;
        while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (previous[middle] < id) {low = middle + 1;} else {high = middle;}
        }
        const exists = previous[low] === id;
        if (exists === add) {return;}
        const next = previous.slice();
        if (add) {next.splice(low, 0, id);} else {next.splice(low, 1);}
        if (next.length) {this.owners.set(file, next);} else {this.owners.delete(file);}
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

    /** Membership-only updates retain the source's already aggregated line data. */
    private *aggregate(source: SourceRecord): Generator<void, NonNullable<SourceRecord['aggregate']>> {
        if (source.aggregate) {return source.aggregate;}
        const version = source.aggregateVersion, hits = new Map<number, number>();
        let count = 0;
        for (const contribution of source.hits.values()) {for (const line of contribution) {
            hits.set(line.line, Math.max(hits.get(line.line) ?? 0, line.hits));
            if (++count % 4096 === 0) {yield;}
        }}
        const lines: CoveredLine[] = [];
        for (const line of source.source.lines) {
            lines.push({ line, hits: hits.get(line) ?? 0 });
            if (++count % 4096 === 0) {yield;}
        }
        const aggregate = { lines, covered: hits.size };
        // A synchronous editor read or contribution replacement can run while
        // this calculation yields. Keep only a complete, still-current cache.
        if (version === source.aggregateVersion) {source.aggregate ??= aggregate; return source.aggregate;}
        return aggregate;
    }

    private *calculation(file: string): Generator<void, CoverageSummary | undefined> {
        const revision = this.version;
        const versions = [...this.byFile.get(file) ?? []].map(id => this.sources.get(id)!).filter(Boolean);
        if (!versions.length) {return undefined;}
        const current = versions.find(version => version.source.hash === this.hashes.get(file));
        const displayed = current ?? versions[versions.length - 1];
        let groupIds = this.owners.get(file);
        const groups = groupIds ? undefined : new Set<string>();
        let stale = !current;
        let count = 0;
        for (const version of versions) {
            if (version !== displayed) {
                // Keep derived line objects for only the displayed source version.
                // Invalidate paused calculations too; published arrays remain intact.
                version.aggregate = undefined; version.aggregateVersion++;
            }
            // Zero-hit reports still assert that these lines were uncovered.
            // That assertion becomes stale when the reporting test changes.
            if (version.staleCount || (version !== current && version.hits.size)) {stale = true;}
            if (groups) {for (const group of version.groups) {
                groups.add(group);
                if (++count % 4096 === 0) {yield;}
            }}
        }
        if (!groupIds) {
            groupIds = [...groups!].sort();
            if (revision === this.version) {this.owners.set(file, groupIds);}
        }
        const previous = this.summaries.get(file);
        const aggregate = yield* this.aggregate(displayed);
        let sameLines = previous?.lines === aggregate.lines;
        if (!sameLines && previous?.lines.length === aggregate.lines.length) {
            sameLines = true;
            for (let index = 0; index < aggregate.lines.length; index++) {
                const line = aggregate.lines[index], old = previous.lines[index];
                if (line.line !== old.line || line.hits !== old.hits) {sameLines = false; break;}
                if (++count % 4096 === 0) {yield;}
            }
        }
        const lines = sameLines ? previous!.lines : aggregate.lines;
        if (sameLines && displayed.aggregate === aggregate && lines !== aggregate.lines) {
            displayed.aggregate = { ...aggregate, lines };
        }
        if (previous && sameLines && previous.stale === stale && previous.covered === aggregate.covered
            && (previous.groupIds === groupIds || (previous.groupIds.length === groupIds.length && groupIds.every((id, index) => id === previous.groupIds[index])))) {return previous;}
        return { file, lines, stale, covered: aggregate.covered, total: lines.length, groupIds };
    }
}
