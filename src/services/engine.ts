import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoverageStore } from '../core/coverage';
import { Project, TestFile, TestResult, Trace } from '../core/model';
import { ChangeBatch } from '../core/scheduler';
import { ProjectIndex, selectTests, Selection } from '../core/selection';
import { contentHash, defaultExcludes, isConfigurationFile, isExcluded, normalizePath } from '../core/paths';
import { buildOrder, evaluateProject, findProjects } from './projects';
import { Cancelled, ProcessOptions, requireSuccess, runProcess } from './process';
import { discover, projectCoverageId, RunnerOptions, RunnerSession } from './runner';
import { sourceShapes } from './analysis';
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
    readonly tests?: ReadonlyMap<string, ReadonlySet<string>>;
    readonly coverage?: boolean;
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
    private readonly sdkContexts = new Set<string>();
    private readonly restored = new Set<string>();
    private readonly runtime = new Map<string, Map<string, ReturnType<typeof discoveredTest>>>();
    private readonly cache: CoverageCache;

    constructor(private readonly options: EngineOptions) {
        this.roots = options.roots;
        this.cache = new CoverageCache(options.storage, options.events.output);
    }

    get hashes(): ReadonlyMap<string, string> { return this.sources.hashes; }
    get knownFiles(): readonly string[] { return [...this.sources.files, ...this.projects.map(project => project.file)]; }
    get directories(): readonly string[] { return [...new Set(this.projects.map(project => path.dirname(project.file)))]; }
    get baselineProgress(): { completed: number; total: number } | undefined {
        return this.baseline ? { completed: this.baseline.completed.size, total: this.groups.length } : undefined;
    }

    knownTests(group: TestFile): readonly ReturnType<typeof discoveredTest>[] {
        return [...new Map([...group.tests, ...this.runtime.get(group.id)?.values() ?? []].map(test => [test.id, test])).values()];
    }

    setRoots(roots: readonly string[]): void {
        this.roots = roots; this.topology++; this.structureDirty = true;
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

    async restore(): Promise<void> { await this.cache.restore(this.coverage); }

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
        const processOptions: ProcessOptions = { cwd: rootSnapshot[0] ?? this.options.storage, signal, output: events.output, timeoutMs: config.timeout };
        const sourceChanges = await this.sources.refresh(this.sources.files, signal);
        const changes = [...new Set([...batch.files.map(normalizePath), ...sourceChanges])];
        const structural = this.structureDirty || newBaseline || changes.some(file => isConfigurationFile(file) || !this.index.hasSource(file) || !this.hashes.has(file));
        if (structural) {
            events.phase('Preparing projects');
            if (newBaseline || changes.some(isConfigurationFile)) {this.sdkContexts.clear(); this.restored.clear();}
            const queue = [...await findProjects(rootSnapshot, [...defaultExcludes, ...config.excludes])];
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
                const targets = await evaluateProject(config.dotnet, file, config.configuration, options);
                projects.push(...targets);
                for (const reference of targets.flatMap(project => [...project.references])) {
                    if (!seen.has(reference) && !isExcluded(reference, config.excludes, rootSnapshot)) {queue.push(reference);}
                }
            }
            if (topology !== this.topology) {throw new Cancelled();}
            this.projects = projects; this.index = new ProjectIndex(projects); this.structureDirty = false;
            this.sources.setFiles(projects.flatMap(project => [...project.sourceFiles]));
            await this.sources.refresh(this.sources.files, signal);
        }
        const before = this.hashes;
        events.coverage();
        const relevant = newBaseline || config.mode === 'all' ? new Set(this.projects.map(project => project.file)) : this.index.affected(changes);
        const anticipated = this.select(changes);
        for (const group of this.groups) {
            if (anticipated.groups.includes(group) || manual?.groups.has(group.id) || (baseline && !baseline.completed.has(group.id))) {relevant.add(group.project);}
        }
        const builds = buildOrder(this.projects, relevant);
        events.phase('Building');
        const builtInputs = [...new Set(builds.flatMap(project => [...project.sourceFiles]))];
        const revision = this.sources.revision;
        for (const project of builds) {
            const options = { ...processOptions, cwd: path.dirname(project.file) };
            await this.ensureSdk(config.dotnet, options);
            requireSuccess(await runProcess(config.dotnet, ['build', project.file, '--framework', project.framework, '--configuration', config.configuration,
                '--no-restore', '--nologo', '-property:BuildProjectReferences=false'], options), `Building ${path.basename(project.file)}`);
        }
        const changedDuringBuild = await this.sources.refresh(builtInputs, signal);
        const obsoleteBuild = changedDuringBuild.some(file => before.get(file) !== this.hashes.get(file));
        if (obsoleteBuild && !manual && !manualOperation) {events.invalidated(changedDuringBuild); throw new Cancelled();}
        const previousShapes = baseline?.shapes ?? this.shapes;
        const shapeFiles = [...before.keys()].filter(file => newBaseline || !previousShapes.has(file) || changes.includes(file));
        let nextShapes: ReadonlyMap<string, string | null>;
        try { nextShapes = await sourceShapes(config.dotnet, this.options.analyzer, shapeFiles, this.options.storage, processOptions, this.sources.excludedAliases); }
        catch (error) {
            signal.throwIfAborted(); events.output(`Source analysis unavailable; using project fallback. ${String(error)}\n`);
            nextShapes = new Map(shapeFiles.map(file => [file, null]));
        }
        const conservative = new Set(changes.filter(file => !nextShapes.get(file) || nextShapes.get(file) !== previousShapes.get(file)));
        const currentShapes = new Map([...previousShapes, ...nextShapes].filter(([file]) => before.has(file)));
        let coverageTool: string | undefined;
        if (config.coverage && builds.some(project => project.isTestProject)) {
            try {coverageTool = await this.ensureCoverageTool(config, processOptions);}
            catch (error) {signal.throwIfAborted(); events.output(`Coverage unavailable; tests will continue with conservative selection. ${String(error)}\n`);}
        }
        const runnerOptions: RunnerOptions = {
            ...processOptions, dotnet: config.dotnet, storage: path.join(this.options.storage, 'runs'),
            testArguments: config.testArguments, coverageTool, assemblies: this.projects.map(project => project.assembly), analyzer: this.options.analyzer,
            onResult: (group, result) => {
                if (result.node && !group.tests.some(test => test.id === result.id)) {
                    const nodes = this.runtime.get(group.id) ?? new Map(); nodes.set(result.id, discoveredTest(result.node as { uid: string })); this.runtime.set(group.id, nodes);
                }
                events.result(group, result);
            }, onStarted: events.started, onPrepared: events.prepared
        };
        events.phase('Discovering tests');
        const testBuilds = builds.filter(project => project.isTestProject);
        const next = this.groups.filter(group => !testBuilds.some(project => project.file === group.project && project.framework === group.framework)
            && this.projects.some(project => project.file === group.project && project.framework === group.framework));
        for (const project of testBuilds) {next.push(...await discover(project, runnerOptions));}
        const oldGroups = new Map(this.groups.map(group => [group.id, group]));
        const identitiesChanged = new Set(next.filter(group => {
            const previous = oldGroups.get(group.id);
            return previous && previous.tests.map(test => test.id).sort().join('\0') !== group.tests.map(test => test.id).sort().join('\0');
        }).map(group => group.id));
        for (const id of identitiesChanged) {baseline?.completed.delete(id); this.runtime.delete(id);}
        this.coverage.invalidate(identitiesChanged); this.groups = next;
        const groupIds = new Set(next.map(group => group.id));
        for (const id of this.runtime.keys()) {if (!groupIds.has(id)) {this.runtime.delete(id);}}
        for (const id of baseline?.completed ?? []) {if (!groupIds.has(id)) {baseline?.completed.delete(id);}}
        const liveIds = new Set([...next.map(group => group.id), ...(config.mode === 'all' ? next.map(projectCoverageId) : [])]);
        this.coverage.replace([], liveIds); events.discovered(this.groups);
        const checkpointInputs = new Map(before);
        if (baseline) {for (const file of changes) {
            if (checkpointInputs.has(file)) {continue;}
            try {checkpointInputs.set(file, contentHash(await fs.readFile(file, { signal })));}
            catch (error) {signal.throwIfAborted(); if (!['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {throw error;} checkpointInputs.set(file, 'missing-or-directory');}
        }}
        const impactChanges = baseline ? changes.filter(file => !baseline.inputs.has(file) || baseline.inputs.get(file) !== checkpointInputs.get(file)) : changes;
        const impact = selectTests(this.groups, this.projects, this.coverage.traces, impactChanges, config.mode, false, conservative, this.index, file => this.coverage.dependentGroups([file]));
        if (baseline) {for (const group of impact.groups) {baseline.completed.delete(group.id);} baseline.shapes = currentShapes; baseline.inputs = checkpointInputs;}
        let selection: Selection;
        if (manual) {
            selection = { groups: this.groups.filter(group => manual.groups.has(group.id)).map(group => {
                const requested = manual.tests?.get(group.id);
                const tests = new Map(this.knownTests(group).map(test => [test.id, test]));
                return { ...group, tests: [...tests.values()].filter(test => !requested || requested.has(test.id)) };
            }).filter(group => group.tests.length), reason: 'Manual run', fallback: false };
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
        const sessions = new RunnerSession(runnerOptions);
        const batches: TestFile[][] = [];
        const batchProjects = !coverageTool || config.mode === 'all';
        for (const group of selection.groups) {
            const existing = batchProjects ? batches.find(items => items[0].assembly === group.assembly) : undefined;
            if (existing) {existing.push(group);} else {batches.push([group]);}
        }
        const results: TestResult[] = [];
        let available = !!coverageTool;
        try {
            for (let index = 0; index < batches.length; index++) {
                const groups = batches[index];
                events.phase(`Testing ${index + 1}/${batches.length}${baseline ? ` · ${baseline.completed.size}/${this.groups.length} files learned` : ''}`);
                const run = await sessions.run(groups, before); results.push(...run.results); available &&= run.coverageAvailable;
                signal.throwIfAborted();
                await this.sources.refresh(run.trace.dependencies, signal);
                const current = topology === this.topology && !obsoleteBuild && revision === this.sources.revision
                    && Object.entries(run.trace.inputs ?? {}).every(([file, hash]) => this.hashes.get(file) === hash);
                if (!current) {
                    this.coverage.markStale(new Set(groups.map(group => group.id)));
                    if (!manual && !manualOperation) {events.invalidated(changes); throw new Cancelled();}
                    continue;
                }
                const complete = groups.every(group => {const original = this.groups.find(item => item.id === group.id); return original && original.tests.length === group.tests.length && original.tests.every(test => group.tests.some(item => item.id === test.id));});
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
                    this.coverage.replace([run.trace], liveIds);
                } else if (!manual) {
                    // Preserve previous coverage and its freshness state. No
                    // collection means no new narrowing information was learned.
                    for (const group of groups) {
                        if (this.coverage.traces.has(group.id)) {this.coverage.invalidate(new Set([group.id]), false);}
                        else {this.coverage.replace([{ groupId: group.id, dependencies: group.file ? [group.file] : [], coverage: [], reliable: false, timestamp: Date.now(), inputs: {} }], liveIds);}
                    }
                }
                if (complete && (!manual || !configured.coverage || run.coverageAvailable)) {for (const group of groups) {baseline?.completed.add(group.id);}}
                events.coverage(); await this.save();
            }
        } finally {await sessions.dispose();}
        signal.throwIfAborted();
        if (!manual) {
            this.shapes = currentShapes;
            if (!baseline || this.groups.every(group => baseline.completed.has(group.id))) {this.initialized = true; this.baseline = undefined;}
        }
        events.coverage(); await this.save();
        return { files: selection.groups.length, tests: results.length, passed: results.filter(result => result.outcome === 'passed').length,
            failed: results.filter(result => result.outcome === 'failed' || result.outcome === 'errored').length,
            skipped: results.filter(result => result.outcome === 'skipped').length, duration: Date.now() - began, coverageAvailable: available };
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

    private async save(): Promise<void> {
        const delta = this.coverage.takeDelta();
        try {await this.cache.save(delta);}
        catch (error) {this.coverage.retryDelta(delta);this.options.events.output(`Coverage could not be saved; current test results remain available. ${String(error)}\n`);}
    }
}
