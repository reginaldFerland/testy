import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { DiscoveredTest, EngineConfiguration, Project, TestFile, TestResult, Trace } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection } from '../core/selection';
import { defaultExcludes, isConfigurationFile, isExcluded, isToolingFile, normalizePath, normalizePathsAsync, sourceVersion } from '../core/paths';
import { consumesChanges, FailingTests, isStructuralChange, needsSourceSweep, TestOutcome, TestOutcomes, traceIsCurrent } from '../core/runPolicy';
import { ProcessOptions, Shutdown } from './process';
import { projectCoverageId, RunnerSession } from './runner';
import { SourceShape } from './analysis';
import { AnalyzerServers } from './analyzerServer';
import { SourceTracker } from './sources';
import { RuntimeInventory } from './runtimeInventory';
import { CoverageCache, SavedCheckpoint } from './cache';
import { discoveredTest } from './mtp';
import { claimRunOutputs, reclaimRunOutputs } from './runOutputs';
import { PreparedOutputCache } from './preparedOutputCache';
import { ProjectEvaluationCache } from './projectEvaluationCache';
import { resolveConcurrency, resolveTestFileConcurrency, SerialQueue, untilAborted } from '../core/concurrency';
import { EnvironmentError, isAbortError } from '../core/errors';
import type { EngineHost } from './engine/host';
import { Baseline } from './engine/baseline';
import { SdkChecks } from './engine/sdk';
import { planBuild } from './engine/plan';
import { refreshStructure } from './engine/structure';
import { build } from './engine/build';
import { prepareTests } from './engine/prepare';
import { selectRun } from './engine/select';
import { executeSelection } from './engine/execute';
import { coverageIdentity, settingsIdentity } from './engine/identity';
import { changedVersions, fileStamps } from './engine/untracked';
import { HashMemo } from './hashMemo';
import { AnalysisState, EngineEvents, EngineOptions, EngineServices, ManualSelection, phaseTimingNames, RunContext, RunPhase, RunScope, RunSummary, SelectedRun, StructureState } from './engine/types';
import type { RunnerOptions } from './runnerTypes';
export { selectManual } from './engine/selectManual';
export type { EngineEvents, EngineOptions, EngineServices, ManualSelection, RunPhase, RunScope, RunSummary };

export type { EngineConfiguration };

/** Members that are not private are shared with the run stages in ./engine through EngineHost, a read-only view:
 * stages return their results, pass them to the `apply` methods below, or call the named methods that own each write. */
export class TestEngine implements EngineHost {
    readonly coverage = new CoverageStore();
    readonly sources = new SourceTracker();
    projects: readonly Project[] = [];
    groups: readonly TestFile[] = [];
    buildGraph: readonly Project[] = [];
    private roots: readonly string[];
    index = new ProjectIndex([]);
    private initialized = false;
    structureDirty = true;
    topology = 0;
    private baseline: Baseline | undefined;
    shapes: ReadonlyMap<string, string | null> = new Map();
    analyses: ReadonlyMap<string, SourceShape | null> = new Map();
    analyzedHashes: ReadonlyMap<string, string> = new Map();
    analysisContext: string | undefined;
    aliasStamp: string | undefined;
    excludedAliases: readonly string[] = [];
    readonly sdk = new SdkChecks();
    readonly restored = new Set<string>();
    readonly runtime = new RuntimeInventory();
    /** The latest outcome of every test, saved with the coverage cache. */
    readonly lastOutcomes = new TestOutcomes();
    private readonly cache: CoverageCache;
    readonly identity = randomUUID();
    readonly preparedOutputs: PreparedOutputCache;
    readonly analyzerServers: AnalyzerServers;
    readonly createSession: (options: RunnerOptions) => RunnerSession;
    private readonly operations = new Map<AbortController, Promise<RunSummary>>();
    private disposed = false;
    private disposal?: Promise<void>;
    private readonly pendingChanges = new Set<string>();
    projectSnapshots: ReadonlyMap<string, readonly Project[]> = new Map();
    readonly projectEvaluations: ProjectEvaluationCache;
    private inputTopology = 0;
    inputs: readonly string[] = [];
    private inputDirectories: readonly string[] = [];
    /** Tool hashes survive across runs; their keys include a metadata stamp. */
    readonly toolIdentities = new Map<string, Promise<string>>();
    unsupportedReport = '';
    readonly resultObservers = new Set<(group: TestFile, result: TestResult) => void>();
    /** Every save runs in order, so an older delta can never overwrite a newer one. */
    private readonly saves = new SerialQueue();
    private saveTimer: NodeJS.Timeout | undefined;
    /** How long a scheduled save waits for further contributions to share its locked write. */
    private saveDelay = 150;
    /** Bounds background saves only at disposal, when another window may hold the cache lock. */
    private readonly saveController = new AbortController();
    /** What the current coverage was learned under (see engine/identity); unset until a baseline starts or a checkpoint is restored.
     * A run under another identity starts a new baseline: coverage learned under other settings or tools cannot narrow selections. */
    private learned: { readonly settings: string; readonly identity: string } | undefined;
    /** Once the baseline is complete: the source versions the coverage and selections account for. Saved as the checkpoint. */
    private settled: ReadonlyMap<string, string> = new Map();
    private settledRevision = 0;
    /** The checkpoint state last saved; unknown until the first save or restore. */
    private savedCheckpoint: string | undefined;
    /** Changes with every change of `pendingChanges`, which the checkpoint saves. */
    private pendingRevision = 0;
    /** Watched files outside every project (see engine/untracked): each run stamps those still outside, so a restart can compare them. */
    private unowned = new Set<string>();
    /** Restored package assets by content, as of the latest structural refresh. */
    private assets: ReadonlyMap<string, string> = new Map();
    readonly assetHashes = new HashMemo(4096);
    /** The SDK versions and evaluation tools of the latest structural refresh, and those the current coverage was learned with. */
    private toolchain: string | undefined;
    private learnedToolchain: string | undefined;
    /** Once the baseline is complete: the untracked versions (see engine/untracked) the coverage accounts for. Saved with the checkpoint. */
    private settledUntracked: ReadonlyMap<string, string> = new Map();
    /** Every test target has been discovered in this session, so runs need build only what they affect. */
    private inventoried = false;

    /** `services` replaces the collaborators the engine otherwise creates for its storage. */
    constructor(readonly options: EngineOptions, services: Partial<EngineServices> = {}) {
        this.roots = options.roots.map(normalizePath);
        this.cache = services.coverageCache ?? new CoverageCache(options.storage, options.events.output);
        this.preparedOutputs = services.preparedOutputs ?? new PreparedOutputCache(options.storage, this.identity, { persist: true, log: options.events.output });
        this.projectEvaluations = services.projectEvaluations ?? new ProjectEvaluationCache(options.storage, {}, options.events.output);
        this.analyzerServers = services.analyzerServers ?? new AnalyzerServers();
        this.createSession = services.createSession ?? (runnerOptions => new RunnerSession(runnerOptions));
    }

    get hashes(): ReadonlyMap<string, string> { return this.sources.hashes; }
    /** Files whose latest results include a failure; impact runs schedule them first. */
    get failing(): FailingTests { return this.lastOutcomes.failing; }
    /** The latest outcome of every test by the `group:test` id the tree uses, including outcomes restored from the cache. */
    get outcomes(): ReadonlyMap<string, TestOutcome> { return this.lastOutcomes.byTest; }
    get inputVersion(): number { return this.inputTopology; }
    get knownFiles(): readonly string[] { return this.inputs; }
    get directories(): readonly string[] { return this.inputDirectories; }
    get displayGroups(): readonly TestFile[] { return this.runtime.containers.size ? [...this.groups, ...this.runtime.containers.values()] : this.groups; }
    get baselineProgress(): { completed: number; total: number } | undefined {
        return this.baseline ? { completed: this.baseline.completed.size, total: this.groups.length } : undefined;
    }

    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[] { return this.runtime.tests(group); }

    setRoots(roots: readonly string[]): void {
        this.roots = roots.map(normalizePath); this.topology++; this.structureDirty = true;
        this.sources.mark([]); this.coverage.markStale(new Set(this.coverage.traces.keys()));
    }

    select(files: readonly string[], conservative = false): Selection {
        return selectTests(this.groups, this.projects, this.coverage.traces, files, this.options.configuration().mode, false,
            conservative ? new Set(files) : new Set(), this.index, file => this.coverage.dependentGroups([file]), project => this.coverage.dependentProjects([project]));
    }

    /** Normal event handling only marks versions; it performs no source-tree I/O. The changes stay pending until a run consumes
     * them, and the checkpoint saves them: a change that no run consumed, for example while automatic runs are paused, reruns
     * what it affects after a restart even if the file is not one whose version the restart compares. */
    async markChanged(files?: readonly string[]): Promise<void> {
        if (!files) {files = await this.sources.refresh(this.sources.files);}
        this.sources.mark(files); this.addPending(files);
        const selected = this.select(files, true);
        this.coverage.markStale(new Set([...selected.groups.map(group => group.id), ...this.coverage.dependentGroups(files)]));
        await this.publishCoverage();
    }

    private addPending(files: Iterable<string>): void {
        const size = this.pendingChanges.size;
        for (const file of files) {this.pendingChanges.add(file);}
        if (this.pendingChanges.size !== size) {this.pendingRevision++;}
    }

    /** Restore saved coverage and outcomes. Coverage saved under the current identity with a checkpoint resumes that checkpoint
     * as a baseline: its complete files stay complete, and the first run reruns only what changed since (every file whose version
     * differs from the saved one, conservatively) and the files the checkpoint cannot vouch for. Anything else starts a fresh baseline. */
    async restore(signal?: AbortSignal): Promise<void> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        // Each directory has its own lock; both are reclaimed before either error is reported.
        const reclaimed = await Promise.allSettled(['runs', 'prepared'].map(name => reclaimRunOutputs(path.join(this.options.storage, name), signal, this.options.events.output)));
        for (const result of reclaimed) {if (result.status === 'rejected') {throw result.reason;}}
        try {
            const configured = this.options.configuration();
            const identity = await coverageIdentity(configured, this.roots, this.toolIdentities, signal);
            const restored = await this.cache.restore(this.coverage, signal, identity);
            this.lastOutcomes.restore(restored.outcomes);
            if (restored.checkpoint && !this.learned) {this.resume(restored.checkpoint, settingsIdentity(configured, this.roots));}
            this.options.events.restored?.();
        } catch (error) {
            signal?.throwIfAborted();
            if (isAbortError(error)) {throw error;}
            this.options.events.output(`Coverage cache unavailable; starting a fresh baseline. ${String(error)}\n`);
        }
    }

    /** Only files whose restored trace was learned under the checkpoint's identity, and was current and reliable when saved, are
     * complete: a trace saved stale (a change had marked it, and no run consumed that change) or incomplete is learned again.
     * Changes no run consumed are pending again. */
    private resume(checkpoint: SavedCheckpoint, settings: string): void {
        const completed = checkpoint.completed.filter(id => {
            const trace = this.coverage.traces.get(id);
            return trace?.identity === checkpoint.identity && trace.reliable && !trace.stale;
        });
        const baseline = new Baseline(`resume:${randomUUID()}`, checkpoint.shapes, true);
        baseline.complete(completed); baseline.rebase(checkpoint.shapes, checkpoint.versions, checkpoint.untracked ?? new Map());
        this.addPending(checkpoint.pending ?? []); this.learnedToolchain = checkpoint.toolchain;
        this.baseline = baseline; this.learned = { settings, identity: checkpoint.identity }; this.savedCheckpoint = this.checkpointState();
        this.options.events.output(`Restored saved coverage for ${completed.length} test file${completed.length === 1 ? '' : 's'}; the next run checks what changed since it was saved.\n`);
    }

    /** Whether the settings now differ from those the coverage was learned under, so the next run starts a new baseline. */
    configurationChanged(): boolean {
        return !!this.learned && settingsIdentity(this.options.configuration(), this.roots) !== this.learned.settings;
    }

    async run(batch: ChangeBatch, signal: AbortSignal, manual?: ManualSelection, manualOperation = false, scope?: RunScope, coverage?: boolean): Promise<RunSummary> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        signal.throwIfAborted();
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        const operation = this.runBatch(batch, controller, manual, manualOperation, scope, coverage);
        this.operations.set(controller, operation);
        try {return await operation;}
        finally {this.operations.delete(controller); signal.removeEventListener('abort', abort);}
    }

    /** Forget learned coverage, test outcomes, saved evaluations, analyses and idle prepared outputs.
     * The next run establishes a fresh baseline. Call only while no run is active. */
    async reset(signal?: AbortSignal): Promise<void> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        if (this.operations.size) {throw new Error('Testy cannot reset while a run is active.');}
        this.coverage.replace([], new Set());
        await this.projectEvaluations.clear(signal);
        await this.preparedOutputs.evictIdle(signal);
        this.initialized = false; this.baseline = undefined; this.structureDirty = true;
        this.learned = undefined; this.settled = new Map(); this.settledUntracked = new Map(); this.learnedToolchain = undefined;
        this.shapes = new Map(); this.analyses = new Map(); this.analyzedHashes = new Map();
        this.analysisContext = undefined; this.aliasStamp = undefined;
        await this.sdk.stop();
        this.restored.clear(); this.toolIdentities.clear(); this.lastOutcomes.clear();
        await this.publishCoverage(signal); await this.save(signal);
        this.options.events.output('Testy caches were reset; the next run establishes a new baseline.\n');
    }

    /** Stop admitting work, drain owned processes, then remove retained preparations. */
    dispose(): Promise<void> {
        if (!this.disposal) {
            this.disposed = true;
            for (const controller of this.operations.keys()) {controller.abort(new Shutdown());}
            this.sdk.abort();
            this.disposal = (async () => {
                await Promise.allSettled(this.operations.values());
                // Runs start flushing their own saves; wait for them unless another window holds the cache lock too long.
                const stop = setTimeout(() => this.saveController.abort(), 5000);
                try {await this.flushSaves();} finally {clearTimeout(stop);}
                // Every step runs even if an earlier one fails: the evaluation snapshot is saved and prepared containers are removed.
                const failures: unknown[] = [];
                for (const step of [() => this.sdk.stop(), () => this.analyzerServers.dispose(), () => this.projectEvaluations.dispose(), () => this.preparedOutputs.dispose()]) {
                    try {await step();}
                    catch (error) {failures.push(error); this.options.events.output(`Testy shutdown cleanup failed: ${String(error)}\n`);}
                }
                if (failures.length === 1) {throw failures[0];}
                if (failures.length) {throw new AggregateError(failures, 'Testy shutdown cleanup failed.');}
            })();
        }
        return this.disposal;
    }

    private async runBatch(batch: ChangeBatch, controller: AbortController, manual?: ManualSelection, manualOperation = false, scope?: RunScope, coverage?: boolean): Promise<RunSummary> {
        let run = { ...await this.startRun(batch, controller, manual, manualOperation, coverage), scope: manual ? undefined : scope };
        const state: { sessions?: RunnerSession; analyzing?: Promise<ReadonlyMap<string, string | null>> } = {};
        try {
            if (run.structural) {
                run.phase('preparingProjects');
                await refreshStructure(this, run);
            }
            const untracked = await this.untrackedVersions(run);
            run = { ...run, untracked }; this.adoptToolchain(run.baseline);
            if (run.baseline?.resumed) {run = { ...run, changes: this.changedSinceCheckpoint(run.baseline, run.changes, untracked) };}
            const beforeBuild = this.hashes;
            await this.publishCoverage(run.signal);
            const plan = await planBuild(this, run);
            const outputLease = await claimRunOutputs(path.join(this.options.storage, 'runs'), this.identity, run.signal, this.options.events.output);
            try {
                run.phase('building');
                const built = await build(this, run, plan, outputLease, beforeBuild);
                run.phase('preparingTests');
                const prepared = await prepareTests(this, run, plan, built, outputLease, state);
                if (run.discoverAll) {this.inventoried = true;}
                const selected = await selectRun(this, run, built, prepared);
                await this.adoptSelection(run, selected);
                run.phase('testing');
                const tested = await executeSelection(this, run, built, prepared, selected);
                run.signal.throwIfAborted();
                this.finishRun(run, selected, built.before);
                await this.publishCoverage(run.signal); await this.save(run.signal);
                const results = tested.results;
                return { files: tested.executedFiles.size, tests: results.length, passed: results.filter(result => result.outcome === 'passed').length,
                    failed: results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length,
                    skipped: results.filter(result => result.outcome === 'skipped').length, duration: Date.now() - run.began,
                    coverageAvailable: tested.available, failedBatches: tested.failedBatches };
            } catch (error) {
                // Stop owned work before draining it below.
                controller.abort(error); throw error;
            } finally {
                run.finishPhase();
                if (state.analyzing) {await Promise.allSettled([state.analyzing]);}
                try {await state.sessions?.dispose();} finally {await outputLease.dispose();}
            }
        } catch (error) {controller.abort(error); throw error;}
        finally {
            run.finishPhase();
            // A cancelled run still persists what it committed, including a delta its own aborted save left pending,
            // without waiting for another window's lock; disposal waits for this flush, bounded.
            void this.flushSaves();
        }
    }

    /** Consume the changes and declaration shapes a completed run executed, and close a finished baseline. The versions the run
     * was attributed to become the settled versions, except files with changes still pending. */
    private finishRun(run: RunContext, selected: SelectedRun, before: ReadonlyMap<string, string>): void {
        if (!consumesChanges({ manual: !!run.manual, scoped: !!run.scope, baseline: !!run.baseline })) {return;}
        this.shapes = selected.currentShapes;
        if (!run.baseline || this.groups.every(group => run.baseline!.completed.has(group.id))) {
            this.initialized = true; this.baseline = undefined;
            for (const file of run.changes) {this.pendingChanges.delete(file);}
            this.pendingRevision++;
            const settled = new Map(before), untracked = new Map(run.untracked);
            for (const file of this.pendingChanges) {settled.delete(file); untracked.delete(file);}
            this.settled = settled; this.settledUntracked = untracked; this.settledRevision++;
        }
    }

    /** A resumed baseline's changes: every file whose version differs from the checkpoint's, in either direction, including the
     * untracked files a restart compares (see engine/untracked), whose changes select as in a session. Kept pending, so a cancelled
     * run still reruns them. A complete file whose trace no longer matches its own inputs is learned again as well. */
    private changedSinceCheckpoint(baseline: Baseline, changes: readonly string[], untracked: ReadonlyMap<string, string>): readonly string[] {
        const changed = new Set(changes), saved = baseline.inputs, hashes = this.hashes, outdated: string[] = [];
        for (const [file, hash] of saved) {if (hashes.get(file) !== hash) {changed.add(file);}}
        for (const [file, hash] of hashes) {if (saved.get(file) !== hash) {changed.add(file);}}
        for (const file of changedVersions(baseline.untracked, untracked)) {changed.add(file);}
        for (const id of baseline.completed) {
            const trace = this.coverage.traces.get(id);
            if (trace && traceIsCurrent(trace, hashes)) {continue;}
            outdated.push(id);
            for (const [file, hash] of Object.entries(trace?.inputs ?? {})) {if (sourceVersion(hashes, file) !== hash) {changed.add(file);}}
        }
        if (outdated.length) {baseline.invalidate(outdated);}
        this.addPending(changed);
        if (changed.size > changes.length) {this.options.events.output(`Found ${changed.size - changes.length} file${changed.size - changes.length === 1 ? '' : 's'} changed since the coverage was saved.\n`);}
        return [...changed];
    }

    /** Stamp the watched files outside every project, including changes reported there since the last structural refresh, and add
     * the restored package assets. Taken before the build, like the source versions a run is attributed to. */
    private async untrackedVersions(run: RunContext): Promise<ReadonlyMap<string, string>> {
        const outside = (file: string): boolean => this.index.isOutsideProjects(file) && (!isToolingFile(file) || isConfigurationFile(file));
        for (const file of run.changes) {if (outside(file)) {this.unowned.add(file);}}
        return new Map([...await fileStamps([...this.unowned].filter(outside), run.signal), ...this.assets]);
    }

    /** Coverage learned with another SDK or other evaluation tools cannot be trusted: a resumed baseline learns every file again. */
    private adoptToolchain(baseline: Baseline | undefined): void {
        if (this.toolchain === undefined) {return;}
        if (baseline?.resumed && this.learnedToolchain !== this.toolchain && baseline.completed.size) {
            this.options.events.output('The .NET SDK or evaluation tools changed since the coverage was saved; learning every test file again.\n');
            baseline.invalidate([...baseline.completed]);
        }
        this.learnedToolchain = this.toolchain;
    }

    /** Learn affected baseline files again, then announce the selection. */
    private async adoptSelection(run: RunContext, selected: SelectedRun): Promise<void> {
        if (selected.checkpoint) {run.baseline?.invalidate(selected.checkpoint.invalidated); run.baseline?.rebase(selected.checkpoint.shapes, selected.checkpoint.inputs, run.untracked);}
        this.options.events.selected(selected.selection); await this.publishCoverage(run.signal);
    }

    applyStructure(next: StructureState, unsupportedReport: string): void {
        this.projectSnapshots = next.projectSnapshots; this.buildGraph = next.buildGraph; this.projects = next.projects;
        this.index = next.index; this.structureDirty = next.structureDirty; this.unsupportedReport = unsupportedReport;
        this.sources.setFiles(next.sourceFiles, next.analysisFiles);
        this.unowned = new Set(next.unowned); this.assets = next.assets; this.toolchain = next.toolchain;
    }

    forgetRestores(): void { this.sdk.forget(); this.restored.clear(); }
    recordRestored(keys: readonly string[]): void { for (const key of keys) {this.restored.add(key);} }

    reportResult(group: TestFile, result: TestResult, test?: DiscoveredTest): boolean {
        const changed = this.runtime.observe(group, result, test);
        this.lastOutcomes.record(group.id, result);
        for (const observer of this.resultObservers) {observer(group, result);}
        this.options.events.result(group, result);
        return changed;
    }

    reportErrored(group: TestFile, result: TestResult): void {
        this.lastOutcomes.record(group.id, result); this.options.events.result(group, result);
    }

    watchResults(observer: (group: TestFile, result: TestResult) => void): () => void {
        this.resultObservers.add(observer);
        return () => {this.resultObservers.delete(observer);};
    }

    settleCompleted(groups: readonly TestFile[], reported: ReadonlySet<string>, targetReported?: ReadonlySet<string>): boolean {
        for (const group of groups) {this.lastOutcomes.settle(group.id, reported);}
        // Containers are retired only once every file of the target has completed.
        return this.runtime.retireUnreported(groups, reported, targetReported);
    }

    commitCoverage(trace: Trace, liveIds: ReadonlySet<string>, signal?: AbortSignal): Promise<void> { return this.coverage.replaceAsync([trace], liveIds, signal); }
    markHistorical(groupIds: ReadonlySet<string>): void { this.coverage.markHistorical(groupIds); }
    pruneCoverage(liveIds: ReadonlySet<string>): void { this.coverage.replace([], liveIds); }

    /** Without collection no narrowing information was learned: previous coverage and its freshness state are kept. */
    retainCoverage(groups: readonly TestFile[], liveIds: ReadonlySet<string>): void {
        for (const group of groups) {
            if (this.coverage.traces.has(group.id)) {this.coverage.invalidate(new Set([group.id]), false);}
            else {this.coverage.replace([{ groupId: group.id, dependencies: group.file ? [group.file] : [], coverage: [], reliable: false, timestamp: Date.now(), inputs: {} }], liveIds);}
        }
    }

    applyAnalysis(next: AnalysisState): void {
        this.analyses = next.analyses; this.analyzedHashes = next.analyzedHashes; this.analysisContext = next.analysisContext;
        this.aliasStamp = next.aliasStamp; this.excludedAliases = next.excludedAliases;
    }

    /** Resolve configuration, the baseline generation and accumulated changes. */
    private async startRun(batch: ChangeBatch, controller: AbortController, manual: ManualSelection | undefined, manualOperation: boolean, coverage?: boolean): Promise<RunContext> {
        const signal = controller.signal;
        const began = Date.now(), events = this.options.events, topology = this.topology;
        const configured = this.options.configuration();
        if (manual?.debug && !this.options.events.debug) {throw new Error('Debugging is not available.');}
        // A debugged host may sit at a breakpoint far longer than the run timeout.
        // A configuration override applies to this run only: evaluation, preparation and
        // build identities include the configuration, so nothing cached for another one is reused.
        const override = manual?.configuration?.trim() || undefined;
        const config: EngineConfiguration = manual?.debug ? { ...configured, coverage: false, timeout: 7 * 24 * 60 * 60 * 1000, maxParallelTestFiles: 1, ...override ? { configuration: override } : {} }
            : { ...configured, coverage: (manual?.discoverOnly ? false : manual?.coverage) ?? coverage ?? configured.coverage, ...override ? { configuration: override } : {} };
        if (override && override !== configured.configuration) {events.output(`Testy build configuration for this run: ${override} (testy.buildConfiguration is ${configured.configuration}).\n`);}
        const projectLimit = resolveConcurrency(config.maxParallelProjects), testLimit = resolveTestFileConcurrency(config.maxParallelTestFiles);
        events.output(`Testy concurrency: projects=${projectLimit}, test files=${testLimit}.\n`);
        let phaseName: string | undefined, phaseBegan = began;
        const finishPhase = (): void => {
            if (phaseName) {events.output(`Testy timing: ${phaseName} ${Date.now() - phaseBegan}ms\n`); phaseName = undefined;}
        };
        const phase = (kind: RunPhase['kind']): void => {finishPhase(); phaseName = phaseTimingNames[kind]; phaseBegan = Date.now(); events.phase({ kind });};
        const reserved = ['--server', '--client-port', '--client-host', '--list-tests', '--filter-uid', '--filter', '--treenode-filter', '--results-directory', '--ignore-exit-code', '--help', '--info'];
        if (config.testArguments.some(argument => reserved.some(option => argument === option || argument.startsWith(`${option}=`)))) {
            throw new EnvironmentError('configuration', 'testy.testArguments contains an option reserved for test discovery, selection, or communication. Remove runner/filter options from that setting.');
        }
        const settings = settingsIdentity(configured, this.roots), identity = await coverageIdentity(configured, this.roots, this.toolIdentities, signal);
        // Coverage learned under other settings or tools cannot narrow selections; a resumed baseline already is the baseline that a
        // full request (such as startup's) would establish, unless the user asked for everything again.
        const relearn = !!this.learned && this.learned.identity !== identity;
        const requestedFull = relearn || (batch.full && !(this.baseline?.resumed && !manualOperation));
        const full = requestedFull || !this.initialized || !!this.baseline;
        // A relearned baseline needs a generation of its own; the request's serves while no baseline already uses it, so a retry resumes.
        const requestedGeneration = relearn && batch.generation === this.baseline?.generation ? undefined : batch.generation;
        const generation = requestedFull ? requestedGeneration ?? randomUUID() : this.baseline?.generation ?? randomUUID();
        const newBaseline = full && this.baseline?.generation !== generation;
        if (newBaseline) {
            if (relearn) {events.output('Testy settings or tools changed since the coverage was learned; establishing a new baseline.\n');}
            this.baseline = new Baseline(generation, this.shapes); this.learned = { settings, identity };
        }
        const baseline = full ? this.baseline : undefined;
        // Manual runs may use another configuration or collection; their traces are learned under that run's own identity.
        const runIdentity = settingsIdentity(config, this.roots) === settings ? identity : await coverageIdentity(config, this.roots, this.toolIdentities, signal);
        const rootSnapshot = this.roots;
        const processOptions: ProcessOptions = { cwd: rootSnapshot[0] ?? this.options.storage, signal, output: events.output,
            timeoutMs: config.timeout, dotnetHost: config.dotnet, cleanupDescendants: false };
        // Excluded files (build output, editor state such as .vscode) never trigger runs, whoever reports them.
        const excludes = [...defaultExcludes, ...config.excludes];
        const requested = (await normalizePathsAsync(batch.files, signal)).filter(file => !isExcluded(file, excludes, rootSnapshot));
        // Watched changes are already marked dirty, and refresh always rereads dirty files.
        const sweep = needsSourceSweep({ full, structureDirty: this.structureDirty, manual: !!manual, trigger: configured.trigger });
        const sourceChanges = await this.sources.refresh(sweep ? this.sources.files : requested, signal);
        this.addPending([...requested, ...sourceChanges]);
        const changes = [...this.pendingChanges];
        const structural = !!manual || this.structureDirty || newBaseline || changes.some(file => isStructuralChange(file, this.index, this.hashes));
        return { controller, signal, began, topology, configured, config, projectLimit, testLimit, manual, manualOperation, full, newBaseline, baseline,
            discoverAll: newBaseline || !this.inventoried, identity: runIdentity, rootSnapshot, processOptions, changes, previousIndex: this.index, structural, phase, finishPhase };
    }

    setInputs(files: Iterable<string>): void {
        const inputs = new Set(files);
        if (inputs.size === this.inputs.length && this.inputs.every(file => inputs.has(file))) {return;}
        this.inputs = [...inputs]; this.inputDirectories = [...new Set(this.inputs.map(file => path.dirname(file)))]; this.inputTopology++;
        // Watch evaluated inputs before building/discovering: either operation
        // can fail, and fixing an external input must still trigger recovery.
        this.options.events.inputsChanged?.();
    }

    async reconcileGroups(next: readonly TestFile[], baseline?: Baseline): Promise<Set<string>> {
        const oldGroups = new Map(this.groups.map(group => [group.id, group]));
        const identitiesChanged = new Set(next.filter(group => {
            const previous = oldGroups.get(group.id);
            return previous && previous.tests.map(test => test.id).sort().join('\0') !== group.tests.map(test => test.id).sort().join('\0');
        }).map(group => group.id));
        baseline?.invalidate(identitiesChanged);
        this.coverage.invalidate(identitiesChanged); this.groups = next;
        this.runtime.reconcile(next, identitiesChanged);
        // Rediscovered files keep the outcomes of tests they still have, their runtime rows included.
        for (const group of next) {if (identitiesChanged.has(group.id)) {this.lastOutcomes.settle(group.id, new Set(this.knownTests(group).map(test => test.id)));}}
        const groupIds = new Set(next.map(group => group.id));
        baseline?.invalidate([...baseline.completed, ...baseline.runtimeResults.keys()].filter(id => !groupIds.has(id)));
        const liveIds = new Set([...next.map(group => group.id), ...next.map(projectCoverageId)]);
        this.lastOutcomes.retain(new Set(this.displayGroups.map(group => group.id)));
        this.coverage.replace([], liveIds); await this.options.events.discovered(this.displayGroups);
        return liveIds;
    }

    async publishCoverage(signal?: AbortSignal): Promise<void> {
        for (;;) {
            const hashes = this.hashes;
            // The tracker knows which files changed since the versions the store last applied.
            this.coverage.applyHashes(hashes, applied => this.sources.changedSince(applied)); await this.coverage.summarizeAsync(hashes, signal);
            if (hashes === this.hashes) {break;}
        }
        this.options.events.coverage();
    }

    /** A cancelled caller stops waiting; whatever its save did not write stays pending for the next one. */
    save(signal?: AbortSignal): Promise<void> {
        if (this.saveTimer) {clearTimeout(this.saveTimer); this.saveTimer = undefined;}
        const saving = this.saves.run(() => this.persist(signal ? AbortSignal.any([signal, this.saveController.signal]) : this.saveController.signal));
        if (!signal) {return saving;}
        void saving.catch(() => undefined);
        return untilAborted(saving, signal);
    }

    /** Write everything not yet saved now, under the engine-lifetime signal: a scheduled save, and any delta a save
     * aborted with its run (cancellation, shutdown, another window's lock) left pending. Resolves once every save requested
     * so far has settled. An empty delta takes no lock. */
    private flushSaves(): Promise<void> {
        return this.save().catch(() => undefined);
    }

    scheduleSave(): void {
        this.saveTimer ??= setTimeout(() => {this.saveTimer = undefined; void this.saves.run(() => this.persist(this.saveController.signal)).catch(() => undefined);}, this.saveDelay);
    }

    /** One locked write of everything changed since the previous save; a failed write is retried by the next. */
    private async persist(signal?: AbortSignal): Promise<void> {
        const coverage = await this.coverage.takeDeltaAsync(signal);
        // Taken with the delta, without yielding: every file the checkpoint completes has its trace in this delta or a saved one.
        const state = this.checkpointState();
        const delta = { ...coverage, outcomes: this.lastOutcomes.take(), ...state === this.savedCheckpoint ? {} : { checkpoint: this.checkpoint() } };
        try {await this.cache.save(delta, signal); this.savedCheckpoint = state;}
        catch (error) {this.coverage.retryDelta(delta); this.lastOutcomes.retry(delta.outcomes); signal?.throwIfAborted(); this.options.events.output(`Coverage could not be saved; current test results remain available. ${String(error)}\n`);}
    }

    /** Changes whenever the checkpoint would. */
    private checkpointState(): string {
        const owner = this.baseline ? `baseline:${this.baseline.generation}:${this.baseline.revision}` : this.initialized ? `settled:${this.settledRevision}` : 'none';
        return `${this.learned?.identity ?? ''}:${owner}:${this.learnedToolchain ?? ''}:${this.pendingRevision}`;
    }

    /** What saved coverage can be trusted for after a restart (see TestEngine.restore): the files a baseline in progress has learned
     * and the versions and declaration shapes it learned them against, or, once complete, every file and the settled versions;
     * with either, the toolchain they were learned with and the changes no run has consumed yet. */
    private checkpoint(): SavedCheckpoint | null {
        if (!this.learned) {return null;}
        const common = { identity: this.learned.identity, pending: [...this.pendingChanges], ...this.learnedToolchain === undefined ? {} : { toolchain: this.learnedToolchain } };
        if (this.baseline) {return { ...common, completed: [...this.baseline.completed], versions: this.baseline.inputs, shapes: this.baseline.shapes, untracked: this.baseline.untracked };}
        return this.initialized ? { ...common, completed: this.groups.map(group => group.id), versions: this.settled, shapes: this.shapes, untracked: this.settledUntracked } : null;
    }
}
