import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult } from '../core/model';
import { preparePathNormalizer, sourceVersion, testFileId, testTargetKey } from '../core/paths';
import { projectCoverageId } from '../core/coverage';
import { isReliableTrace } from '../core/traceReliability';
import { requestTests, testConverter, TestNode, testResult } from './mtp';
import { CoverageReader } from './coverageReader';
import { removeOutput } from './output';
import { claimRunOutputs, RunOutputLease } from './runOutputs';
import { RuntimeObservation } from './runtimeObservation';

import { discover, locationFiles, methodKey, nodeKey } from './runnerDiscovery';
import { matchesFile, RunnerLanes } from './runnerLanes';
import { Preparation, RunnerPreparations } from './runnerPreparation';
import type { FileRun, RunnerOptions } from './runnerTypes';

export { discover, projectCoverageId };
export type { FileRun, RunnerOptions };

export class RunnerSession {
    private readonly discoveries = new Map<string, Promise<readonly TestFile[]>>();
    private readonly projects = new Map<string, Project>();
    private readonly preparer: RunnerPreparations;
    private readonly prepared: Map<string, Preparation>;
    private readonly lanes: RunnerLanes<RunnerSession>;
    private readonly unsafeParallel = new Set<string>();
    private readonly queues = new Map<string, Promise<void>>();
    private readonly running = new Set<Promise<FileRun>>();
    private readonly coverageReader = new CoverageReader();
    private outputLease?: RunOutputLease;
    private lease: Promise<RunOutputLease> | undefined;
    private disposed = false;
    private disposal?: Promise<void>;
    constructor(private readonly options: RunnerOptions) {
        const preparer = this.preparer = new RunnerPreparations(options, () => this.outputRoot(), this.projects);
        this.prepared = preparer.prepared;
        this.lanes = new RunnerLanes((number, slot) => this.outputRoot().then(root => new RunnerSession({ ...this.options,
            outputRoot: path.join(root, 'lanes', String(number)), preparationLane: slot, preparationTools: preparer.toolContexts,
            preparationToolIdentities: preparer.toolIdentities, deferCoverage: undefined, onPrepared: undefined, tryInstrumentation: undefined })));
    }

    async discover(project: Project): Promise<readonly TestFile[]> {
        this.assertOpen();
        const key = testTargetKey(project.file, project.framework);
        const existing = this.discoveries.get(key); if (existing) {return existing;}
        this.projects.set(key, project);
        const pending = this.discoverProject(project);
        this.discoveries.set(key, pending);
        try {return await pending;}
        catch (error) {this.discoveries.delete(key); throw error;}
    }

    private async discoverProject(project: Project): Promise<readonly TestFile[]> {
        const preparation = await this.preparer.prepare({ id: testFileId(project.file, project.framework), project: project.file,
            assembly: project.assembly, framework: project.framework, tests: [] });
        const groups = (await discover({ ...project, assembly: path.join(preparation.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes))
            .map(group => ({ ...group, assembly: project.assembly }));
        preparation.groups = groups;
        return groups;
    }

    private async resolve(groups: readonly TestFile[]): Promise<{ preparation: Preparation; selected: TestNode[]; executedGroups: readonly TestFile[]; originals: ReadonlyMap<string, TestNode> }> {
        const group = groups[0];
        if (!group || groups.some(item => item.assembly !== group.assembly || item.project !== group.project || item.framework !== group.framework)) {throw new Error('A test batch must belong to one project and target framework.');}
        const options = this.projectOptions(group);
        const preparation = await this.preparer.prepare(group);
        // Discovery and execution use one stable private path, so exact native
        // UIDs work even when displayed theory names are indistinguishable.
        const { nativeById, byKey } = preparation;
        const originals = new Map<string, TestNode>();
        const selectedNodes = new Map<string, TestNode>();
        const forbidden = new Set<string>();
        let work = 0;
        for (const item of groups) {for (const id of item.excludedTestIds ?? []) {
            const native = nativeById.get(id);
            if (!native) {throw new Error('The provider cannot honor an exclusion for a runtime or changed test identity. Select tests using the refreshed discovery identities.');}
            forbidden.add(native.uid);
        }}
        let expanded = false;
        let projectFallback = false;
        const expandedIds = new Set<string>();
        const preparedGroups = new Map(preparation.groups?.map(item => [item.id, item]));
        for (const item of groups) {for (const test of item.tests) {
            if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
            let native = nativeById.get(test.id);
            if (!native) {const matching = byKey.get(nodeKey(test.node as TestNode)); if (matching?.length === 1) {native = matching[0];}}
            if (native) {
                if (!forbidden.has(native.uid)) {originals.set(native.uid, test.node as TestNode); selectedNodes.set(native.uid, native);}
                continue;
            }
            // Runtime-only rows may not be individually selectable. Use the
            // freshly discovered containing file; never send an unresolved UID
            // from an old path or guess between indistinguishable row names.
            const containing = item.runtimeOnly ? preparation.groups : [preparedGroups.get(item.id)].filter((item): item is TestFile => !!item);
            if (!containing?.length) {throw new Error('The selected test identity is unavailable. Rediscover the project before rerunning it.');}
            for (const file of containing) {
                if (expandedIds.has(file.id)) {continue;} expandedIds.add(file.id);
                for (const candidate of file.tests) {
                    const node = nativeById.get(candidate.id); if (node && !forbidden.has(node.uid)) {selectedNodes.set(node.uid, node);}
                    if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
                }
            }
            projectFallback ||= !!item.runtimeOnly;
            expanded = true;
        }}
        const selected = [...selectedNodes.values()];
        if (!selected.length) {throw new Error('No selectable tests remain after applying exclusions.');}
        const executedGroups = expanded ? preparation.groups!.map(item => ({ ...item, tests: item.tests.filter(test => selectedNodes.has(test.id)) }))
            .filter(item => item.tests.length) : groups;
        if (expanded) {
            options.output?.(`The provider cannot select this runtime or changed test identity individually; running its ${projectFallback ? 'project (source file unknown)' : 'containing test file'}.\n`);
            options.onExpanded?.(executedGroups);
        }
        return { preparation, selected, executedGroups, originals };
    }

    /** Resolve the union before batching, so project fallback cannot overlap a file run. */
    async resolveSelection(groups: readonly TestFile[]): Promise<readonly TestFile[]> {
        const projects = new Map<string, TestFile[]>();
        for (const group of groups) {
            const key = testTargetKey(group.project, group.framework), selected = projects.get(key) ?? [];
            selected.push(group); projects.set(key, selected);
        }
        const selected: TestFile[] = [];
        for (const groups of projects.values()) {selected.push(...(await this.resolve(groups)).executedGroups);}
        return selected;
    }

    /** Positive worker IDs may reuse an idle private lane; zero keeps canonical discovery. */
    async run(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>, workerIndex = 0): Promise<FileRun> {
        this.assertOpen();
        const pending = this.runInLane(groups, hashes, workerIndex);
        this.running.add(pending);
        try {return await pending;}
        finally {this.running.delete(pending);}
    }

    /** Full ordinary source files can safely acquire another prepared output. */
    canRunParallel(groups: readonly TestFile[]): boolean {
        const group = groups[0];
        if (!group || this.unsafeParallel.has(group.id)) {return false;}
        const key = testTargetKey(group.project, group.framework);
        const canonical = this.prepared.get(key)?.groups?.find(item => item.id === group.id);
        const requested = new Set(group.tests.map(test => test.id));
        return groups.length === 1 && !!group.file && !group.runtimeOnly && !group.excludedTestIds?.length
            && !!canonical && group.file === canonical.file && requested.size === group.tests.length && canonical.tests.length === requested.size
            && canonical.tests.every(test => requested.has(test.id));
    }

    private async runInLane(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>, workerIndex: number): Promise<FileRun> {
        this.options.signal?.throwIfAborted();
        const group = groups[0];
        if (!group) {throw new Error('A test batch must belong to one project and target framework.');}
        const key = testTargetKey(group.project, group.framework);
        const primary = this.prepared.get(key), project = this.projects.get(key);
        if (Number.isSafeInteger(workerIndex) && workerIndex > 0 && this.queues.has(key) && this.canRunParallel(groups) && primary && project) {
            const reserved = this.lanes.reserve(key);
            try {
                const lane = await reserved.session;
                await lane.discover(project);
                const canonical = primary.groups!.find(item => item.id === group.id)!;
                if (matchesFile(canonical, primary, lane.prepared.get(key)!)) {return await lane.run(groups, hashes);}
                this.unsafeParallel.add(group.id);
                this.options.output?.(`Parallel test identities could not be matched for ${path.basename(group.file!)}; using its primary runner.\n`);
            } finally {
                reserved.busy = false;
            }
        }
        // Fallbacks and partial selections share canonical native IDs and output.
        // They must remain serial even when several pool workers request them.
        // One failed batch does not reject its successors; each reports its own outcome.
        const previous = this.queues.get(key) ?? Promise.resolve();
        const execution = previous.then(() => this.execute(group, groups, hashes));
        const tail = execution.then(() => undefined, () => undefined);
        this.queues.set(key, tail);
        const clear = (): void => {if (this.queues.get(key) === tail) {this.queues.delete(key);}};
        void tail.then(clear, clear);
        return execution;
    }

    /** group: the batch's first file, which names its project and framework. */
    private async execute(group: TestFile, groups: readonly TestFile[], hashes: ReadonlyMap<string, string>): Promise<FileRun> {
        this.options.signal?.throwIfAborted();
        const initial = await this.preparer.prepare(group);
        // Later batches of a target whose template upgrade was interrupted fail
        // fast; the template is in an unknown state until the next run.
        if (initial.interrupted) {throw initial.interrupted.error;}
        if (initial.coveragePending) {
            try {await this.preparer.prepareSelectedCoverage(group, initial);}
            catch (error) {initial.interrupted = { error }; throw error;}
        }
        const { preparation, selected, executedGroups, originals } = await this.resolve(groups);
        const options = this.projectOptions(group), single = executedGroups.length === 1 ? executedGroups[0] : undefined;
        if (preparation.runs++) {await preparation.output.restore(options.signal);}
        let work = 0;
        const originalNode = (node: TestNode): TestNode => {
            const original = originals.get(node.uid);
            return original ? { ...original, ...node, uid: original.uid } : node;
        };
        const owner = new Map<string, TestFile>(), files = new Map<string, TestFile>(), methods = new Map<string, TestFile | null>();
        for (const item of [...groups.filter(item => !item.runtimeOnly), ...executedGroups]) {for (const test of item.tests) {
            owner.set(test.id, item);
            if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
        }}
        for (const item of executedGroups) {
            if (item.file) {files.set(item.file, item);}
            for (const test of item.tests) {
                const key = methodKey(test.node);
                if (key) {methods.set(key, methods.has(key) && methods.get(key)?.id !== item.id ? null : item);}
                if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
            }
        }
        // Streamed results are converted synchronously; resolve their discovered files first.
        const convert = testConverter(await preparePathNormalizer(locationFiles([...preparation.nodes, ...originals.values()]), options.signal));
        const unknown: TestFile = single ?? { ...group, id: `runtime:${testFileId(group.project, group.framework)}`, file: undefined, tests: [], excludedTestIds: undefined, runtimeOnly: true };
        const groupFor = (test: DiscoveredTest): TestFile => owner.get(test.id)
            ?? (test.file ? files.get(test.file) : undefined) ?? methods.get(methodKey(test.node) ?? '') ?? unknown;
        const selectedIds = new Set(selected.map(node => node.uid));
        const completeProject = preparation.nodes.every(node => selectedIds.has(node.uid));
        const assembly = path.join(preparation.output.directory, path.basename(group.assembly));
        // A report and the observer logs are read once, below. Remove them as soon as this
        // batch ends: a session lasts the whole run, and every test file adds a set.
        const report = path.join(preparation.root, `coverage-${preparation.runs}.xml`), modules = path.join(preparation.root, `modules-${preparation.runs}`);
        const resultsDirectory = path.join(preparation.root, `results-${preparation.runs}`);
        try {
            let observation: RuntimeObservation | undefined;
            if (preparation.coverage) {
                try {
                    observation = await RuntimeObservation.start(modules, assembly,
                        options.modules ?? (options.assemblies ?? [group.assembly]).map(file => ({ name: path.basename(file, path.extname(file)), sources: [...hashes.keys()] })),
                        preparation.instrumented ?? [], options.env);
                } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Runtime observation unavailable; retaining conservative dependencies. ${String(error)}\n`);}
            }
            const collected = (work: Promise<readonly TestNode[]>): Promise<readonly TestNode[]> => preparation.coverage
                ? work.catch((error: unknown) => {preparation.collectorInterrupted = true; throw error;}) : work;
            const nodes = await collected(requestTests({
                ...options, env: observation?.env ?? options.env, expectedTests: selected, assembly,
                args: ['--results-directory', resultsDirectory, ...options.testArguments],
                wrapper: preparation.coverage ? {
                    command: options.coverageTool!, args: ['collect', '--nologo', '--session-id', preparation.session, '-f', 'cobertura', '-o', report]
                } : undefined,
                onNode: native => {
                    if (native['node-type'] === 'group') {return;}
                    const node = originalNode(native);
                    const test = convert(node), item = groupFor(test);
                    if (node['execution-state'] === 'in-progress') {options.onStarted?.(item, node.uid);}
                    const result = testResult(node); if (result) {options.onResult?.(item, result, test);}
                }
            }, 'run', completeProject ? undefined : selected));
            options.signal?.throwIfAborted();
            const results = nodes.map(originalNode).map(testResult).filter((result): result is TestResult => !!result);
            if (!results.length) {throw new Error(`No test results were received for ${group.file ?? group.project}.`);}
            const coverage: FileCoverage[] = [];
            let available = preparation.coverage;
            if (available) {
                try {
                    coverage.push(...await this.coverageReader.read(report, options.cwd, hashes, options.signal));
                } catch (error) {
                    options.signal?.throwIfAborted(); available = false; preparation.collectorInterrupted = true;
                    options.output?.(`Coverage unavailable for ${path.basename(group.project)}; test results are retained. ${String(error)}\n`);
                }
            }
            let runtimeDependencies: readonly string[] = [], moduleProjects: readonly string[] = [], observed = !preparation.coverage;
            if (preparation.coverage) {
                try {
                    if (!observation) {throw new Error('No runtime observer was available.');}
                    const dependencies = await observation.dependencies(options.signal);
                    runtimeDependencies = dependencies.files; moduleProjects = dependencies.projects; observed = true;
                } catch (error) {
                    options.signal?.throwIfAborted(); runtimeDependencies = [...hashes.keys()];
                    moduleProjects = [...new Set(options.modules?.flatMap(module => module.project ? [module.project] : []) ?? [])];
                    options.output?.(`Runtime observation incomplete; retaining workspace dependencies. ${String(error)}\n`);
                }
            }
            const dependencies = [...new Set([...coverage.filter(file => file.lines.some(line => line.hits > 0)).map(file => file.file), ...runtimeDependencies,
                ...executedGroups.flatMap(item => this.options.buildInputs?.get(item.project) ?? []),
                ...executedGroups.map(item => item.file).filter((file): file is string => !!file)])];
            const reliable = isReliableTrace({ file: single, coverageAvailable: available, observed, coverage, results });
            return {
                results, coverageAvailable: available, executedGroups,
                trace: {
                    groupId: single?.id ?? projectCoverageId(group), dependencies, moduleProjects, coverage, reliable, timestamp: Date.now(),
                    inputs: Object.fromEntries(dependencies.map(file => [file, sourceVersion(hashes, file)]))
                }
            };
        } finally {
            // The results directory keeps attachments MTP reported (and logged) while it has any.
            const artifacts = [...preparation.coverage ? [fs.rm(report, { force: true }), removeOutput(modules)] : [], fs.rmdir(resultsDirectory)];
            await Promise.all(artifacts.map(cleanup => cleanup.catch(() => undefined)));
        }
    }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.disposal ??= (async () => {
            await Promise.allSettled([...this.running, ...this.discoveries.values(), ...this.preparer.pending()]);
            const lanes = await Promise.allSettled(this.lanes.sessions());
            const actions = [() => this.coverageReader.dispose(), ...lanes.filter((lane): lane is PromiseFulfilledResult<RunnerSession> => lane.status === 'fulfilled')
                .map(lane => () => lane.value.dispose()), ...this.preparer.releases()];
            // Every private owner must be released even if another owner's cleanup fails.
            const cleaned = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
            this.prepared.clear();
            const outputs = await Promise.allSettled([Promise.resolve().then(() => this.outputLease?.dispose())]);
            const errors = [...cleaned, ...outputs].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result): unknown => result.reason);
            if (errors.length) {throw new AggregateError(errors, `Test runner cleanup failed: ${errors.map(String).join('; ')}`);}
        })();
    }

    /** Processes for a target run in its project directory. */
    private projectOptions(group: Pick<TestFile, 'project'>): RunnerOptions { return { ...this.options, cwd: path.dirname(group.project) }; }

    private assertOpen(): void {if (this.disposed) {throw new Error('The test runner session has been disposed.');}}

    private async outputRoot(): Promise<string> {
        if (this.options.outputRoot) {return this.options.outputRoot;}
        if (!this.lease) {
            this.lease = claimRunOutputs(this.options.storage, this.options.identity, this.options.signal, this.options.output);
        }
        try {this.outputLease = await this.lease; return this.outputLease.directory;}
        catch (error) {this.lease = undefined; throw error;}
    }
}
