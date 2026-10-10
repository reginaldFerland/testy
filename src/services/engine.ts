import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { isTestTarget, Project, TestFile, TestResult } from '../core/model';
import { environmentIdentity } from '../core/environment';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection, uniformCauses } from '../core/selection';
import { contentHash, defaultExcludes, isConfigurationFile, isExcluded, normalizePath, sourceVersion, testTargetKey } from '../core/paths';
import { buildOrder, buildRoots, buildWaves, buildSnapshotTargets, buildProjects, mergeProjects, evaluateProjects, restoreProjects, filterEntryPoints, findProjects, refreshProjectSnapshotBatches, sdkContextGroups, sdkConfigurationFiles } from './projects';
import { Cancelled, ProcessOptions, requireSuccess, runProcess } from './process';
import { FileRun, projectCoverageId, RunnerOptions, RunnerSession } from './runner';
import { disposeAnalyzerServers, resolveShapes, sourceAnalysisBatch, SourceShape } from './analysis';
import { sourceAnalysisContext } from './analysisContext';
import { SourceTracker } from './sources';
import { CoverageCache } from './cache';
import { discoveredTest } from './mtp';
import { installCoverageTool } from './coverageTool';
import { claimRunOutputs, reclaimRunOutputs, RunOutputLease } from './runOutputs';
import { copyOutput } from './output';
import { PreparedOutputCache } from './preparedOutputCache';
import { evaluationToolContext, ProjectEvaluationCache } from './projectEvaluationCache';
import { mapConcurrent, mapConcurrentByKey, resolveConcurrency, resolveTestFileConcurrency, Semaphore, SerialQueue } from '../core/concurrency';

export interface EngineConfiguration {
    readonly dotnet: string;
    readonly configuration: string;
    readonly mode: 'affected' | 'all';
    readonly coverage: boolean;
    readonly excludes: readonly string[];
    readonly testArguments: readonly string[];
    readonly timeout: number;
    readonly coverageTool?: string;
    readonly maxParallelProjects?: number;
    readonly maxParallelTestFiles?: number;
    /** Optional .sln, .slnx or .slnf limiting the workspace's entry-point projects. */
    readonly solution?: string;
    /** Entry-point project globs; exclusions win over inclusions. */
    readonly projects?: { readonly include: readonly string[]; readonly exclude: readonly string[] };
}
/** Progress of the current run stage; the extension formats and localizes it. */
export interface RunPhase {
    readonly kind: 'preparingProjects' | 'building' | 'preparingTests' | 'testing' | 'settingUpCoverage';
    readonly completed?: number;
    readonly total?: number;
    readonly active?: number;
    /** Baseline progress: test files learned so far, out of `learnedTotal`. */
    readonly learned?: number;
    readonly learnedTotal?: number;
}
/** English names of the run stages in `Testy timing:` output lines. */
const phaseTimingNames: Readonly<Record<RunPhase['kind'], string>> = {
    preparingProjects: 'Preparing projects', building: 'Building', preparingTests: 'Preparing tests', testing: 'Testing', settingUpCoverage: 'Setting up coverage'
};
export interface EngineEvents {
    readonly output: (text: string) => void;
    readonly phase: (phase: RunPhase) => void;
    readonly inputsChanged?: () => void;
    readonly discovered: (groups: readonly TestFile[]) => void | Promise<void>;
    readonly selected: (selection: Selection) => void;
    readonly result: (group: TestFile, result: TestResult) => void;
    readonly started: (group: TestFile, id: string) => void;
    readonly coverage: () => void;
    readonly invalidated: (files: readonly string[]) => void;
    readonly prepared?: (project: string) => void;
    /** Attach a debugger to a waiting test host; required for debug runs. */
    readonly debug?: (processId: number) => Promise<void>;
}
export interface EngineOptions {
    readonly roots: readonly string[];
    readonly storage: string;
    readonly tools: string;
    readonly analyzer: string;
    readonly configuration: () => EngineConfiguration;
    readonly events: EngineEvents;
}
export interface RunSummary {
    readonly files: number;
    readonly tests: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly duration: number;
    readonly coverageAvailable: boolean;
    /** Batches that could not run; their tests are reported as errored. */
    readonly failedBatches?: number;
}
export interface ManualSelection {
    readonly groups: ReadonlySet<string>;
    readonly all?: boolean;
    readonly projects?: ReadonlySet<string>;
    readonly exclude?: Omit<ManualSelection, 'exclude' | 'coverage'>;
    readonly tests?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly coverage?: boolean;
    /** Run without collection, one host at a time, each waiting for a debugger. */
    readonly debug?: boolean;
    /** Build and discover only; no tests run. */
    readonly discoverOnly?: boolean;
    /** MSBuild configuration for this run only, instead of `EngineConfiguration.configuration`. */
    readonly configuration?: string;
}
/** Test items an automatic run may execute, in the form of a manual selection. */
export type RunScope = Omit<ManualSelection, 'coverage' | 'debug' | 'discoverOnly' | 'configuration'>;

export function selectManual(groups: readonly TestFile[], manual: ManualSelection, known: (group: TestFile) => readonly ReturnType<typeof discoveredTest>[] = group => group.tests): readonly TestFile[] {
    const matches = (scope: ManualSelection, group: TestFile): boolean => !!scope.all || !!scope.projects?.has(group.project) || scope.groups.has(group.id);
    const projectExclusions = new Map<string, Set<string>>();
    const unmappedExclusions = new Map<string, Set<string>>();
    if (manual.exclude) {for (const group of groups) {
        const excluded = manual.exclude;
        if (!matches(excluded, group)) {continue;}
        const key = testTargetKey(group.project, group.framework), ids = projectExclusions.get(key) ?? new Set<string>();
        const tests = excluded.all || excluded.projects?.has(group.project) || !excluded.tests?.has(group.id)
            ? known(group).map(test => test.id) : excluded.tests.get(group.id)!;
        for (const id of tests) {ids.add(id);} projectExclusions.set(key, ids);
        if (group.runtimeOnly) {unmappedExclusions.set(key, new Set(tests));}
    }}
    // Project/container runs already select the discovered parents. Repeating a
    // synthetic runtime container would execute that project a second time.
    return groups.filter(group => matches(manual, group) && (!group.runtimeOnly || (!manual.all && !manual.projects?.has(group.project)))).map(group => {
        const entire = manual.all || manual.projects?.has(group.project) || !manual.tests?.has(group.id);
        const requested = manual.tests?.get(group.id), excluded = manual.exclude;
        const excludesGroup = excluded && matches(excluded, group);
        const excludedTests = excluded?.tests?.get(group.id);
        const excludesEntire = excludesGroup && (excluded.all || excluded.projects?.has(group.project) || !excludedTests);
        const available = known(group);
        const key = testTargetKey(group.project, group.framework);
        return { ...group, excludedTestIds: group.runtimeOnly ? [...projectExclusions.get(key) ?? []]
            : [...(excludesGroup ? excludedTests ?? [] : []), ...unmappedExclusions.get(key) ?? []],
            tests: available.filter(test => !excludesEntire && (entire || requested?.has(test.id)) && (!excludesGroup || !excludedTests?.has(test.id))) };
    }).filter(group => group.tests.length);
}

/** Resolved state shared by the phases of one run. */
interface RunContext {
    readonly controller: AbortController;
    readonly signal: AbortSignal;
    readonly began: number;
    readonly topology: number;
    readonly configured: EngineConfiguration;
    readonly config: EngineConfiguration;
    readonly projectLimit: number;
    readonly testLimit: number;
    readonly manual?: ManualSelection;
    readonly manualOperation: boolean;
    /** Automatic runs limited to the items of a continuous run. */
    readonly scope?: RunScope;
    readonly full: boolean;
    readonly newBaseline: boolean;
    readonly baseline?: Baseline;
    readonly rootSnapshot: readonly string[];
    readonly processOptions: ProcessOptions;
    readonly changes: readonly string[];
    readonly previousIndex: ProjectIndex;
    readonly structural: boolean;
    phase(kind: RunPhase['kind']): void;
    finishPhase(): void;
}
interface BuildPlan {
    readonly anticipated: Selection;
    readonly closure: readonly Project[];
    readonly builds: readonly Project[];
    readonly testBuilds: readonly Project[];
    readonly sharedOutputs: ReadonlySet<string>;
}
interface BuildResult {
    readonly revision: number;
    readonly obsoleteBuild: boolean;
    /** Source versions the build and its tests are attributed to. */
    readonly before: ReadonlyMap<string, string>;
    readonly snapshots: ReadonlyMap<string, string>;
    readonly sdkByFile: ReadonlyMap<string, string>;
}
interface PreparedTests {
    readonly coverageTool?: string;
    sessions: RunnerSession;
    runtimeTreeChanged: boolean;
    liveIds: Set<string>;
    currentShapes: ReadonlyMap<string, string | null>;
}
interface SelectedRun { readonly selection: Selection; readonly currentShapes: ReadonlyMap<string, string | null>; }
interface TestedRun { readonly results: readonly TestResult[]; readonly executedFiles: ReadonlySet<string>; readonly available: boolean; readonly failedBatches: number; }

/** Wait for shared work without letting one waiter's cancellation reject it for others. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {return work;}
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(new Cancelled());
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

interface Baseline {
    readonly generation: string | number;
    readonly completed: Set<string>;
    readonly runtimeResults: Map<string, ReadonlySet<string>>;
    shapes: ReadonlyMap<string, string | null>;
    inputs: ReadonlyMap<string, string>;
}

export class TestEngine {
    readonly coverage = new CoverageStore();
    readonly sources = new SourceTracker();
    projects: readonly Project[] = [];
    groups: readonly TestFile[] = [];
    private buildGraph: readonly Project[] = [];
    private roots: readonly string[];
    private index = new ProjectIndex([]);
    private initialized = false;
    private structureDirty = true;
    private topology = 0;
    private baseline: Baseline | undefined;
    private shapes: ReadonlyMap<string, string | null> = new Map();
    private analyses: ReadonlyMap<string, SourceShape | null> = new Map();
    private analyzedHashes: ReadonlyMap<string, string> = new Map();
    private analysisContext: string | undefined;
    private aliasStamp: string | undefined;
    private excludedAliases: readonly string[] = [];
    private readonly sdkContexts = new Set<string>();
    private readonly sdkChecks = new Map<string, Promise<void>>();
    private readonly restored = new Set<string>();
    private readonly runtime = new Map<string, Map<string, ReturnType<typeof discoveredTest>>>();
    private readonly runtimeGroups = new Map<string, TestFile>();
    private readonly knownCache = new Map<string, { discovered: TestFile['tests']; tests: TestFile['tests'] }>();
    private readonly discoveredIds = new Map<string, ReadonlySet<string>>();
    private readonly cache: CoverageCache;
    private readonly identity = randomUUID();
    private readonly preparedOutputs: PreparedOutputCache;
    private readonly operations = new Map<AbortController, Promise<RunSummary>>();
    private disposed = false;
    private disposal?: Promise<void>;
    private readonly pendingChanges = new Set<string>();
    private projectSnapshots: ReadonlyMap<string, readonly Project[]> = new Map();
    private readonly projectEvaluations: ProjectEvaluationCache;
    private inputTopology = 0;
    private inputs: readonly string[] = [];
    private inputDirectories: readonly string[] = [];
    /** Tool hashes survive across runs; their keys include a metadata stamp. */
    private readonly toolIdentities = new Map<string, Promise<string>>();
    private unsupportedReport = '';
    private readonly resultObservers = new Set<(group: TestFile, result: TestResult) => void>();

    constructor(private readonly options: EngineOptions) {
        this.roots = options.roots.map(normalizePath);
        this.cache = new CoverageCache(options.storage, options.events.output);
        this.preparedOutputs = new PreparedOutputCache(options.storage, this.identity, { persist: true, log: options.events.output });
        this.projectEvaluations = new ProjectEvaluationCache(options.storage, {}, options.events.output);
    }

    get hashes(): ReadonlyMap<string, string> { return this.sources.hashes; }
    get inputVersion(): number { return this.inputTopology; }
    get knownFiles(): readonly string[] { return this.inputs; }
    get directories(): readonly string[] { return this.inputDirectories; }
    get displayGroups(): readonly TestFile[] { return this.runtimeGroups.size ? [...this.groups, ...this.runtimeGroups.values()] : this.groups; }
    get baselineProgress(): { completed: number; total: number } | undefined {
        return this.baseline ? { completed: this.baseline.completed.size, total: this.groups.length } : undefined;
    }

    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[] {
        const runtime = this.runtime.get(group.id);
        if (!runtime?.size) {return group.tests;}
        const cached = this.knownCache.get(group.id);
        if (cached?.discovered === group.tests) {return cached.tests;}
        const tests = [...new Map([...group.tests, ...runtime.values()].map(test => [test.id, test])).values()];
        this.knownCache.set(group.id, { discovered: group.tests, tests }); return tests;
    }

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
            if ((error as Error)?.name === 'AbortError') {throw error;}
            this.options.events.output(`Coverage cache unavailable; starting a fresh baseline. ${String(error)}\n`);
        }
    }

    async run(batch: ChangeBatch, signal: AbortSignal, manual?: ManualSelection, manualOperation = false, scope?: RunScope): Promise<RunSummary> {
        if (this.disposed) {throw new Error('The test engine has been disposed.');}
        signal.throwIfAborted();
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        const operation = this.runBatch(batch, controller, manual, manualOperation, scope);
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
        this.sdkContexts.clear(); this.restored.clear(); this.toolIdentities.clear();
        await this.publishCoverage(signal); await this.save(signal);
        this.options.events.output('Testy caches were reset; the next run establishes a new baseline.\n');
    }

    /** Stop admitting work, drain owned processes, then remove retained preparations. */
    dispose(): Promise<void> {
        if (!this.disposal) {
            this.disposed = true;
            for (const controller of this.operations.keys()) {controller.abort();}
            this.disposal = (async () => {
                await Promise.allSettled(this.operations.values());
                await disposeAnalyzerServers();
                await this.projectEvaluations.dispose();
                await this.preparedOutputs.dispose();
            })();
        }
        return this.disposal;
    }

    private async runBatch(batch: ChangeBatch, controller: AbortController, manual?: ManualSelection, manualOperation = false, scope?: RunScope): Promise<RunSummary> {
        const run = { ...await this.startRun(batch, controller, manual, manualOperation), scope: manual ? undefined : scope };
        const state: { sessions?: RunnerSession; analyzing?: Promise<ReadonlyMap<string, string | null>> } = {};
        try {
            if (run.structural) {
                run.phase('preparingProjects');
                await this.refreshStructure(run);
            }
            const beforeBuild = this.hashes;
            await this.publishCoverage(run.signal);
            const plan = this.planBuild(run);
            const outputLease = await claimRunOutputs(path.join(this.options.storage, 'runs'), this.identity, run.signal, this.options.events.output);
            try {
                run.phase('building');
                const built = await this.build(run, plan, outputLease, beforeBuild);
                run.phase('preparingTests');
                const prepared = await this.prepareTests(run, plan, built, outputLease, state);
                const selected = await this.selectRun(run, built, prepared);
                run.phase('testing');
                const tested = await this.executeSelection(run, built, prepared, selected);
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
    private async startRun(batch: ChangeBatch, controller: AbortController, manual: ManualSelection | undefined, manualOperation: boolean): Promise<RunContext> {
        const signal = controller.signal;
        const began = Date.now(), events = this.options.events, topology = this.topology;
        const configured = this.options.configuration();
        if (manual?.debug && !this.options.events.debug) {throw new Error('Debugging is not available.');}
        // A debugged host may sit at a breakpoint far longer than the run timeout.
        // A configuration override applies to this run only: evaluation, preparation and
        // build identities include the configuration, so nothing cached for another one is reused.
        const override = manual?.configuration?.trim() || undefined;
        const config: EngineConfiguration = manual?.debug ? { ...configured, coverage: false, timeout: 7 * 24 * 60 * 60 * 1000, maxParallelTestFiles: 1 }
            : { ...configured, coverage: (manual?.discoverOnly ? false : manual?.coverage) ?? configured.coverage, ...override ? { configuration: override } : {} };
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
            throw new Error('testy.testArguments contains an option reserved for test discovery, selection, or communication. Remove runner/filter options from that setting.');
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
        for (const file of [...batch.files.map(normalizePath), ...sourceChanges]) {this.pendingChanges.add(file);}
        const changes = [...this.pendingChanges];
        const structural = !!manual || this.structureDirty || newBaseline || changes.some(file => isConfigurationFile(file) || !this.index.hasSource(file) || !this.hashes.has(file));
        return { controller, signal, began, topology, configured, config, projectLimit, testLimit, manual, manualOperation, full, newBaseline, baseline,
            rootSnapshot, processOptions, changes, previousIndex: this.index, structural, phase, finishPhase };
    }

    /** Find, restore and evaluate projects, then reconcile the test inventory. */
    private async refreshStructure(run: RunContext): Promise<void> {
        const { config, signal, manual, newBaseline, rootSnapshot, processOptions, projectLimit, changes, baseline } = run;
        const events = this.options.events;
        if (newBaseline || changes.some(isConfigurationFile)) {this.sdkContexts.clear(); this.restored.clear();}
        const selected = manual && !manual.all ? [...new Set([...manual.projects ?? [], ...this.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])] : undefined;
        const filter = await filterEntryPoints(await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes], signal, 16,
            (directory, error) => events.output(`Skipping unreadable directory ${directory}: ${error.message}\n`)),
        { solution: config.solution, include: config.projects?.include, exclude: config.projects?.exclude }, rootSnapshot, signal);
        const entryPoints = filter.entryPoints;
        // SDK selection can fail before MSBuild can describe any inputs.
        // Keep its candidate paths observable so a corrected pin can recover.
        this.setInputs([...this.inputs, ...filter.inputs, ...entryPoints, ...entryPoints.flatMap(sdkConfigurationFiles)
            .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot))]);
        this.projectEvaluations.retain(entryPoints);
        const toolContext = await evaluationToolContext(config.dotnet, this.options.analyzer, entryPoints.map(file => path.dirname(file)), signal);
        // Launch-specific variables (VSCODE_PID, SHLVL, ...) would otherwise invalidate every saved evaluation on restart.
        const evaluationContextFor = (key: string | undefined): string => contentHash(JSON.stringify([key, config.dotnet, config.configuration, this.options.analyzer, rootSnapshot,
            config.excludes, environmentIdentity(process.env)]));
        const evaluationContext = evaluationContextFor(toolContext?.key);
        const snapshots = await refreshProjectSnapshotBatches(this.projectSnapshots, entryPoints, selected, async files => {
            let currentToolContext = toolContext, currentEvaluationContext = evaluationContext;
            let reused = newBaseline || !toolContext ? new Map<string, readonly Project[]>() : await this.projectEvaluations.get(files, evaluationContext, signal);
            const pending = files.filter(file => !reused.has(file));
            let contexts = await sdkContextGroups(pending, signal);
            const key = (file: string): string => `${config.dotnet}\0${config.configuration}\0${file}`;
            // SDK contexts may restore the same physical dependency. Each
            // restore graph parallelizes internally without competing writers.
            for (const context of contexts) {
                const options = { ...processOptions, cwd: context.cwd };
                await this.ensureSdk(config.dotnet, options, context.key);
                const missing = context.files.filter(file => !this.restored.has(key(file)));
                if (missing.length) {
                    await restoreProjects(config.dotnet, missing, config.configuration, options, projectLimit);
                    for (const file of missing) {this.restored.add(key(file));}
                }
            }
            // A fresh baseline still runs Restore, which can create or remove
            // evaluated imports and sources. Only its completed outputs may
            // validate an older graph; every miss receives normal inspection.
            if (newBaseline) {
                currentToolContext = await evaluationToolContext(config.dotnet, this.options.analyzer, entryPoints.map(file => path.dirname(file)), signal);
                currentEvaluationContext = evaluationContextFor(currentToolContext?.key);
                reused = currentToolContext ? await this.projectEvaluations.get(files, currentEvaluationContext, signal) : new Map<string, readonly Project[]>();
                // Restore can also change the SDK selected by a project.
                contexts = await sdkContextGroups(files.filter(file => !reused.has(file)), signal);
                for (const context of contexts) {await this.ensureSdk(config.dotnet, { ...processOptions, cwd: context.cwd }, context.key);}
            }
            if (reused.size) {events.output(`Reusing ${reused.size} validated project evaluation${reused.size === 1 ? '' : 's'}.\n`);}
            if (!contexts.length) {return reused;}
            const workers = Math.min(projectLimit, contexts.length);
            const graphs = await mapConcurrent(contexts, projectLimit, signal, async (context, _index, workerSignal) => {
                const graph = await evaluateProjects(config.dotnet, context.files, config.configuration,
                    { ...processOptions, cwd: context.cwd, signal: workerSignal }, this.options.analyzer, Math.max(1, Math.floor(projectLimit / workers)));
                return [...graph];
            });
            const evaluated = new Map(graphs.flat());
            if (currentToolContext) {await this.projectEvaluations.put(evaluated, currentEvaluationContext, signal, currentToolContext.root);}
            return new Map([...reused, ...evaluated]);
        });
        if (run.topology !== this.topology) {throw new Cancelled();}
        this.projectSnapshots = snapshots;
        const evaluated = [...snapshots.values()].flat();
        // Exclusions control inventory and watching. MSBuild still writes
        // required excluded dependencies, so their conflicts stay in its plan.
        this.buildGraph = mergeProjects(evaluated);
        this.projects = mergeProjects(evaluated.filter(project => !isExcluded(project.file, config.excludes, rootSnapshot)));
        this.reportUnsupported();
        this.index = new ProjectIndex(this.projects); this.structureDirty = !!manual;
        this.sources.setFiles(this.projects.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []])
            .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot)),
        this.projects.flatMap(project => project.analysisFiles ?? project.sourceFiles));
        this.setInputs([...this.sources.files, ...filter.inputs, ...this.projects.map(project => project.file)]);
        await this.sources.refresh(this.sources.files, signal);
        const eligible = new Set(this.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
        const retained = this.groups.filter(group => eligible.has(testTargetKey(group.project, group.framework)));
        if (retained.length !== this.groups.length || [...this.runtimeGroups.values()].some(group => !eligible.has(testTargetKey(group.project, group.framework)))) {
            // A library/reference can remain in the build graph without
            // remaining a test target. Retire it even if the next build fails.
            await this.reconcileGroups(retained, baseline);
            await this.save(signal);
        }
    }

    /** Unsupported test projects are skipped with a warning; a workspace with
     * nothing runnable reports why instead of silently showing no tests. */
    private reportUnsupported(): void {
        const reasons = [...new Set(this.projects.flatMap(project => project.isTestProject && project.entryPoint !== false && project.unsupported ? [project.unsupported] : []))].sort();
        const report = reasons.join('\n');
        if (reasons.length && !this.projects.some(isTestTarget)) {
            throw new Error(`No test project can run under Testy.\n${report}`);
        }
        if (report !== this.unsupportedReport && reasons.length) {
            this.options.events.output(`Skipping ${reasons.length} unsupported test target${reasons.length === 1 ? '' : 's'}:\n${report}\n`);
        }
        this.unsupportedReport = report;
    }

    /** Projects affected by this run, their build closure, and the test targets to discover. */
    private planBuild(run: RunContext): BuildPlan {
        const { manual, newBaseline, config, changes, previousIndex, baseline } = run;
        const relevant = manual ? new Set(manual.all ? this.projects.map(project => project.file) : [...manual.projects ?? [], ...this.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
            : newBaseline || config.mode === 'all' ? new Set(this.projects.map(project => project.file)) : this.index.affected(changes);
        if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
        const anticipated = this.select(changes);
        for (const group of this.groups) {
            if (!manual && (anticipated.groups.includes(group) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
        }
        const closure = buildOrder(this.buildGraph, relevant);
        const builds = buildRoots(closure);
        const visibleTargets = new Set(this.projects.filter(isTestTarget).map(project => testTargetKey(project.file, project.framework)));
        const testBuilds = builds.filter(project => isTestTarget(project) && visibleTargets.has(testTargetKey(project.file, project.framework)));
        return { anticipated, closure, builds, testBuilds, sharedOutputs: buildSnapshotTargets(closure, builds) };
    }

    /** Build in conflict-free waves, snapshotting test outputs that a later context could overwrite. */
    private async build(run: RunContext, plan: BuildPlan, outputLease: RunOutputLease, beforeBuild: ReadonlyMap<string, string>): Promise<BuildResult> {
        const { signal, config, processOptions, projectLimit, manual, manualOperation } = run;
        const { closure, builds, testBuilds, sharedOutputs } = plan;
        const snapshots = new Map<string, string>();
        const builtInputs = [...new Set(closure.flatMap(project => [...project.analysisFiles ?? project.sourceFiles, ...project.inputs ?? []]))];
        const revision = this.sources.revision;
        const buildContexts = await sdkContextGroups([...new Set(builds.map(project => project.file))], signal);
        const sdkByFile = new Map(buildContexts.flatMap(context => context.files.map(file => [file, context.key] as const)));
        for (const wave of buildWaves(closure, builds, sdkByFile)) {
            const contexts = await sdkContextGroups([...new Set(wave.map(project => project.file))], signal);
            const workers = Math.min(projectLimit, contexts.length);
            await mapConcurrent(contexts, projectLimit, signal, async (context, _index, workerSignal) => {
                const options = { ...processOptions, cwd: context.cwd, signal: workerSignal };
                await this.ensureSdk(config.dotnet, options, context.key);
                const roots = wave.filter(project => context.files.includes(project.file));
                await buildProjects(config.dotnet, roots, config.configuration, options, Math.max(1, Math.floor(projectLimit / workers)));
                for (const project of roots) {
                    const key = testTargetKey(project.file, project.framework);
                    if (testBuilds.includes(project) && sharedOutputs.has(key)) {
                        const snapshot = path.join(outputLease.directory, 'snapshots', contentHash(key));
                        await copyOutput(path.dirname(project.assembly), snapshot, workerSignal); snapshots.set(key, snapshot);
                    }
                }
            });
            if (builds.length > wave.length) {this.options.events.output(`Build wave complete: ${wave.length} roots; dependency or output conflicts require ordered waves.\n`);}
        }
        const changedDuringBuild = await this.sources.refresh(builtInputs, signal);
        const obsoleteBuild = changedDuringBuild.some(file => !this.sources.isGenerated(file) && beforeBuild.get(file) !== this.hashes.get(file));
        if (obsoleteBuild && !manual && !manualOperation) {this.options.events.invalidated(changedDuringBuild); throw new Cancelled();}
        // A target can add a generated header to a pre-existing placeholder.
        // Exclude its old hash from analysis and coverage attribution as well.
        const before = changedDuringBuild.some(file => this.sources.isGenerated(file))
            ? new Map([...beforeBuild].filter(([file]) => !this.sources.isGenerated(file))) : beforeBuild;
        return { revision, obsoleteBuild, before, snapshots, sdkByFile };
    }

    /** Analyze sources, keeping only analyses whose parsed bytes match the current versions. */
    private async analyzeSources(run: RunContext, analysisSlots: number): Promise<ReadonlyMap<string, string | null>> {
        const { config, processOptions, signal } = run, events = this.options.events;
        const started = Date.now(), analysisHashes = this.sources.analysisHashes;
        const allFiles = [...analysisHashes.keys()];
        const context = await sourceAnalysisContext(config.dotnet, this.options.analyzer, processOptions);
        const contextChanged = !context || context !== this.analysisContext;
        const shapeFiles = allFiles.filter(file => contextChanged || !this.analyses.get(file) || analysisHashes.get(file) !== this.analyzedHashes.get(file));
        const candidates = [...this.sources.aliasSources].sort(([a], [b]) => a.localeCompare(b));
        const stamp = contentHash(JSON.stringify(candidates)), aliasesChanged = contextChanged || stamp !== this.aliasStamp;
        let nextAnalyses: ReadonlyMap<string, SourceShape | null>;
        const nextHashes = new Map(contextChanged ? [] : this.analyzedHashes);
        let uncertain = aliasesChanged;
        try {
            const result = await sourceAnalysisBatch(config.dotnet, this.options.analyzer, shapeFiles, this.options.storage, processOptions,
                this.excludedAliases, analysisSlots, aliasesChanged ? { sources: candidates.map(([, content]) => content), allFiles } : undefined, true);
            if (!result.sourceHashes) {uncertain = true; throw new Error('Source analysis did not provide parsed-byte provenance.');}
            const mismatched = [...result.analyses.keys()].filter(file => result.sourceHashes!.get(file) !== analysisHashes.get(file));
            if (mismatched.length) {
                // An edit can also introduce an alias in a previously
                // ordinary source. Retry the complete alias inventory.
                this.sources.mark(mismatched); uncertain = true;
                throw new Error('Source inputs changed during analysis.');
            }
            if (context && (result.analyses.size || (aliasesChanged && candidates.length))
                && context !== await sourceAnalysisContext(config.dotnet, this.options.analyzer, processOptions)) {
                uncertain = true; throw new Error('Source analysis tools changed during analysis.');
            }
            signal.throwIfAborted();
            nextAnalyses = result.analyses;
            for (const [file, shape] of nextAnalyses) {
                nextHashes.delete(file);
                if (context && shape) {nextHashes.set(file, result.sourceHashes.get(file)!);}
            }
            this.analysisContext = context;
            this.excludedAliases = result.aliases; this.aliasStamp = stamp;
            const reused = allFiles.length - nextAnalyses.size;
            if (reused > 0) {events.output(`Reused ${reused} unchanged source analyses.\n`);}
        }
        catch (error) {
            signal.throwIfAborted(); events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
            // An unresolved alias edit can affect every otherwise unchanged
            // declaration. Do not retain narrow signatures or mark a failed
            // analysis as current; the next operation must retry it.
            const failedFiles = uncertain ? allFiles : shapeFiles;
            nextAnalyses = new Map(failedFiles.map(file => [file, null]));
            for (const file of failedFiles) {nextHashes.delete(file);}
            if (uncertain) {this.analysisContext = undefined;}
        } finally {events.output(`Testy timing: Source analysis ${Date.now() - started}ms (overlaps test preparation)\n`);}
        this.analyses = new Map([...this.analyses, ...nextAnalyses].filter(([file]) => analysisHashes.has(file)));
        this.analyzedHashes = new Map([...nextHashes].filter(([file]) => analysisHashes.has(file)));
        return resolveShapes(this.analyses, this.projects);
    }

    /** Overlap source analysis with coverage setup, runner preparation and discovery. */
    private async prepareTests(run: RunContext, plan: BuildPlan, built: BuildResult, outputLease: RunOutputLease,
        state: { sessions?: RunnerSession; analyzing?: Promise<ReadonlyMap<string, string | null>> }): Promise<PreparedTests> {
        const { config, signal, projectLimit, testLimit, processOptions, full, manual, rootSnapshot, controller } = run;
        const { builds, testBuilds, anticipated } = plan;
        const events = this.options.events;
        // Each target may eventually use every file worker as other targets finish.
        // Grow retention to that finite slot budget while retaining its byte limit.
        await this.preparedOutputs.ensureCapacity(Math.max(16, Math.min(Number.MAX_SAFE_INTEGER, testLimit * testBuilds.length)));
        const preparationBudget = new Semaphore(projectLimit);
        const analysisSlots = Math.max(1, projectLimit - testBuilds.length);
        // Reserve analysis threads before admitting one-slot discovery jobs.
        // Other preparation work only borrows spare slots without waiting,
        // so these nested reservations cannot deadlock.
        const analyzeWithBudget = (slots: number): Promise<ReadonlyMap<string, string | null>> => slots
            ? preparationBudget.run(signal, () => analyzeWithBudget(slots - 1)) : this.analyzeSources(run, analysisSlots);
        const analyzing = state.analyzing = analyzeWithBudget(analysisSlots);
        // Discovery may fail before the join; retain/drain the analysis rejection below.
        void analyzing.catch(() => undefined);
        let coverageTool: string | undefined;
        if (config.coverage && builds.some(project => project.isTestProject)) {
            try {
                coverageTool = await preparationBudget.run(signal, () => this.ensureCoverageTool(config, processOptions));
            }
            catch (error) {signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);}
        }
        const anticipatedTargets = new Set(anticipated.groups.map(group => testTargetKey(group.project, group.framework)));
        const prepared: PreparedTests = { coverageTool, runtimeTreeChanged: false, liveIds: new Set(), currentShapes: new Map(), sessions: undefined! };
        let initialPreparation = true;
        const runnerOptions: RunnerOptions = {
            ...processOptions, dotnet: config.dotnet, storage: path.join(this.options.storage, 'runs'),
            testArguments: config.testArguments, coverageTool, managedCoverageTool: !config.coverageTool,
            assemblies: this.projects.flatMap(project => project.assemblies ?? [project.assembly]), analyzer: this.options.analyzer, identity: this.identity,
            modules: this.projects.flatMap(project => (project.contexts ?? [project]).map(context => ({
                name: context.assemblyName ?? path.basename(context.assembly, path.extname(context.assembly)), project: project.file,
                sources: [...project.sourceFiles, ...project.inputs ?? []]
            }))),
            outputRoot: outputLease.directory, snapshots: built.snapshots,
            preparedOutputCache: this.preparedOutputs,
            preparationToolIdentities: this.toolIdentities,
            // Primary discovery already owns one permit. Additional DLLs
            // may borrow spare capacity only during this preparation stage.
            tryInstrumentation: (workerSignal, work) => initialPreparation ? preparationBudget.tryRun(workerSignal, work) : undefined,
            deferCoverage: !full && !manual && config.mode === 'affected'
                ? target => !anticipatedTargets.has(testTargetKey(target.project, target.framework)) : undefined,
            preparationContexts: new Map(testBuilds.map(project => [testTargetKey(project.file, project.framework), contentHash(JSON.stringify({
                roots: rootSnapshot, configuration: config.configuration, excludes: config.excludes,
                target: project.contextId, sdk: built.sdkByFile.get(project.file),
                contexts: buildOrder(this.buildGraph, new Set([project.file])).map(context => ({
                    id: context.contextId, file: context.file, framework: context.framework, assembly: context.assembly,
                    properties: Object.entries(context.properties ?? {}).sort(([a], [b]) => a.localeCompare(b))
                }))
            }))])),
            buildInputs: new Map(this.projects.filter(project => project.isTestProject).map(project => [project.file,
                [...new Set(buildOrder(this.projects, new Set([project.file])).flatMap(input => [...input.inputs ?? []]))]])),
            onResult: (group, result, test) => {
                if (group.runtimeOnly) {
                    if (!this.runtimeGroups.has(group.id)) {prepared.runtimeTreeChanged = true;}
                    this.runtimeGroups.set(group.id, group);
                } else {
                    for (const [id, unknown] of this.runtimeGroups) {
                        if (testTargetKey(group.project, group.framework) !== testTargetKey(unknown.project, unknown.framework)) {continue;}
                        const runtime = this.runtime.get(id);
                        if (runtime?.delete(result.id)) {
                            this.knownCache.delete(id); prepared.runtimeTreeChanged = true;
                            if (!runtime.size) {this.runtimeGroups.delete(id); this.runtime.delete(id);}
                        }
                    }
                }
                if (result.node && !this.discoveredIds.get(group.id)?.has(result.id)) {
                    const nodes = this.runtime.get(group.id) ?? new Map<string, ReturnType<typeof discoveredTest>>(); nodes.set(result.id, test ?? discoveredTest(result.node as { uid: string })); this.runtime.set(group.id, nodes);
                    this.knownCache.delete(group.id);
                }
                for (const observer of this.resultObservers) {observer(group, result);}
                events.result(group, result);
            }, onStarted: events.started, onPrepared: events.prepared,
            onExpanded: groups => events.selected({ groups, reason: 'Containing files for provider runtime identities', fallback: true }),
            debug: manual?.debug ? events.debug : undefined
        };
        const sessions = prepared.sessions = state.sessions = new RunnerSession(runnerOptions);
        const next = this.groups.filter(group => !testBuilds.some(project => project.file === group.project && project.framework === group.framework)
            && this.projects.some(project => project.file === group.project && project.framework === group.framework && isTestTarget(project)));
        let discoveredProjects = 0, activeDiscoveries = 0;
        const discoveryProgress = (): void => events.phase({ kind: 'preparingTests', completed: discoveredProjects, total: testBuilds.length, active: activeDiscoveries });
        let inventories: readonly (readonly TestFile[])[];
        try {
            inventories = await mapConcurrent(testBuilds, projectLimit, signal, async project => {
                return preparationBudget.run(signal, async () => {
                    activeDiscoveries++; discoveryProgress();
                    try {const groups = await sessions.discover(project); discoveredProjects++; return groups;}
                    finally {activeDiscoveries--; discoveryProgress();}
                });
            }, () => controller.abort());
        } finally {initialPreparation = false;}
        prepared.currentShapes = await analyzing;
        next.push(...inventories.flat());
        prepared.liveIds = await this.reconcileGroups(next, run.baseline);
        return prepared;
    }

    /** Choose the files to run: a manual selection, the remaining baseline, or the affected impact. */
    private async selectRun(run: RunContext, built: BuildResult, prepared: PreparedTests): Promise<SelectedRun> {
        const { baseline, changes, signal, config, manual, previousIndex } = run;
        const { before } = built, { currentShapes, sessions } = prepared;
        const previousShapes = baseline?.shapes ?? this.shapes;
        const conservative = new Set(changes.filter(file => !currentShapes.get(file) || currentShapes.get(file) !== previousShapes.get(file)));
        const checkpointInputs = new Map(before);
        if (baseline) {for (const file of changes) {
            if (checkpointInputs.has(file)) {continue;}
            try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
            catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
        }}
        const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
        // Both indexes matter: a change can leave the graph as well as enter it.
        const impactFrom = (index: ProjectIndex): Selection => selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, index,
            file => this.coverage.dependentGroups([file]), project => this.coverage.dependentProjects([project]));
        const oldImpact = impactFrom(previousIndex), nextImpact = impactFrom(this.index);
        const impact = { ...nextImpact, groups: [...new Map([...oldImpact.groups, ...nextImpact.groups].map(group => [group.id, group])).values()],
            causes: new Map([...oldImpact.causes ?? [], ...nextImpact.causes ?? []]) };
        if (baseline) {
            for (const group of impact.groups) {baseline.completed.delete(group.id); baseline.runtimeResults.delete(group.id);}
            baseline.shapes = currentShapes; baseline.inputs = checkpointInputs;
        }
        let selection: Selection;
        if (manual?.discoverOnly) {
            selection = { groups: [], reason: 'Discovery only', fallback: false, causes: new Map() };
        } else if (manual) {
            const groups = selectManual(this.displayGroups, manual, group => this.knownTests(group));
            selection = { groups, reason: 'Manual run', fallback: false, causes: uniformCauses(groups, 'manual') };
            if ((manual.groups.size || manual.projects?.size) && !manual.exclude && !selection.groups.length) {throw new Error('The selected tests changed during discovery. Select them again from the refreshed Test Explorer.');}
        } else if (baseline) {
            const affected = new Set(impact.groups.map(group => group.id));
            const pending = this.groups.filter(group => !baseline.completed.has(group.id));
            // During learning, finish unaffected files before returning to a file
            // that ongoing edits keep cancelling.
            pending.sort((a, b) => Number(affected.has(a.id)) - Number(affected.has(b.id)));
            selection = { groups: pending, reason: `Baseline (${baseline.completed.size}/${this.groups.length} files complete)`, fallback: false, causes: uniformCauses(pending, 'baseline') };
        } else {selection = impact;}
        if (run.scope && !baseline) {
            const scoped = selectManual(selection.groups, run.scope, group => this.knownTests(group));
            selection = { ...selection, groups: scoped, reason: `${selection.reason} (continuous run scope: ${scoped.length} of ${selection.groups.length} files)` };
        }
        if (manual) {const groups = await sessions.resolveSelection(selection.groups); selection = { ...selection, groups, causes: uniformCauses(groups, 'manual') };}
        const selectedIds = new Set(selection.groups.map(group => group.id));
        const fresh = new Set([...this.coverage.traces].filter(([id, trace]) => !selectedIds.has(id)
            && Object.entries(trace.inputs ?? {}).every(([file, hash]) => sourceVersion(before, file) === hash)).map(([id]) => id));
        this.coverage.markStale(fresh, false);
        this.options.events.selected(selection); await this.publishCoverage(signal);
        return { selection, currentShapes };
    }

    /** Run the selected batches, committing each contribution in order as it completes. */
    private async executeSelection(run: RunContext, built: BuildResult, prepared: PreparedTests, selected: SelectedRun): Promise<TestedRun> {
        const { signal, config, configured, manual, manualOperation, baseline, changes, testLimit, topology, controller } = run;
        const { before, revision, obsoleteBuild } = built, { coverageTool, sessions, liveIds } = prepared, { selection } = selected;
        const events = this.options.events;
        const batches: TestFile[][] = [];
        const originalGroups = new Map(this.groups.map(group => [group.id, group]));
        const projectGroups = new Map<string, TestFile[]>();
        for (const group of this.groups) {const key = testTargetKey(group.project, group.framework); const groups = projectGroups.get(key) ?? []; groups.push(group); projectGroups.set(key, groups);}
        const completeFiles = new Set(selection.groups.filter(group => {
            const requested = new Set(group.tests.map(test => test.id)), original = originalGroups.get(group.id);
            return original && original.tests.every(test => requested.has(test.id));
        }).map(group => group.id));
        const completeProjects = new Set(selection.groups.map(group => testTargetKey(group.project, group.framework)));
        for (const group of this.groups) {if (!completeFiles.has(group.id)) {completeProjects.delete(testTargetKey(group.project, group.framework));}}
        for (const group of selection.groups) {
            // A partial project run needs separate contributions; replacing its
            // aggregate would erase the coverage of unselected files.
            const key = testTargetKey(group.project, group.framework);
            const batchProjects = !coverageTool || (config.mode === 'all' && completeProjects.has(key));
            const existing = batchProjects ? batches.find(items => testTargetKey(items[0].project, items[0].framework) === key) : undefined;
            if (existing) {existing.push(group);} else {batches.push([group]);}
        }
        const results: TestResult[] = [];
        const executedFiles = new Set<string>();
        const runtimeResults = baseline?.runtimeResults ?? new Map<string, ReadonlySet<string>>();
        let available = !!coverageTool, failedBatches = 0;
        const commits = new SerialQueue();
        let completed = 0, active = 0;
        const allowSecondary = !manual || (!manual.exclude && !manual.tests && ![...manual.groups].some(id => this.runtimeGroups.has(id)));
        const progress = (): void => events.phase({ kind: 'testing', completed, total: batches.length, active, ...baseline ? { learned: baseline.completed.size, learnedTotal: this.groups.length } : {} });
        const commit = async (groups: readonly TestFile[], run: FileRun): Promise<void> => {
            signal.throwIfAborted();
            for (const group of groups) {executedFiles.add(group.id);}
            results.push(...run.results); available &&= run.coverageAvailable;
            signal.throwIfAborted();
            await this.sources.refresh(run.trace.dependencies, signal);
            const current = topology === this.topology && !obsoleteBuild && revision === this.sources.revision
                && Object.entries(run.trace.inputs ?? {}).every(([file, hash]) => sourceVersion(this.hashes, file) === hash);
            if (!current) {
                this.coverage.markStale(new Set(groups.map(group => group.id)));
                if (!manual && !manualOperation) {events.invalidated(changes); throw new Cancelled();}
                return;
            }
            const complete = groups.every(group => {
                const requested = new Set(group.tests.map(test => test.id));
                return originalGroups.get(group.id)?.tests.every(test => requested.has(test.id));
            });
            if (complete) {
                const reported = new Set(run.results.map(result => result.id));
                let removed = false;
                for (const group of groups) {
                    runtimeResults.set(group.id, reported);
                    const runtime = this.runtime.get(group.id);
                    for (const id of runtime?.keys() ?? []) {if (!reported.has(id)) {runtime!.delete(id); this.knownCache.delete(group.id); removed = true;}}
                }
                const key = testTargetKey(groups[0].project, groups[0].framework), project = projectGroups.get(key);
                if (project?.every(group => runtimeResults.has(group.id))) {
                    const projectReported = new Set(project.flatMap(group => [...runtimeResults.get(group.id)!]));
                    for (const [id, group] of this.runtimeGroups) {if (testTargetKey(group.project, group.framework) === key) {
                        const runtime = this.runtime.get(id);
                        for (const uid of runtime?.keys() ?? []) {if (!projectReported.has(uid)) {runtime!.delete(uid); this.knownCache.delete(id); removed = true;}}
                        if (!runtime?.size) {this.runtimeGroups.delete(id); this.runtime.delete(id); this.knownCache.delete(id);}
                    }}
                }
                prepared.runtimeTreeChanged ||= removed;
            } else {
                // A partial manual run may reveal another deferred row, but
                // cannot retire rows from an earlier complete checkpoint.
                for (const group of groups) {
                    const previous = runtimeResults.get(group.id);
                    if (previous) {runtimeResults.set(group.id, new Set([...previous, ...run.results.map(result => result.id)]));}
                }
            }
            if (prepared.runtimeTreeChanged) {prepared.runtimeTreeChanged = false; await events.discovered(this.displayGroups);}
            if (run.coverageAvailable && complete) {
                if (groups.length > 1) {for (const group of groups) {liveIds.delete(group.id);}}
                else {
                    // The old aggregate cannot be split into file ownership.
                    // Retain it as history while publishing the new file trace.
                    this.coverage.markHistorical(new Set([projectCoverageId(groups[0])]));
                }
                // Another configuration can compile different code (#if DEBUG, optimizations), so
                // what it covered cannot narrow later selections: keep the trace, but not its trust.
                await this.coverage.replaceAsync([config.configuration !== configured.configuration ? { ...run.trace, reliable: false } : run.trace], liveIds, signal);
                if (revision !== this.sources.revision) {this.coverage.markStale(new Set([run.trace.groupId]));}
                const aggregate = projectCoverageId(groups[0]);
                if (groups.length === 1 && this.coverage.traces.has(aggregate)
                    && projectGroups.get(testTargetKey(groups[0].project, groups[0].framework))!.every(group => {
                        const trace = this.coverage.traces.get(group.id); return trace && !trace.stale;
                    })) {
                    liveIds.delete(aggregate); this.coverage.replace([], liveIds);
                }
            } else if (!manual) {this.retainWithoutCoverage(groups, liveIds);}
            if (complete && config.configuration === configured.configuration && (!manual || !configured.coverage || run.coverageAvailable)) {for (const group of groups) {baseline?.completed.add(group.id);}}
            await this.publishCoverage(signal); await this.save(signal);
        };
        /** A batch that could not run reports its tests as errored; other batches continue. */
        const fail = async (groups: readonly TestFile[], error: unknown, reported: ReadonlySet<string>): Promise<void> => {
            signal.throwIfAborted();
            failedBatches++;
            const message = error instanceof Error ? error.message : String(error);
            events.output(`Test batch failed for ${groups.map(group => path.basename(group.file ?? group.project)).join(', ')}: ${message}\n`);
            for (const group of groups) {
                executedFiles.add(group.id);
                for (const test of group.tests) {
                    if (reported.has(test.id)) {continue;}
                    const result: TestResult = { id: test.id, name: test.name, fullyQualifiedName: test.fullyQualifiedName, outcome: 'errored', duration: 0, message, node: test.node };
                    results.push(result); events.result(group, result);
                }
            }
            // Nothing was learned. Retain earlier coverage, and complete the baseline
            // for these files so a persistent failure cannot hold it open forever.
            if (!manual) {this.retainWithoutCoverage(groups, liveIds);}
            if (!manual) {for (const group of groups) {baseline?.completed.add(group.id);}}
            await this.publishCoverage(signal); await this.save(signal);
        };
        await mapConcurrentByKey(batches, testLimit, signal, groups => testTargetKey(groups[0].project, groups[0].framework), async (requestedGroups, _index, _workerSignal, worker) => {
            active++; progress();
            const reported = new Set<string>();
            const unsubscribe = this.observeResults(requestedGroups, reported);
            try {
                let outcome: FileRun;
                try {outcome = await sessions.run(requestedGroups, before, allowSecondary ? worker + 1 : 0);}
                catch (error) {
                    if (signal.aborted || error instanceof Cancelled || (error as Error)?.name === 'AbortError') {throw error;}
                    await commits.run(() => fail(requestedGroups, error, reported));
                    completed++; return;
                } finally {unsubscribe();}
                await commits.run(() => commit(outcome.executedGroups, outcome));
                completed++;
            } finally {active--; progress();}
        }, () => controller.abort(), groups => allowSecondary && sessions.canRunParallel(groups));
        return { results, executedFiles, available, failedBatches };
    }

    /** Track results reported for a batch so a later failure only fills in the rest. */
    private observeResults(groups: readonly TestFile[], reported: Set<string>): () => void {
        const ids = new Set(groups.map(group => group.id));
        const observer = (group: TestFile, result: TestResult): void => {if (ids.has(group.id) || group.runtimeOnly) {reported.add(result.id);}};
        this.resultObservers.add(observer);
        return () => {this.resultObservers.delete(observer);};
    }

    /** Preserve previous coverage and its freshness state; without collection no
     * narrowing information was learned, so a new file gets a conservative trace. */
    private retainWithoutCoverage(groups: readonly TestFile[], liveIds: ReadonlySet<string>): void {
        for (const group of groups) {
            if (this.coverage.traces.has(group.id)) {this.coverage.invalidate(new Set([group.id]), false);}
            else {this.coverage.replace([{ groupId: group.id, dependencies: group.file ? [group.file] : [], coverage: [], reliable: false, timestamp: Date.now(), inputs: {} }], liveIds);}
        }
    }

    private setInputs(files: Iterable<string>): void {
        const inputs = new Set(files);
        if (inputs.size === this.inputs.length && this.inputs.every(file => inputs.has(file))) {return;}
        this.inputs = [...inputs]; this.inputDirectories = [...new Set(this.inputs.map(file => path.dirname(file)))]; this.inputTopology++;
        // Watch evaluated inputs before building/discovering: either operation
        // can fail, and fixing an external input must still trigger recovery.
        this.options.events.inputsChanged?.();
    }

    private async reconcileGroups(next: readonly TestFile[], baseline?: Baseline): Promise<Set<string>> {
        const oldGroups = new Map(this.groups.map(group => [group.id, group]));
        const identitiesChanged = new Set(next.filter(group => {
            const previous = oldGroups.get(group.id);
            return previous && previous.tests.map(test => test.id).sort().join('\0') !== group.tests.map(test => test.id).sort().join('\0');
        }).map(group => group.id));
        for (const id of identitiesChanged) {baseline?.completed.delete(id); baseline?.runtimeResults.delete(id); this.runtime.delete(id); this.knownCache.delete(id);}
        this.coverage.invalidate(identitiesChanged); this.groups = next;
        this.discoveredIds.clear();
        for (const group of next) {this.discoveredIds.set(group.id, new Set(group.tests.map(test => test.id)));}
        const groupIds = new Set(next.map(group => group.id));
        const targets = new Set(next.map(group => testTargetKey(group.project, group.framework)));
        const changedTargets = new Set(next.filter(group => identitiesChanged.has(group.id)).map(group => testTargetKey(group.project, group.framework)));
        for (const [id, group] of this.runtimeGroups) {
            const key = testTargetKey(group.project, group.framework);
            if (!targets.has(key) || changedTargets.has(key)) {this.runtimeGroups.delete(id);}
        }
        for (const id of this.runtime.keys()) {if (!groupIds.has(id) && !this.runtimeGroups.has(id)) {this.runtime.delete(id); this.knownCache.delete(id);}}
        for (const id of baseline?.completed ?? []) {if (!groupIds.has(id)) {baseline?.completed.delete(id);}}
        for (const id of baseline?.runtimeResults.keys() ?? []) {if (!groupIds.has(id)) {baseline?.runtimeResults.delete(id);}}
        const liveIds = new Set([...next.map(group => group.id), ...next.map(projectCoverageId)]);
        this.coverage.replace([], liveIds); await this.options.events.discovered(this.displayGroups);
        return liveIds;
    }

    /** One version check per SDK context, shared by concurrent callers. The check
     * is not bound to any caller's cancellation; each caller stops waiting on its own. */
    private async ensureSdk(dotnet: string, options: ProcessOptions, sdkContext = options.cwd): Promise<void> {
        const key = `${dotnet}\0${sdkContext}`; if (this.sdkContexts.has(key)) {return;}
        let check = this.sdkChecks.get(key);
        if (!check) {
            check = (async () => {
                const version = requireSuccess(await runProcess(dotnet, ['--version'], { ...options, signal: undefined, output: undefined }), `Finding the .NET SDK for ${options.cwd}`).stdout.trim();
                if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 10) {throw new Error(`Testy requires .NET SDK 10 or later; ${options.cwd} selects ${version}. Check its global.json.`);}
                this.sdkContexts.add(key);
            })();
            const pending = check;
            this.sdkChecks.set(key, pending);
            void pending.then(() => this.sdkChecks.delete(key), () => this.sdkChecks.delete(key));
        }
        await untilAborted(check, options.signal);
    }

    private async ensureCoverageTool(config: EngineConfiguration, options: ProcessOptions): Promise<string> {
        if (config.coverageTool) {await fs.access(config.coverageTool); return config.coverageTool;}
        this.options.events.phase({ kind: 'settingUpCoverage' });
        return installCoverageTool(config.dotnet, this.options.tools, options);
    }

    private async publishCoverage(signal?: AbortSignal): Promise<void> {
        for (;;) {
            const hashes = this.hashes;
            await this.coverage.summarizeAsync(hashes, signal);
            if (hashes === this.hashes) {break;}
        }
        this.options.events.coverage();
    }

    private async save(signal?: AbortSignal): Promise<void> {
        const delta = await this.coverage.takeDeltaAsync(signal);
        try {await this.cache.save(delta, signal);}
        catch (error) {this.coverage.retryDelta(delta);signal?.throwIfAborted(); this.options.events.output(`Coverage could not be saved; current test results remain available. ${String(error)}\n`);}
    }
}
