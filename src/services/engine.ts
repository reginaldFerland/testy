import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { Project, TestFile, TestResult, Trace } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection } from '../core/selection';
import { contentHash, defaultExcludes, isConfigurationFile, isExcluded, normalizePath, sourceVersion, testTargetKey } from '../core/paths';
import { buildOrder, buildRoots, buildWaves, buildSnapshotTargets, buildProjects, mergeProjects, evaluateProjects, restoreProjects, findProjects, refreshProjectSnapshotBatches, sdkContextGroups, sdkConfigurationFiles } from './projects';
import { Cancelled, ProcessOptions, requireSuccess, runProcess } from './process';
import { projectCoverageId, RunnerOptions, RunnerSession } from './runner';
import { resolveShapes, sourceAliases, sourceAnalyses, SourceShape } from './analysis';
import { SourceTracker } from './sources';
import { CoverageCache } from './cache';
import { discoveredTest } from './mtp';
import { installCoverageTool } from './coverageTool';
import { claimRunOutputs, reclaimRunOutputs } from './runOutputs';
import { copyOutput } from './output';
import { mapConcurrent, resolveConcurrency, SerialQueue } from '../core/concurrency';

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
}
export interface EngineEvents {
    readonly output: (text: string) => void;
    readonly phase: (message: string) => void;
    readonly inputsChanged?: () => void;
    readonly discovered: (groups: readonly TestFile[]) => void | Promise<void>;
    readonly selected: (selection: Selection) => void;
    readonly result: (group: TestFile, result: TestResult) => void;
    readonly started: (group: TestFile, id: string) => void;
    readonly coverage: () => void;
    readonly invalidated: (files: readonly string[]) => void;
    readonly prepared?: (project: string) => void;
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
}
export interface ManualSelection {
    readonly groups: ReadonlySet<string>;
    readonly all?: boolean;
    readonly projects?: ReadonlySet<string>;
    readonly exclude?: Omit<ManualSelection, 'exclude' | 'coverage'>;
    readonly tests?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly coverage?: boolean;
}
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
    private readonly pendingChanges = new Set<string>();
    private projectSnapshots: ReadonlyMap<string, readonly Project[]> = new Map();
    private inputTopology = 0;
    private inputs: readonly string[] = [];
    private inputDirectories: readonly string[] = [];

    constructor(private readonly options: EngineOptions) {
        this.roots = options.roots.map(normalizePath);
        this.cache = new CoverageCache(options.storage, options.events.output);
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
        await reclaimRunOutputs(path.join(this.options.storage, 'runs'), signal);
        try {await this.cache.restore(this.coverage, signal);}
        catch (error) {
            signal?.throwIfAborted();
            if ((error as Error)?.name === 'AbortError') {throw error;}
            this.options.events.output(`Coverage cache unavailable; starting a fresh baseline. ${String(error)}\n`);
        }
    }

    async run(batch: ChangeBatch, signal: AbortSignal, manual?: ManualSelection, manualOperation = false): Promise<RunSummary> {
        signal.throwIfAborted();
        const controller = new AbortController();
        const abort = (): void => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        try {return await this.runBatch(batch, controller, manual, manualOperation);}
        finally {signal.removeEventListener('abort', abort);}
    }

    private async runBatch(batch: ChangeBatch, controller: AbortController, manual?: ManualSelection, manualOperation = false): Promise<RunSummary> {
        const signal = controller.signal;
        const began = Date.now(), events = this.options.events, topology = this.topology;
        const configured = this.options.configuration(), config = { ...configured, coverage: manual?.coverage ?? configured.coverage };
        const projectLimit = resolveConcurrency(config.maxParallelProjects), testLimit = resolveConcurrency(config.maxParallelTestFiles);
        events.output(`Testy concurrency: projects=${projectLimit}, test files=${testLimit}.\n`);
        let phaseName: string | undefined, phaseBegan = began;
        const finishPhase = (): void => {
            if (phaseName) {events.output(`Testy timing: ${phaseName} ${Date.now() - phaseBegan}ms\n`); phaseName = undefined;}
        };
        const phase = (name: string): void => {finishPhase(); phaseName = name; phaseBegan = Date.now(); events.phase(name);};
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
        const previousIndex = this.index;
        const structural = !!manual || this.structureDirty || newBaseline || changes.some(file => isConfigurationFile(file) || !this.index.hasSource(file) || !this.hashes.has(file));
        if (structural) {
            phase('Preparing projects');
            if (newBaseline || changes.some(isConfigurationFile)) {this.sdkContexts.clear(); this.restored.clear();}
            const selected = manual && !manual.all ? [...new Set([...manual.projects ?? [], ...this.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])] : undefined;
            const entryPoints = await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes], signal, 16);
            // SDK selection can fail before MSBuild can describe any inputs.
            // Keep its candidate paths observable so a corrected pin can recover.
            this.setInputs([...this.inputs, ...entryPoints, ...entryPoints.flatMap(sdkConfigurationFiles)
                .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot))]);
            const snapshots = await refreshProjectSnapshotBatches(this.projectSnapshots, entryPoints, selected, async files => {
                const contexts = await sdkContextGroups(files, signal);
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
                const workers = Math.min(projectLimit, contexts.length);
                const graphs = await mapConcurrent(contexts, projectLimit, signal, async (context, _index, workerSignal) => {
                    const graph = await evaluateProjects(config.dotnet, context.files, config.configuration,
                        { ...processOptions, cwd: context.cwd, signal: workerSignal }, this.options.analyzer, Math.max(1, Math.floor(projectLimit / workers)));
                    return [...graph];
                });
                return new Map(graphs.flat());
            });
            if (topology !== this.topology) {throw new Cancelled();}
            this.projectSnapshots = snapshots;
            const evaluated = [...snapshots.values()].flat();
            // Exclusions control inventory and watching. MSBuild still writes
            // required excluded dependencies, so their conflicts stay in its plan.
            this.buildGraph = mergeProjects(evaluated);
            this.projects = mergeProjects(evaluated.filter(project => !isExcluded(project.file, config.excludes, rootSnapshot)));
            this.index = new ProjectIndex(this.projects); this.structureDirty = !!manual;
            this.sources.setFiles(this.projects.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []])
                .filter(file => !isExcluded(file, [...defaultExcludes, ...config.excludes], rootSnapshot)),
            this.projects.flatMap(project => project.analysisFiles ?? project.sourceFiles));
            this.setInputs([...this.sources.files, ...this.projects.map(project => project.file)]);
            await this.sources.refresh(this.sources.files, signal);
            const eligible = new Set(this.projects.filter(project => project.isTestProject && project.entryPoint !== false)
                .map(project => testTargetKey(project.file, project.framework)));
            const retained = this.groups.filter(group => eligible.has(testTargetKey(group.project, group.framework)));
            if (retained.length !== this.groups.length || [...this.runtimeGroups.values()].some(group => !eligible.has(testTargetKey(group.project, group.framework)))) {
                // A library/reference can remain in the build graph without
                // remaining a test target. Retire it even if the next build fails.
                await this.reconcileGroups(retained, baseline);
                await this.save(signal);
            }
        }
        const beforeBuild = this.hashes;
        await this.publishCoverage(signal);
        const relevant = manual ? new Set(manual.all ? this.projects.map(project => project.file) : [...manual.projects ?? [], ...this.displayGroups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
            : newBaseline || config.mode === 'all' ? new Set(this.projects.map(project => project.file)) : this.index.affected(changes);
        if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
        const anticipated = this.select(changes);
        for (const group of this.groups) {
            if (!manual && (anticipated.groups.includes(group) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
        }
        const closure = buildOrder(this.buildGraph, relevant);
        const builds = buildRoots(closure);
        const visibleTargets = new Set(this.projects.filter(project => project.isTestProject && project.entryPoint !== false)
            .map(project => testTargetKey(project.file, project.framework)));
        const testBuilds = builds.filter(project => project.isTestProject && project.entryPoint !== false
            && visibleTargets.has(testTargetKey(project.file, project.framework)));
        const sharedOutputs = buildSnapshotTargets(closure, builds);
        const snapshots = new Map<string, string>();
        const outputLease = await claimRunOutputs(path.join(this.options.storage, 'runs'), this.identity, signal);
        let sessions: RunnerSession | undefined;
        try {
            phase('Building');
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
                if (builds.length > wave.length) {events.output(`Build wave complete: ${wave.length} roots; dependency or output conflicts require ordered waves.\n`);}
            }
            const changedDuringBuild = await this.sources.refresh(builtInputs, signal);
            const obsoleteBuild = changedDuringBuild.some(file => !this.sources.isGenerated(file) && beforeBuild.get(file) !== this.hashes.get(file));
            if (obsoleteBuild && !manual && !manualOperation) {events.invalidated(changedDuringBuild); throw new Cancelled();}
            // A target can add a generated header to a pre-existing placeholder.
            // Exclude its old hash from analysis and coverage attribution as well.
            const before = changedDuringBuild.some(file => this.sources.isGenerated(file))
                ? new Map([...beforeBuild].filter(([file]) => !this.sources.isGenerated(file))) : beforeBuild;
            const previousShapes = baseline?.shapes ?? this.shapes;
            phase('Analyzing sources');
            const analysisHashes = this.sources.analysisHashes;
            let shapeFiles = [...analysisHashes.keys()].filter(file => newBaseline || !this.analyses.has(file) || analysisHashes.get(file) !== this.analyzedHashes.get(file));
            let nextAnalyses: ReadonlyMap<string, SourceShape | null>;
            try {
                const candidates = [...this.sources.aliasSources].sort(([a], [b]) => a.localeCompare(b));
                const stamp = contentHash(JSON.stringify(candidates));
                if (stamp !== this.aliasStamp) {
                    const aliases = await sourceAliases(config.dotnet, this.options.analyzer, candidates.map(([, content]) => content), this.options.storage, processOptions);
                    if (JSON.stringify(aliases) !== JSON.stringify(this.excludedAliases)) {
                        shapeFiles = [...analysisHashes.keys()];
                    }
                    this.excludedAliases = aliases; this.aliasStamp = stamp;
                }
                nextAnalyses = await sourceAnalyses(config.dotnet, this.options.analyzer, shapeFiles, this.options.storage, processOptions, this.excludedAliases, projectLimit);
            }
            catch (error) {
                signal.throwIfAborted(); events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
                nextAnalyses = new Map(shapeFiles.map(file => [file, null]));
            }
            this.analyses = new Map([...this.analyses, ...nextAnalyses].filter(([file]) => analysisHashes.has(file)));
            this.analyzedHashes = analysisHashes;
            const currentShapes = resolveShapes(this.analyses, this.projects);
            const conservative = new Set(changes.filter(file => !currentShapes.get(file) || currentShapes.get(file) !== previousShapes.get(file)));
            let coverageTool: string | undefined;
            let runtimeTreeChanged = false;
            if (config.coverage && builds.some(project => project.isTestProject)) {
                phase('Setting up coverage');
                try {coverageTool = await this.ensureCoverageTool(config, processOptions);}
                catch (error) {signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);}
            }
            const runnerOptions: RunnerOptions = {
                ...processOptions, dotnet: config.dotnet, storage: path.join(this.options.storage, 'runs'),
                testArguments: config.testArguments, coverageTool, assemblies: this.projects.flatMap(project => project.assemblies ?? [project.assembly]), analyzer: this.options.analyzer, identity: this.identity,
                modules: this.projects.flatMap(project => (project.contexts ?? [project]).map(context => ({
                    name: context.assemblyName ?? path.basename(context.assembly, path.extname(context.assembly)), project: project.file,
                    sources: [...project.sourceFiles, ...project.inputs ?? []]
                }))),
                outputRoot: outputLease.directory, snapshots,
                buildInputs: new Map(this.projects.filter(project => project.isTestProject).map(project => [project.file,
                    [...new Set(buildOrder(this.projects, new Set([project.file])).flatMap(input => [...input.inputs ?? []]))]])),
                onResult: (group, result, test) => {
                    if (group.runtimeOnly) {
                        if (!this.runtimeGroups.has(group.id)) {runtimeTreeChanged = true;}
                        this.runtimeGroups.set(group.id, group);
                    } else {
                        for (const [id, unknown] of this.runtimeGroups) {
                            if (testTargetKey(group.project, group.framework) !== testTargetKey(unknown.project, unknown.framework)) {continue;}
                            const runtime = this.runtime.get(id);
                            if (runtime?.delete(result.id)) {
                                this.knownCache.delete(id); runtimeTreeChanged = true;
                                if (!runtime.size) {this.runtimeGroups.delete(id); this.runtime.delete(id);}
                            }
                        }
                    }
                    if (result.node && !this.discoveredIds.get(group.id)?.has(result.id)) {
                        const nodes = this.runtime.get(group.id) ?? new Map(); nodes.set(result.id, test ?? discoveredTest(result.node as { uid: string })); this.runtime.set(group.id, nodes);
                        this.knownCache.delete(group.id);
                    }
                    events.result(group, result);
                }, onStarted: events.started, onPrepared: events.prepared,
                onExpanded: groups => events.selected({ groups, reason: 'Containing files for provider runtime identities', fallback: true })
            };
            sessions = new RunnerSession(runnerOptions);
            phase('Discovering tests');
            const next = this.groups.filter(group => !testBuilds.some(project => project.file === group.project && project.framework === group.framework)
                && this.projects.some(project => project.file === group.project && project.framework === group.framework && project.isTestProject && project.entryPoint !== false));
            let discoveredProjects = 0, activeDiscoveries = 0;
            const discoveryProgress = (): void => events.phase(`Discovering tests ${discoveredProjects}/${testBuilds.length} · ${activeDiscoveries} active`);
            const inventories = await mapConcurrent(testBuilds, projectLimit, signal, async project => {
                activeDiscoveries++; discoveryProgress();
                try {const groups = await sessions!.discover(project); discoveredProjects++; return groups;}
                finally {activeDiscoveries--; discoveryProgress();}
            }, () => controller.abort());
            next.push(...inventories.flat());
            const liveIds = await this.reconcileGroups(next, baseline);
            const checkpointInputs = new Map(before);
            if (baseline) {for (const file of changes) {
                if (checkpointInputs.has(file)) {continue;}
                try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
                catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
            }}
            const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
            const oldImpact = selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, previousIndex, file => this.coverage.dependentGroups([file]), project => this.coverage.dependentProjects([project]));
            const nextImpact = selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, this.index, file => this.coverage.dependentGroups([file]), project => this.coverage.dependentProjects([project]));
            const impact = { ...nextImpact, groups: [...new Map([...oldImpact.groups, ...nextImpact.groups].map(group => [group.id, group])).values()] };
            if (baseline) {
                for (const group of impact.groups) {baseline.completed.delete(group.id); baseline.runtimeResults.delete(group.id);}
                baseline.shapes = currentShapes; baseline.inputs = checkpointInputs;
            }
            let selection: Selection;
            if (manual) {
                selection = { groups: selectManual(this.displayGroups, manual, group => this.knownTests(group)), reason: 'Manual run', fallback: false };
                if ((manual.groups.size || manual.projects?.size) && !manual.exclude && !selection.groups.length) {throw new Error('The selected tests changed during discovery. Select them again from the refreshed Test Explorer.');}
            } else if (baseline) {
                const affected = new Set(impact.groups.map(group => group.id));
                const pending = this.groups.filter(group => !baseline.completed.has(group.id));
                // During learning, finish unaffected files before returning to a file
                // that ongoing edits keep cancelling.
                pending.sort((a, b) => Number(affected.has(a.id)) - Number(affected.has(b.id)));
                selection = { groups: pending, reason: `Baseline (${baseline.completed.size}/${this.groups.length} files complete)`, fallback: false };
            } else {selection = impact;}
            if (manual) {selection = { ...selection, groups: await sessions.resolveSelection(selection.groups) };}
            const selectedIds = new Set(selection.groups.map(group => group.id));
            const fresh = new Set([...this.coverage.traces].filter(([id, trace]) => !selectedIds.has(id)
                && Object.entries(trace.inputs ?? {}).every(([file, hash]) => sourceVersion(before, file) === hash)).map(([id]) => id));
            this.coverage.markStale(fresh, false);
            events.selected(selection); await this.publishCoverage(signal);
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
            let available = !!coverageTool;
            const commits = new SerialQueue();
            let completed = 0, active = 0;
            const allowSecondary = !manual || (!manual.exclude && !manual.tests && ![...manual.groups].some(id => this.runtimeGroups.has(id)));
            const progress = (): void => events.phase(`Testing ${completed}/${batches.length} · ${active} active${baseline ? ` · ${baseline.completed.size}/${this.groups.length} files learned` : ''}`);
            phase('Testing');
            await mapConcurrent(batches, testLimit, signal, async (requestedGroups, _index, _workerSignal, worker) => {
                active++; progress();
                try {
                    const run = await sessions!.run(requestedGroups, before, allowSecondary ? worker + 1 : 0), groups = run.executedGroups;
                    await commits.run(async () => {
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
                            runtimeTreeChanged ||= removed;
                        } else {
                            // A partial manual run may reveal another deferred row, but
                            // cannot retire rows from an earlier complete checkpoint.
                            for (const group of groups) {
                                const previous = runtimeResults.get(group.id);
                                if (previous) {runtimeResults.set(group.id, new Set([...previous, ...run.results.map(result => result.id)]));}
                            }
                        }
                        if (runtimeTreeChanged) {runtimeTreeChanged = false; await events.discovered(this.displayGroups);}
                        if (run.coverageAvailable && complete) {
                            if (groups.length > 1) {for (const group of groups) {liveIds.delete(group.id);}}
                            else {
                                // The old aggregate cannot be split into file ownership.
                                // Retain it as history while publishing the new file trace.
                                this.coverage.markHistorical(new Set([projectCoverageId(groups[0])]));
                            }
                            await this.coverage.replaceAsync([run.trace], liveIds, signal);
                            if (revision !== this.sources.revision) {this.coverage.markStale(new Set([run.trace.groupId]));}
                            const aggregate = projectCoverageId(groups[0]);
                            if (groups.length === 1 && this.coverage.traces.has(aggregate)
                                && projectGroups.get(testTargetKey(groups[0].project, groups[0].framework))!.every(group => {
                                    const trace = this.coverage.traces.get(group.id); return trace && !trace.stale;
                                })) {
                                liveIds.delete(aggregate); this.coverage.replace([], liveIds);
                            }
                        } else if (!manual) {
                            // Preserve previous coverage and its freshness state. No
                            // collection means no new narrowing information was learned.
                            for (const group of groups) {
                                if (this.coverage.traces.has(group.id)) {this.coverage.invalidate(new Set([group.id]), false);}
                                else {this.coverage.replace([{ groupId: group.id, dependencies: group.file ? [group.file] : [], coverage: [], reliable: false, timestamp: Date.now(), inputs: {} }], liveIds);}
                            }
                        }
                        if (complete && (!manual || !configured.coverage || run.coverageAvailable)) {for (const group of groups) {baseline?.completed.add(group.id);}}
                        await this.publishCoverage(signal); await this.save(signal);
                    });
                    completed++;
                } finally {active--; progress();}
            }, () => controller.abort());
            signal.throwIfAborted();
            if (!manual) {
                this.shapes = currentShapes;
                if (!baseline || this.groups.every(group => baseline.completed.has(group.id))) {
                    this.initialized = true; this.baseline = undefined;
                    for (const file of changes) {this.pendingChanges.delete(file);}
                }
            }
            await this.publishCoverage(signal); await this.save(signal);
            return { files: executedFiles.size, tests: results.length, passed: results.filter(result => result.outcome === 'passed').length,
                failed: results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length,
                skipped: results.filter(result => result.outcome === 'skipped').length, duration: Date.now() - began, coverageAvailable: available };
        } finally {finishPhase(); try {await sessions?.dispose();} finally {await outputLease.dispose();}}
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

    private async ensureSdk(dotnet: string, options: ProcessOptions, sdkContext = options.cwd): Promise<void> {
        const key = `${dotnet}\0${sdkContext}`; if (this.sdkContexts.has(key)) {return;}
        const existing = this.sdkChecks.get(key); if (existing) {return existing;}
        const check = (async () => {
            const version = requireSuccess(await runProcess(dotnet, ['--version'], { ...options, output: undefined }), `Finding the .NET SDK for ${options.cwd}`).stdout.trim();
            if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 10) {throw new Error(`Testy requires .NET SDK 10 or later; ${options.cwd} selects ${version}. Check its global.json.`);}
            this.sdkContexts.add(key);
        })();
        this.sdkChecks.set(key, check);
        try {await check;} finally {this.sdkChecks.delete(key);}
    }

    private async ensureCoverageTool(config: EngineConfiguration, options: ProcessOptions): Promise<string> {
        if (config.coverageTool) {await fs.access(config.coverageTool); return config.coverageTool;}
        this.options.events.phase('Setting up coverage');
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
