import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { Project, TestFile, TestResult, Trace } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection } from '../core/selection';
import { contentHash, defaultExcludes, isConfigurationFile, isExcluded, normalizePath } from '../core/paths';
import { buildOrder, buildRoots, mergeProjects, evaluateProject, findProjects } from './projects';
import { Cancelled, ProcessOptions, requireSuccess, runProcess } from './process';
import { projectCoverageId, RunnerOptions, RunnerSession } from './runner';
import { resolveShapes, sourceAnalyses, SourceShape } from './analysis';
import { SourceTracker } from './sources';
import { CoverageCache } from './cache';
import { discoveredTest } from './mtp';
import { installCoverageTool } from './coverageTool';

export interface EngineConfiguration {
    readonly dotnet: string;
    readonly configuration: string;
    readonly mode: 'affected' | 'all';
    readonly coverage: boolean;
    readonly excludes: readonly string[];
    readonly testArguments: readonly string[];
    readonly timeout: number;
    readonly coverageTool?: string;
}
export interface EngineEvents {
    readonly output: (text: string) => void;
    readonly phase: (message: string) => void;
    readonly discovered: (groups: readonly TestFile[]) => void;
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
    return groups.filter(group => matches(manual, group)).map(group => {
        const entire = manual.all || manual.projects?.has(group.project) || !manual.tests?.has(group.id);
        const requested = manual.tests?.get(group.id), excluded = manual.exclude;
        const excludesGroup = excluded && matches(excluded, group);
        const excludedTests = excluded?.tests?.get(group.id);
        const excludesEntire = excludesGroup && (excluded.all || excluded.projects?.has(group.project) || !excludedTests);
        return { ...group, tests: known(group).filter(test => !excludesEntire && (entire || requested?.has(test.id)) && (!excludesGroup || !excludedTests?.has(test.id))) };
    }).filter(group => group.tests.length);
}

interface Baseline { readonly generation: string | number; readonly completed: Set<string>; shapes: ReadonlyMap<string, string | null>; inputs: ReadonlyMap<string, string>; }

export class TestEngine {
    readonly coverage = new CoverageStore();
    readonly sources = new SourceTracker();
    projects: readonly Project[] = [];
    groups: readonly TestFile[] = [];
    private roots: readonly string[];
    private index = new ProjectIndex([]);
    private initialized = false;
    private structureDirty = true;
    private topology = 0;
    private baseline: Baseline | undefined;
    private shapes: ReadonlyMap<string, string | null> = new Map();
    private analyses: ReadonlyMap<string, SourceShape | null> = new Map();
    private readonly sdkContexts = new Set<string>();
    private readonly restored = new Set<string>();
    private readonly runtime = new Map<string, Map<string, ReturnType<typeof discoveredTest>>>();
    private readonly discoveredIds = new Map<string, ReadonlySet<string>>();
    private readonly cache: CoverageCache;
    private readonly identity = randomUUID();
    private readonly pendingChanges = new Set<string>();

    constructor(private readonly options: EngineOptions) {
        this.roots = options.roots.map(normalizePath);
        this.cache = new CoverageCache(options.storage, options.events.output);
    }

    get hashes(): ReadonlyMap<string, string> { return this.sources.hashes; }
    get knownFiles(): readonly string[] { return [...this.sources.files, ...this.projects.map(project => project.file)]; }
    get directories(): readonly string[] { return [...new Set(this.knownFiles.map(file => path.dirname(file)))]; }
    get baselineProgress(): { completed: number; total: number } | undefined {
        return this.baseline ? { completed: this.baseline.completed.size, total: this.groups.length } : undefined;
    }

    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[] {
        return [...new Map([...group.tests, ...this.runtime.get(group.id)?.values() ?? []].map(test => [test.id, test])).values()];
    }

    setRoots(roots: readonly string[]): void {
        this.roots = roots.map(normalizePath); this.topology++; this.structureDirty = true;
        this.sources.mark([]); this.coverage.markStale(new Set(this.coverage.traces.keys()));
    }

    select(files: readonly string[], conservative = false): Selection {
        return selectTests(this.groups, this.projects, this.coverage.traces, files, this.options.configuration().mode, false,
            conservative ? new Set(files) : new Set(), this.index, file => this.coverage.dependentGroups([file]));
    }

    /** Normal event handling only marks versions; it performs no source-tree I/O. */
    async markChanged(files?: readonly string[]): Promise<void> {
        if (!files) {files = await this.sources.refresh(this.sources.files);}
        this.sources.mark(files);
        const selected = this.select(files, true);
        this.coverage.markStale(new Set([...selected.groups.map(group => group.id), ...this.coverage.dependentGroups(files)]));
        this.options.events.coverage();
    }

    async restore(signal?: AbortSignal): Promise<void> { await this.cache.restore(this.coverage, signal); }

    async run(batch: ChangeBatch, signal: AbortSignal, manual?: ManualSelection, manualOperation = false): Promise<RunSummary> {
        const began = Date.now(), events = this.options.events, topology = this.topology;
        const configured = this.options.configuration(), config = { ...configured, coverage: manual?.coverage ?? configured.coverage };
        const reserved = ['--server', '--client-port', '--client-host', '--list-tests', '--filter-uid', '--filter', '--treenode-filter', '--results-directory', '--ignore-exit-code', '--help', '--info'];
        if (config.testArguments.some(argument => reserved.some(option => argument === option || argument.startsWith(`${option}=`)))) {
            throw new Error('testy.testArguments contains an option reserved for test discovery, selection, or communication. Remove runner/filter options from that setting.');
        }
        const full = batch.full || !this.initialized || !!this.baseline;
        const generation = batch.generation ?? (batch.full ? randomUUID() : this.baseline?.generation ?? randomUUID());
        const newBaseline = full && this.baseline?.generation !== generation;
        if (newBaseline) {this.baseline = { generation, completed: new Set(), shapes: this.shapes, inputs: new Map() };}
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
            events.phase('Preparing projects');
            if (newBaseline || changes.some(isConfigurationFile)) {this.sdkContexts.clear(); this.restored.clear();}
            const queue = manual && !manual.all ? [...new Set([...manual.projects ?? [], ...this.groups.filter(group => manual.groups.has(group.id)).map(group => group.project)])]
                : [...await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes], signal)];
            const seen = new Set<string>(), projects: Project[] = [];
            for (let index = 0; index < queue.length; index++) {
                signal.throwIfAborted();
                const file = queue[index]; if (seen.has(file)) {continue;} seen.add(file);
                const options = { ...processOptions, cwd: path.dirname(file) };
                await this.ensureSdk(config.dotnet, options);
                const restoreKey = `${config.dotnet}\0${config.configuration}\0${file}`;
                if (!this.restored.has(restoreKey)) {
                    requireSuccess(await runProcess(config.dotnet, ['restore', file, `-property:Configuration=${config.configuration}`, '--nologo'], options), `Restoring ${path.basename(file)}`);
                    this.restored.add(restoreKey);
                }
                const targets = await evaluateProject(config.dotnet, file, config.configuration, options, this.options.analyzer);
                projects.push(...targets.filter(project => !isExcluded(project.file, config.excludes, rootSnapshot)));

            }
            if (topology !== this.topology) {throw new Cancelled();}
            this.projects = mergeProjects(manual ? [...this.projects.filter(project => !seen.has(project.file)), ...projects] : projects);
            this.index = new ProjectIndex(this.projects); this.structureDirty = !!manual;
            this.sources.setFiles(this.projects.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []]));
            await this.sources.refresh(this.sources.files, signal);
        }
        const before = this.hashes;
        events.coverage();
        const relevant = manual ? new Set(manual.all ? this.projects.map(project => project.file) : [...manual.projects ?? [], ...this.groups.filter(group => manual.groups.has(group.id)).map(group => group.project)])
            : newBaseline || config.mode === 'all' ? new Set(this.projects.map(project => project.file)) : this.index.affected(changes);
        if (!manual) {for (const project of previousIndex.affected(changes)) {relevant.add(project);}}
        const anticipated = this.select(changes);
        for (const group of this.groups) {
            if (!manual && (anticipated.groups.includes(group) || (baseline && !baseline.completed.has(group.id)))) {relevant.add(group.project);}
        }
        const closure = buildOrder(this.projects, relevant);
        const builds = buildRoots(closure);
        events.phase('Building');
        const builtInputs = [...new Set(closure.flatMap(project => [...project.sourceFiles, ...project.inputs ?? []]))];
        const revision = this.sources.revision;
        for (const project of builds) {
            const options = { ...processOptions, cwd: path.dirname(project.file) };
            await this.ensureSdk(config.dotnet, options);
            requireSuccess(await runProcess(config.dotnet, ['build', project.file, '--framework', project.framework, '--configuration', config.configuration,
                '--no-restore', '--nologo'], options), `Building ${path.basename(project.file)}`);
        }
        const changedDuringBuild = await this.sources.refresh(builtInputs, signal);
        const obsoleteBuild = changedDuringBuild.some(file => before.get(file) !== this.hashes.get(file));
        if (obsoleteBuild && !manual && !manualOperation) {events.invalidated(changedDuringBuild); throw new Cancelled();}
        const previousShapes = baseline?.shapes ?? this.shapes;
        const shapeFiles = [...before.keys()].filter(file => file.endsWith('.cs') && (newBaseline || !previousShapes.has(file) || changes.includes(file)));
        let nextAnalyses: ReadonlyMap<string, SourceShape | null>;
        try { nextAnalyses = await sourceAnalyses(config.dotnet, this.options.analyzer, shapeFiles, this.options.storage, processOptions, this.sources.excludedAliases); }
        catch (error) {
            signal.throwIfAborted(); events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
            nextAnalyses = new Map(shapeFiles.map(file => [file, null]));
        }
        this.analyses = new Map([...this.analyses, ...nextAnalyses].filter(([file]) => before.has(file)));
        const currentShapes = resolveShapes(this.analyses, this.projects);
        const conservative = new Set(changes.filter(file => !currentShapes.get(file) || currentShapes.get(file) !== previousShapes.get(file)));
        let coverageTool: string | undefined;
        if (config.coverage && builds.some(project => project.isTestProject)) {
            try {coverageTool = await this.ensureCoverageTool(config, processOptions);}
            catch (error) {signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);}
        }
        const runnerOptions: RunnerOptions = {
            ...processOptions, dotnet: config.dotnet, storage: path.join(this.options.storage, 'runs'),
            testArguments: config.testArguments, coverageTool, assemblies: this.projects.flatMap(project => project.assemblies ?? [project.assembly]), analyzer: this.options.analyzer, identity: this.identity,
            buildInputs: new Map(this.projects.filter(project => project.isTestProject).map(project => [project.file,
                [...new Set(buildOrder(this.projects, new Set([project.file])).flatMap(input => [...input.inputs ?? []]))]])),
            onResult: (group, result) => {
                if (result.node && !this.discoveredIds.get(group.id)?.has(result.id)) {
                    const nodes = this.runtime.get(group.id) ?? new Map(); nodes.set(result.id, discoveredTest(result.node as { uid: string })); this.runtime.set(group.id, nodes);
                }
                events.result(group, result);
            }, onStarted: events.started, onPrepared: events.prepared,
            onExpanded: groups => events.selected({ groups, reason: 'Containing files for provider runtime identities', fallback: true })
        };
        const sessions = new RunnerSession(runnerOptions);
        try {
            events.phase('Discovering tests');
            const testBuilds = builds.filter(project => project.isTestProject);
            const next = this.groups.filter(group => !testBuilds.some(project => project.file === group.project && project.framework === group.framework)
                && this.projects.some(project => project.file === group.project && project.framework === group.framework));
            for (const project of testBuilds) {next.push(...await sessions.discover(project));}
            const oldGroups = new Map(this.groups.map(group => [group.id, group]));
            const identitiesChanged = new Set(next.filter(group => {
                const previous = oldGroups.get(group.id);
                return previous && previous.tests.map(test => test.id).sort().join('\0') !== group.tests.map(test => test.id).sort().join('\0');
            }).map(group => group.id));
            for (const id of identitiesChanged) {baseline?.completed.delete(id); this.runtime.delete(id);}
            this.coverage.invalidate(identitiesChanged); this.groups = next;
            this.discoveredIds.clear();
            for (const group of next) {this.discoveredIds.set(group.id, new Set(group.tests.map(test => test.id)));}
            const groupIds = new Set(next.map(group => group.id));
            for (const id of this.runtime.keys()) {if (!groupIds.has(id)) {this.runtime.delete(id);}}
            for (const id of baseline?.completed ?? []) {if (!groupIds.has(id)) {baseline?.completed.delete(id);}}
            const liveIds = new Set([...next.map(group => group.id), ...next.map(projectCoverageId)]);
            this.coverage.replace([], liveIds); events.discovered(this.groups);
            const checkpointInputs = new Map(before);
            if (baseline) {for (const file of changes) {
                if (checkpointInputs.has(file)) {continue;}
                try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
                catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
            }}
            const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
            const oldImpact = selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, previousIndex, file => this.coverage.dependentGroups([file]));
            const nextImpact = selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, this.index, file => this.coverage.dependentGroups([file]));
            const impact = { ...nextImpact, groups: [...new Map([...oldImpact.groups, ...nextImpact.groups].map(group => [group.id, group])).values()] };
            if (baseline) {for (const group of impact.groups) {baseline.completed.delete(group.id);} baseline.shapes = currentShapes; baseline.inputs = checkpointInputs;}
            let selection: Selection;
            if (manual) {
                selection = { groups: selectManual(this.groups, manual, group => this.knownTests(group)), reason: 'Manual run', fallback: false };
                if ((manual.groups.size || manual.projects?.size) && !manual.exclude && !selection.groups.length) {throw new Error('The selected tests changed during discovery. Select them again from the refreshed Test Explorer.');}
            } else if (baseline) {
                const affected = new Set(impact.groups.map(group => group.id));
                const pending = this.groups.filter(group => !baseline.completed.has(group.id));
                // During learning, finish unaffected files before returning to a file
                // that ongoing edits keep cancelling.
                pending.sort((a, b) => Number(affected.has(a.id)) - Number(affected.has(b.id)));
                selection = { groups: pending, reason: `Baseline (${baseline.completed.size}/${this.groups.length} files complete)`, fallback: false };
            } else {selection = impact;}
            const selectedIds = new Set(selection.groups.map(group => group.id));
            const fresh = new Set([...this.coverage.traces].filter(([id, trace]) => !selectedIds.has(id)
                && Object.entries(trace.inputs ?? {}).every(([file, hash]) => before.get(file) === hash)).map(([id]) => id));
            this.coverage.markStale(fresh, false);
            events.selected(selection); events.coverage();
            const batches: TestFile[][] = [];
            const originalGroups = new Map(this.groups.map(group => [group.id, group]));
            const projectGroups = new Map<string, TestFile[]>();
            for (const group of this.groups) {const groups = projectGroups.get(group.assembly) ?? []; groups.push(group); projectGroups.set(group.assembly, groups);}
            const completeFiles = new Set(selection.groups.filter(group => {
                const requested = new Set(group.tests.map(test => test.id)), original = originalGroups.get(group.id);
                return original && original.tests.every(test => requested.has(test.id));
            }).map(group => group.id));
            const completeProjects = new Set(selection.groups.map(group => group.assembly));
            for (const group of this.groups) {if (!completeFiles.has(group.id)) {completeProjects.delete(group.assembly);}}
            for (const group of selection.groups) {
                // A partial project run needs separate contributions; replacing its
                // aggregate would erase the coverage of unselected files.
                const batchProjects = !coverageTool || (config.mode === 'all' && completeProjects.has(group.assembly));
                const existing = batchProjects ? batches.find(items => items[0].assembly === group.assembly) : undefined;
                if (existing) {existing.push(group);} else {batches.push([group]);}
            }
            const results: TestResult[] = [];
            let available = !!coverageTool;
            for (let index = 0; index < batches.length; index++) {
                const requestedGroups = batches[index];
                events.phase(`Testing ${index + 1}/${batches.length}${baseline ? ` · ${baseline.completed.size}/${this.groups.length} files learned` : ''}`);
                const run = await sessions.run(requestedGroups, before), groups = run.executedGroups;
                results.push(...run.results); available &&= run.coverageAvailable;
                signal.throwIfAborted();
                await this.sources.refresh(run.trace.dependencies, signal);
                const current = topology === this.topology && !obsoleteBuild && revision === this.sources.revision
                    && Object.entries(run.trace.inputs ?? {}).every(([file, hash]) => this.hashes.get(file) === hash);
                if (!current) {
                    this.coverage.markStale(new Set(groups.map(group => group.id)));
                    if (!manual && !manualOperation) {events.invalidated(changes); throw new Cancelled();}
                    continue;
                }
                const complete = groups.every(group => {
                    const requested = new Set(group.tests.map(test => test.id));
                    return originalGroups.get(group.id)?.tests.every(test => requested.has(test.id));
                });
                if (complete) {
                    const reported = new Set(run.results.map(result => result.id));
                    let removed = false;
                    for (const group of groups) {
                        const runtime = this.runtime.get(group.id);
                        for (const id of runtime?.keys() ?? []) {if (!reported.has(id)) {runtime!.delete(id); removed = true;}}
                    }
                    if (removed) {events.discovered(this.groups);}
                }
                if (run.coverageAvailable && complete) {
                    if (groups.length > 1) {for (const group of groups) {liveIds.delete(group.id);}}
                    else {
                        // The old aggregate cannot be split into file ownership.
                        // Retain it as history while publishing the new file trace.
                        this.coverage.markHistorical(new Set([projectCoverageId(groups[0])]));
                    }
                    this.coverage.replace([run.trace], liveIds);
                    const aggregate = projectCoverageId(groups[0]);
                    if (groups.length === 1 && this.coverage.traces.has(aggregate)
                        && projectGroups.get(groups[0].assembly)!.every(group => {
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
                events.coverage(); await this.save(signal);
            }
            signal.throwIfAborted();
            if (!manual) {
                this.shapes = currentShapes;
                if (!baseline || this.groups.every(group => baseline.completed.has(group.id))) {
                    this.initialized = true; this.baseline = undefined;
                    for (const file of changes) {this.pendingChanges.delete(file);}
                }
            }
            events.coverage(); await this.save(signal);
            return { files: selection.groups.length, tests: results.length, passed: results.filter(result => result.outcome === 'passed').length,
                failed: results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length,
                skipped: results.filter(result => result.outcome === 'skipped').length, duration: Date.now() - began, coverageAvailable: available };
        } finally {await sessions.dispose();}
    }

    private async ensureSdk(dotnet: string, options: ProcessOptions): Promise<void> {
        const key = `${dotnet}\0${options.cwd}`; if (this.sdkContexts.has(key)) {return;}
        const version = requireSuccess(await runProcess(dotnet, ['--version'], { ...options, output: undefined }), `Finding the .NET SDK for ${options.cwd}`).stdout.trim();
        if (!/^\d+\./.test(version) || Number(version.split('.')[0]) < 10) {throw new Error(`Testy requires .NET SDK 10 or later; ${options.cwd} selects ${version}. Check its global.json.`);}
        this.sdkContexts.add(key);
    }

    private async ensureCoverageTool(config: EngineConfiguration, options: ProcessOptions): Promise<string> {
        if (config.coverageTool) {await fs.access(config.coverageTool); return config.coverageTool;}
        this.options.events.phase('Setting up coverage');
        return installCoverageTool(config.dotnet, this.options.tools, options);
    }

    private async save(signal?: AbortSignal): Promise<void> {
        const delta = this.coverage.takeDelta();
        try {await this.cache.save(delta, signal);}
        catch (error) {this.coverage.retryDelta(delta);signal?.throwIfAborted(); this.options.events.output(`Coverage could not be saved; current test results remain available. ${String(error)}\n`);}
    }
}
