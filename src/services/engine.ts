import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { EngineConfiguration, Project, TestFile, TestResult } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection } from '../core/selection';
import { isConfigurationFile, normalizePath, normalizePathsAsync } from '../core/paths';
import { ProcessOptions, Shutdown } from './process';
import { projectCoverageId, RunnerSession } from './runner';
import { disposeAnalyzerServers, SourceShape } from './analysis';
import { SourceTracker } from './sources';
import { RuntimeInventory } from './runtimeInventory';
import { CoverageCache } from './cache';
import { discoveredTest } from './mtp';
import { claimRunOutputs, reclaimRunOutputs } from './runOutputs';
import { PreparedOutputCache } from './preparedOutputCache';
import { ProjectEvaluationCache } from './projectEvaluationCache';
import { resolveConcurrency, resolveTestFileConcurrency } from '../core/concurrency';
import { EnvironmentError, isAbortError } from '../core/errors';
import type { EngineHost } from './engine/host';
import { SdkChecks } from './engine/sdk';
import { planBuild } from './engine/plan';
import { refreshStructure } from './engine/structure';
import { build } from './engine/build';
import { prepareTests } from './engine/prepare';
import { selectRun } from './engine/select';
import { executeSelection } from './engine/execute';
import { Baseline, EngineEvents, EngineOptions, ManualSelection, phaseTimingNames, RunContext, RunPhase, RunScope, RunSummary } from './engine/types';
export { selectManual } from './engine/selectManual';
export type { EngineEvents, EngineOptions, ManualSelection, RunPhase, RunScope, RunSummary };

export type { EngineConfiguration };

/** Members that are not private are shared with the run stages in ./engine through EngineHost. */
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
    private readonly cache: CoverageCache;
    readonly identity = randomUUID();
    readonly preparedOutputs: PreparedOutputCache;
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

    constructor(readonly options: EngineOptions) {
        this.roots = options.roots.map(normalizePath);
        this.cache = new CoverageCache(options.storage, options.events.output);
        this.preparedOutputs = new PreparedOutputCache(options.storage, this.identity, { persist: true, log: options.events.output });
        this.projectEvaluations = new ProjectEvaluationCache(options.storage, {}, options.events.output);
    }

    get hashes(): ReadonlyMap<string, string> { return this.sources.hashes; }
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

    /** Normal event handling only marks versions; it performs no source-tree I/O. */
    async markChanged(files?: readonly string[]): Promise<void> {
        if (!files) {files = await this.sources.refresh(this.sources.files);}
        this.sources.mark(files);
        const selected = this.select(files, true);
        this.coverage.markStale(new Set([...selected.groups.map(group => group.id), ...this.coverage.dependentGroups(files)]));
        await this.publishCoverage();
    }

    async restore(signal?: AbortSignal): Promise<void> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        await reclaimRunOutputs(path.join(this.options.storage, 'runs'), signal, this.options.events.output);
        await reclaimRunOutputs(path.join(this.options.storage, 'prepared'), signal, this.options.events.output);
        try {await this.cache.restore(this.coverage, signal);}
        catch (error) {
            signal?.throwIfAborted();
            if (isAbortError(error)) {throw error;}
            this.options.events.output(`Coverage cache unavailable; starting a fresh baseline. ${String(error)}\n`);
        }
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

    /** Forget learned coverage, saved evaluations, analyses and idle prepared outputs.
     * The next run establishes a fresh baseline. Call only while no run is active. */
    async reset(signal?: AbortSignal): Promise<void> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        if (this.operations.size) {throw new Error('Testy cannot reset while a run is active.');}
        this.coverage.replace([], new Set());
        await this.projectEvaluations.clear(signal);
        await this.preparedOutputs.evictIdle(signal);
        this.initialized = false; this.baseline = undefined; this.structureDirty = true;
        this.shapes = new Map(); this.analyses = new Map(); this.analyzedHashes = new Map();
        this.analysisContext = undefined; this.aliasStamp = undefined;
        await this.sdk.stop();
        this.restored.clear(); this.toolIdentities.clear();
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
                await this.sdk.stop();
                await disposeAnalyzerServers();
                await this.projectEvaluations.dispose();
                await this.preparedOutputs.dispose();
            })();
        }
        return this.disposal;
    }

    private async runBatch(batch: ChangeBatch, controller: AbortController, manual?: ManualSelection, manualOperation = false, scope?: RunScope, coverage?: boolean): Promise<RunSummary> {
        const run = { ...await this.startRun(batch, controller, manual, manualOperation, coverage), scope: manual ? undefined : scope };
        const state: { sessions?: RunnerSession; analyzing?: Promise<ReadonlyMap<string, string | null>> } = {};
        try {
            if (run.structural) {
                run.phase('preparingProjects');
                await refreshStructure(this, run);
            }
            const beforeBuild = this.hashes;
            await this.publishCoverage(run.signal);
            const plan = planBuild(this, run);
            const outputLease = await claimRunOutputs(path.join(this.options.storage, 'runs'), this.identity, run.signal, this.options.events.output);
            try {
                run.phase('building');
                const built = await build(this, run, plan, outputLease, beforeBuild);
                run.phase('preparingTests');
                const prepared = await prepareTests(this, run, plan, built, outputLease, state);
                const selected = await selectRun(this, run, built, prepared);
                run.phase('testing');
                const tested = await executeSelection(this, run, built, prepared, selected);
                run.signal.throwIfAborted();
                // A scoped run did not execute every affected file: keep its
                // changes pending, and their shapes unconsumed, for a full run.
                if (!manual && !(run.scope && !run.baseline)) {
                    this.shapes = selected.currentShapes;
                    if (!run.baseline || this.groups.every(group => run.baseline!.completed.has(group.id))) {
                        this.initialized = true; this.baseline = undefined;
                        for (const file of run.changes) {this.pendingChanges.delete(file);}
                    }
                }
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
        finally {run.finishPhase();}
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
        const full = batch.full || !this.initialized || !!this.baseline;
        const generation = batch.generation ?? (batch.full ? randomUUID() : this.baseline?.generation ?? randomUUID());
        const newBaseline = full && this.baseline?.generation !== generation;
        if (newBaseline) {this.baseline = { generation, completed: new Set(), runtimeResults: new Map(), shapes: this.shapes, inputs: new Map() };}
        const baseline = full ? this.baseline : undefined;
        const rootSnapshot = this.roots;
        const processOptions: ProcessOptions = { cwd: rootSnapshot[0] ?? this.options.storage, signal, output: events.output,
            timeoutMs: config.timeout, dotnetHost: config.dotnet, cleanupDescendants: false };
        const sourceChanges = await this.sources.refresh(this.sources.files, signal);
        for (const file of [...await normalizePathsAsync(batch.files, signal), ...sourceChanges]) {this.pendingChanges.add(file);}
        const changes = [...this.pendingChanges];
        const structural = !!manual || this.structureDirty || newBaseline || changes.some(file => isConfigurationFile(file) || !this.index.hasSource(file) || !this.hashes.has(file));
        return { controller, signal, began, topology, configured, config, projectLimit, testLimit, manual, manualOperation, full, newBaseline, baseline,
            rootSnapshot, processOptions, changes, previousIndex: this.index, structural, phase, finishPhase };
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
        for (const id of identitiesChanged) {baseline?.completed.delete(id); baseline?.runtimeResults.delete(id);}
        this.coverage.invalidate(identitiesChanged); this.groups = next;
        this.runtime.reconcile(next, identitiesChanged);
        const groupIds = new Set(next.map(group => group.id));
        for (const id of baseline?.completed ?? []) {if (!groupIds.has(id)) {baseline?.completed.delete(id);}}
        for (const id of baseline?.runtimeResults.keys() ?? []) {if (!groupIds.has(id)) {baseline?.runtimeResults.delete(id);}}
        const liveIds = new Set([...next.map(group => group.id), ...next.map(projectCoverageId)]);
        this.coverage.replace([], liveIds); await this.options.events.discovered(this.displayGroups);
        return liveIds;
    }

    async publishCoverage(signal?: AbortSignal): Promise<void> {
        for (;;) {
            const hashes = this.hashes;
            await this.coverage.summarizeAsync(hashes, signal);
            if (hashes === this.hashes) {break;}
        }
        this.options.events.coverage();
    }

    async save(signal?: AbortSignal): Promise<void> {
        const delta = await this.coverage.takeDeltaAsync(signal);
        try {await this.cache.save(delta, signal);}
        catch (error) {this.coverage.retryDelta(delta);signal?.throwIfAborted(); this.options.events.output(`Coverage could not be saved; current test results remain available. ${String(error)}\n`);}
    }
}
