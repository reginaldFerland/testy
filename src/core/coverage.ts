import { setImmediate as yieldTurn } from 'node:timers/promises';
import { CoveredLine, Declaration, TestFile, Trace } from './model';
import { contentHash, sourceVersion, testFileId } from './paths';
import { finish, finishAsync, sortedUnion } from './work';
import type { FileHits } from './memberImpact';

export interface CoverageSummary {
    readonly file: string;
    readonly lines: readonly CoveredLine[];
    /** Method spans of the displayed source version, when the reports carried them. */
    readonly declarations?: readonly Declaration[];
    readonly stale: boolean;
    readonly covered: number;
    readonly total: number;
    readonly groupIds: readonly string[];
}
export interface CoverageSource {
    readonly id: string; readonly file: string; readonly hash: string; readonly lines: readonly number[];
    readonly declarations?: readonly Declaration[];
}

const declarationKey = (declaration: Declaration): string => `${declaration.start}:${declaration.end}:${declaration.name}`;

/** Method spans are geometry like lines: a sorted union across reports that
 * returns `previous` itself when `next` adds nothing. */
export function mergeDeclarations(previous: readonly Declaration[] | undefined, next: readonly Declaration[] | undefined): readonly Declaration[] | undefined {
    if (!next?.length || previous === next) {return previous;}
    const known = new Set(previous?.map(declarationKey));
    if (previous && next.every(declaration => known.has(declarationKey(declaration)))) {return previous;}
    const unique = new Map([...previous ?? [], ...next].map(declaration => [declarationKey(declaration), declaration]));
    return [...unique.values()].sort((a, b) => a.start - b.start || a.end - b.end || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Each method with instrumented lines, hit as often as its first instrumented line ran
 * (or its busiest line, when only later lines report hits). */
export function declarationHits(lines: readonly CoveredLine[], declarations: readonly Declaration[]): { readonly declaration: Declaration; readonly hits: number }[] {
    const result: { declaration: Declaration; hits: number }[] = [];
    for (const declaration of declarations) {
        let low = 0, high = lines.length;
        // Indices stay below lines.length throughout: middle < high, and the scan checks its bound.
        while (low < high) {const middle = (low + high) >>> 1; if (lines[middle]!.line < declaration.start) {low = middle + 1;} else {high = middle;}}
        const first = lines[low];
        if (!first || first.line > declaration.end) {continue;}
        let hits = first.hits;
        for (let index = low; !hits && index < lines.length && lines[index]!.line <= declaration.end; index++) {hits = Math.max(hits, lines[index]!.hits);}
        result.push({ declaration, hits });
    }
    return result;
}
export interface StoredTrace extends Trace { readonly sourceIds: readonly string[]; }
export interface CoverageDelta {
    readonly sources: readonly CoverageSource[];
    readonly traces: readonly StoredTrace[];
    readonly removedSources: readonly string[];
    readonly removedTraces: readonly string[];
}
/** Running per-line maxima over a source version's contributions, kept while the version is displayed. Contribution
 * changes since the last aggregation wait in `pending`; `unknown` lines lost their only maximum and are recomputed. */
interface LineMaxima {
    readonly max: Map<number, number>;
    /** How many contribution entries hold each line's maximum. */
    readonly holders: Map<number, number>;
    readonly unknown: Set<number>;
    readonly pending: [before: readonly CoveredLine[] | undefined, after: readonly CoveredLine[] | undefined][];
    revision: number;
}
interface SourceRecord {
    source: CoverageSource;
    readonly groups: Set<string>;
    readonly hits: Map<string, readonly CoveredLine[]>;
    staleCount: number;
    aggregate?: { readonly lines: readonly CoveredLine[]; readonly covered: number } | undefined;
    aggregateVersion: number;
    maxima?: LineMaxima | undefined;
}
/** A file's test-file owners across its source versions; the published sorted array is rebuilt lazily from the changes since. */
interface Owners { readonly members: Set<string>; sorted: readonly string[]; readonly added: string[]; removed: boolean }
/** Files whose version differs between two maps, without materializing their key sets. */
function changedFiles(previous: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): string[] {
    const files: string[] = [];
    for (const [file, hash] of next) {if (previous.get(file) !== hash) {files.push(file);}}
    for (const file of previous.keys()) {if (!next.has(file)) {files.push(file);}}
    return files;
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
    private owners = new Map<string, Owners>();
    private readonly staleOrigins = new Map<string, { trace: StoredTrace; dirty: boolean }>();
    private changedSources = new Set<string>();
    private changedTraces = new Set<string>();
    private removedSources = new Set<string>();
    private removedTraces = new Set<string>();
    /** The versions summaries display, and the versions trace freshness was last checked against (see applyHashes). */
    private hashes: ReadonlyMap<string, string> = new Map();
    private appliedHashes: ReadonlyMap<string, string> = new Map();
    /** Restored traces were learned before this process knew any version: the next applyHashes checks all of them. */
    private unchecked = false;
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

    /** What a reliable trace recorded in a file: the version it ran against, its positive hits there and that version's
     * instrumentable lines. Undefined when the trace cannot narrow, or reached the file without executing a line of it. */
    fileHits(groupId: string, file: string): FileHits | undefined {
        const trace = this.records.get(groupId);
        if (!trace?.reliable || trace.historical) {return undefined;}
        const entry = trace.coverage.find(coverage => coverage.file === file);
        const source = entry && this.sources.get(contentHash(`${file}\0${entry.hash}`))?.source;
        return entry && source ? { hash: entry.hash, hits: entry.lines, lines: source.lines } : undefined;
    }

    /** Whether some trace's coverage refers to this version of a file. */
    hasVersion(file: string, hash: string): boolean { return this.sources.has(contentHash(`${file}\0${hash}`)); }

    /** The instrumentable lines and method spans of a version of a file, when some trace's coverage refers to it. */
    versionGeometry(file: string, hash: string): CoverageSource | undefined { return this.sources.get(contentHash(`${file}\0${hash}`))?.source; }

    invalidate(groupIds: ReadonlySet<string>, stale = true): void {
        let changed = false;
        for (const id of groupIds) {
            const trace = this.records.get(id);
            if (!trace || (!trace.reliable && (!stale || trace.stale))) {continue;}
            this.records.set(id, { ...trace, reliable: false, stale: stale || trace.stale === true });
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
                const declarations = mergeDeclarations(previous?.declarations, file.declarations);
                sources.set(id, previous && previous.lines.length === lines.length && previous.declarations === declarations ? previous
                    : { id, file: file.file, hash: file.hash, lines, ...declarations ? { declarations } : {} });
                sourceIds.push(id);
                // Compare while packing can still yield. Installation checks the
                // current array identity again; a concurrent replacement cannot
                // authorize reuse of an aggregate for different hit data.
                // Spans live on the shared source, not in each test file's hits.
                if (hits.length) {coverage.push({ file: file.file, hash: file.hash, lines: sameHits && previousHits!.length === hits.length ? previousHits! : hits });}
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

    /** Saved traces narrow selections again only when `trusted` vouches for them (see services/engine/identity); every other
     * one is history: shown stale, never reliable. The next applyHashes checks every restored trace against its inputs. */
    restorePacked(sources: readonly CoverageSource[], traces: readonly StoredTrace[], canonical = false, trusted?: (trace: StoredTrace) => boolean): void {
        for (const source of sources) {this.registerSource(source, canonical);}
        for (const trace of traces) {
            if (trace.sourceIds.every(id => this.sources.has(id))) {this.install(restoredTrace(trace, trusted));}
        }
        this.pruneSources();
        this.clearDelta(); this.unchecked = true;
    }

    /** Stage the entire restored checkpoint before publishing any of its indexes; `trusted` as for restorePacked. */
    async restorePackedAsync(sources: readonly CoverageSource[], traces: readonly StoredTrace[], signal?: AbortSignal, version = this.version,
        trusted?: (trace: StoredTrace) => boolean): Promise<void> {
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
                    const restored = restoredTrace(trace, trusted);
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
        this.cached = undefined; this.unchecked = true; this.version++;
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

    /** Reads only display `hashes`: trace freshness and the durable delta change only through applyHashes. */
    summarize(hashes: ReadonlyMap<string, string>): readonly CoverageSummary[] {
        this.display(hashes);
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
        this.display(hashes);
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

    /** The displayed version of a file's lines, with hits from only the given test files. */
    contribution(file: string, groupIds: ReadonlySet<string>, hashes: ReadonlyMap<string, string>): readonly CoveredLine[] | undefined {
        const versions = [...this.byFile.get(file) ?? []].map(id => this.sources.get(id)).filter((source): source is SourceRecord => !!source);
        const displayed = versions.find(version => version.source.hash === hashes.get(file)) ?? versions[versions.length - 1];
        if (!displayed) {return undefined;}
        const hits = new Map<number, number>();
        for (const id of groupIds) {for (const line of displayed.hits.get(id) ?? []) {hits.set(line.line, Math.max(hits.get(line.line) ?? 0, line.hits));}}
        return displayed.source.lines.map(line => ({ line, hits: hits.get(line) ?? 0 }));
    }

    summary(file: string, hashes: ReadonlyMap<string, string>): CoverageSummary | undefined {
        this.display(hashes);
        finish(this.dirtySources());
        if (this.dirtyFiles.delete(file)) {
            this.version++;
            const summary = this.calculate(file);
            if (summary) {this.summaries.set(file, summary);} else {this.summaries.delete(file);}
        }
        return this.summaries.get(file);
    }

    /** The engine applies each new source version map: traces that depend on a changed file and no longer match it become stale
     * (and are saved), and summaries display the new versions. Only traces that depend on a changed file are checked, except
     * after a restore, which checks every trace. `changesSince` names the files that differ from the previously applied map
     * when its owner knows them (see SourceTracker.changedSince); otherwise the two maps are compared. */
    applyHashes(hashes: ReadonlyMap<string, string>, changesSince?: (applied: ReadonlyMap<string, string>) => readonly string[] | undefined): void {
        if (this.appliedHashes === hashes && !this.unchecked) {this.display(hashes); return;}
        const changed = this.appliedHashes === hashes ? [] : changesSince?.(this.appliedHashes) ?? changedFiles(this.appliedHashes, hashes);
        const displayed = this.hashes === this.appliedHashes, unchecked = this.unchecked;
        this.appliedHashes = hashes; this.unchecked = false;
        if (!changed.length && !unchecked) {this.display(hashes); return;}
        const stale = new Set<string>();
        for (const id of unchecked ? this.records.keys() : this.dependentGroups(changed)) {
            const trace = this.records.get(id)!;
            if (Object.entries(trace.inputs ?? {}).some(([file, hash]) => sourceVersion(hashes, file) !== hash)) {stale.add(id);}
        }
        this.display(hashes, displayed ? changed : undefined); this.markStale(stale);
    }

    /** Display other versions; `changed` lists the files that differ from the displayed map, when known. */
    private display(hashes: ReadonlyMap<string, string>, changed?: readonly string[]): void {
        if (this.hashes === hashes) {return;}
        const files = changed ?? changedFiles(this.hashes, hashes);
        this.hashes = hashes;
        if (!files.length) {return;}
        for (const file of files) {this.dirty(file);}
        this.version++;
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

    /** Every published contribution change passes through here, so running maxima see each transition. */
    private changeHits(source: SourceRecord, id: string, lines: readonly CoveredLine[] | undefined): void {
        const before = source.hits.get(id);
        if (before === lines) {return;}
        if (lines) {source.hits.set(id, lines);} else {source.hits.delete(id);}
        const maxima = source.maxima;
        if (maxima) {
            maxima.pending.push([before, lines]); maxima.revision++;
            // A long backlog costs more than one fresh pass over the contributions.
            if (maxima.pending.length > source.hits.size + 64) {source.maxima = undefined;}
        }
        this.invalidateAggregate(source);
    }

    private registerSource(source: CoverageSource, canonical = false, merged = false): void {
        const previous = this.sources.get(source.id);
        const lines = merged ? source.lines : previous ? finish(sortedUnion(previous.source.lines, source.lines)) : canonical ? source.lines : finish(sortedUnion([], source.lines));
        const declarations = mergeDeclarations(previous?.source.declarations, source.declarations);
        if (previous && lines.length === previous.source.lines.length && declarations === previous.source.declarations) {return;}
        this.sources.set(source.id, { source: { ...source, lines, ...declarations ? { declarations } : {} }, groups: previous?.groups ?? new Set(), hits: previous?.hits ?? new Map<string, readonly CoveredLine[]>(),
            staleCount: previous?.staleCount ?? 0, aggregateVersion: (previous?.aggregateVersion ?? 0) + 1, maxima: previous?.maxima });
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
                else if (!contributions.has(id)) {this.changeHits(source, trace.groupId, undefined);}
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
            if (source) {this.changeHits(source, trace.groupId, lines);}
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
        this.changeHits(source, id, undefined);
        this.dirty(source.source.file);
    }

    /** Record only genuinely new or departed owners; the next summary publishes a new array (see ownerList). */
    private changeOwnership(source: SourceRecord, id: string, add: boolean): void {
        const file = source.source.file, owners = this.owners.get(file);
        if (!owners || owners.members.has(id) === add) {return;}
        if (!add) {for (const version of this.byFile.get(file) ?? []) {
            if (this.sources.get(version)?.groups.has(id)) {return;}
        }}
        if (add) {owners.members.add(id); owners.added.push(id);} else {owners.members.delete(id); owners.removed = true;}
        if (!owners.members.size) {this.owners.delete(file);}
    }

    /** Published ownership arrays stay immutable: merge the sorted additions into a copy that omits departed owners. */
    private ownerList(owners: Owners): readonly string[] {
        if (!owners.added.length && !owners.removed) {return owners.sorted;}
        const previous = owners.sorted, members = owners.members;
        const added = [...new Set(owners.added)].filter(id => members.has(id) && !sortedHas(previous, id)).sort();
        const next: string[] = [];
        let index = 0;
        for (const id of previous) {
            if (!members.has(id)) {continue;}
            while (index < added.length && added[index]! < id) {next.push(added[index++]!);}
            next.push(id);
        }
        while (index < added.length) {next.push(added[index++]!);}
        owners.sorted = next; owners.added.length = 0; owners.removed = false;
        return next;
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

    /** Membership-only updates retain the source's already aggregated line data. Contribution changes update the running
     * maxima in proportion to their own lines; only lines whose sole maximum was removed or lowered are scanned again. */
    private *aggregate(source: SourceRecord): Generator<void, NonNullable<SourceRecord['aggregate']>> {
        if (source.aggregate) {return source.aggregate;}
        const version = source.aggregateVersion;
        let count = 0, maxima = source.maxima;
        if (!maxima) {
            const built: LineMaxima = { max: new Map(), holders: new Map(), unknown: new Set(), pending: [], revision: 0 };
            for (const contribution of source.hits.values()) {for (const line of contribution) {
                raise(built, line);
                if (++count % 4096 === 0) {yield;}
            }}
            // Counts built across a contribution change are used once and never retained.
            maxima = version === source.aggregateVersion ? source.maxima ??= built : built;
        }
        // Applied without yielding: a paused pass can never observe half a transition.
        for (const [before, after] of maxima.pending) {
            for (const line of before ?? []) {lower(maxima, line);}
            for (const line of after ?? []) {raise(maxima, line);}
        }
        maxima.pending.length = 0;
        let recomputed: Map<number, [max: number, holders: number]> | undefined;
        if (maxima.unknown.size) {
            const revision = maxima.revision, unknown = maxima.unknown;
            recomputed = new Map();
            for (const contribution of source.hits.values()) {for (const { line, hits } of contribution) {
                if (unknown.has(line)) {
                    const value = recomputed.get(line);
                    if (!value || hits > value[0]) {recomputed.set(line, [hits, 1]);} else if (hits === value[0]) {value[1]++;}
                }
                if (++count % 4096 === 0) {yield;}
            }}
            if (revision === maxima.revision && source.maxima === maxima) {
                for (const [line, [max, holders]] of recomputed) {maxima.max.set(line, max); maxima.holders.set(line, holders);}
                unknown.clear(); recomputed = undefined;
            }
        }
        const max = maxima.max, covered = max.size + (recomputed?.size ?? 0), lines: CoveredLine[] = [];
        for (const line of source.source.lines) {
            lines.push({ line, hits: recomputed?.get(line)?.[0] ?? max.get(line) ?? 0 });
            if (++count % 4096 === 0) {yield;}
        }
        const aggregate = { lines, covered };
        // A synchronous editor read or contribution replacement can run while
        // this calculation yields. Keep only a complete, still-current cache.
        if (version === source.aggregateVersion) {source.aggregate ??= aggregate; return source.aggregate;}
        return aggregate;
    }

    private *calculation(file: string): Generator<void, CoverageSummary | undefined> {
        const revision = this.version;
        const versions = [...this.byFile.get(file) ?? []].flatMap(id => this.sources.get(id) ?? []);
        const current = versions.find(version => version.source.hash === this.hashes.get(file));
        const displayed = current ?? versions.at(-1);
        if (!displayed) {return undefined;}
        const owners = this.owners.get(file);
        let groupIds = owners && this.ownerList(owners);
        const groups = groupIds ? undefined : new Set<string>();
        let stale = !current;
        let count = 0;
        for (const version of versions) {
            if (version !== displayed) {
                // Keep derived line objects for only the displayed source version.
                // Invalidate paused calculations too; published arrays remain intact.
                version.aggregate = undefined; version.aggregateVersion++; version.maxima = undefined;
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
            if (revision === this.version && groupIds.length) {this.owners.set(file, { members: groups!, sorted: groupIds, added: [], removed: false });}
        }
        const previous = this.summaries.get(file);
        const aggregate = yield* this.aggregate(displayed);
        let sameLines = previous?.lines === aggregate.lines;
        if (!sameLines && previous?.lines.length === aggregate.lines.length) {
            sameLines = true;
            // Both arrays have the same length, checked above.
            for (let index = 0; index < aggregate.lines.length; index++) {
                const line = aggregate.lines[index]!, old = previous.lines[index]!;
                if (line.line !== old.line || line.hits !== old.hits) {sameLines = false; break;}
                if (++count % 4096 === 0) {yield;}
            }
        }
        const lines = sameLines ? previous!.lines : aggregate.lines;
        if (sameLines && displayed.aggregate === aggregate && lines !== aggregate.lines) {
            displayed.aggregate = { ...aggregate, lines };
        }
        const declarations = displayed.source.declarations;
        if (previous && sameLines && previous.stale === stale && previous.covered === aggregate.covered && previous.declarations === declarations
            && (previous.groupIds === groupIds || (previous.groupIds.length === groupIds.length && groupIds.every((id, index) => id === previous.groupIds[index])))) {return previous;}
        return { file, lines, ...declarations ? { declarations } : {}, stale, covered: aggregate.covered, total: lines.length, groupIds };
    }
}

function sortedHas(values: readonly string[], value: string): boolean {
    let low = 0, high = values.length;
    while (low < high) {const middle = (low + high) >>> 1; if (values[middle]! < value) {low = middle + 1;} else {high = middle;}}
    return values[low] === value;
}

/** Running maxima: one more contribution entry for a line. A line awaiting recomputation reads the final contributions instead. */
function raise(maxima: LineMaxima, { line, hits }: CoveredLine): void {
    if (maxima.unknown.has(line)) {return;}
    const max = maxima.max.get(line);
    if (max === undefined || hits > max) {maxima.max.set(line, hits); maxima.holders.set(line, 1);}
    else if (hits === max) {maxima.holders.set(line, maxima.holders.get(line)! + 1);}
}

/** Running maxima: one contribution entry fewer. Removing a line's last maximum leaves its value unknown. */
function lower(maxima: LineMaxima, { line, hits }: CoveredLine): void {
    if (maxima.unknown.has(line) || maxima.max.get(line) !== hits) {return;}
    const holders = maxima.holders.get(line)! - 1;
    if (holders) {maxima.holders.set(line, holders);} else {maxima.max.delete(line); maxima.holders.delete(line); maxima.unknown.add(line);}
}

/** A trace as restored from disk: as saved when `trusted` vouches for it, otherwise stale history that never narrows a selection. */
function restoredTrace(trace: StoredTrace, trusted: ((trace: StoredTrace) => boolean) | undefined): StoredTrace {
    return trusted?.(trace) ? { ...trace, stale: trace.stale ?? false } : { ...trace, reliable: false, stale: true };
}

export function projectCoverageId(group: TestFile): string { return `project:${testFileId(group.project, group.framework)}`; }
