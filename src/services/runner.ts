import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult } from '../core/model';
import { preparePathNormalizer, sourceVersion, testFileId, testTargetKey } from '../core/paths';
import { projectCoverageId } from '../core/coverage';
import { isReliableTrace } from '../core/traceReliability';
import { MtpSession, requestTests, testConverter, TestNode, testResult } from './mtp';
import { requireSuccess, runProcess } from './process';
import { CoverageReader } from './coverageReader';
import { removeOutput } from './output';
import { claimRunOutputs, RunOutputLease } from './runOutputs';
import { RuntimeObservation } from './runtimeObservation';

import { discover, locationFiles, methodKey, nodeKey } from './runnerDiscovery';
import { matchesFile, RunnerLanes } from './runnerLanes';
import { treeMemory } from './processMemory';
import { hasExcludedTrait } from '../core/traits';
import { Preparation, RunnerPreparations } from './runnerPreparation';
import type { FileRun, RunnerOptions } from './runnerTypes';

export { discover, projectCoverageId };

/** A test host kept for several batches (see RunnerSession.openHost); `close` is idempotent and removes its private files. */
interface LiveHost { readonly session: MtpSession; readonly observation: RuntimeObservation | undefined; close(): Promise<void> }

/** The sum of several coverage reports of the same versions: per test, a whole file's coverage. */
export function mergeCoverage(reports: readonly (readonly FileCoverage[])[]): FileCoverage[] {
    const merged = new Map<string, { readonly entry: FileCoverage; readonly lines: Map<number, number> }>();
    for (const report of reports) {for (const entry of report) {
        const key = `${entry.file}\0${entry.hash}`;
        let target = merged.get(key);
        if (!target) {target = { entry, lines: new Map() }; merged.set(key, target);}
        for (const line of entry.lines) {target.lines.set(line.line, (target.lines.get(line.line) ?? 0) + line.hits);}
    }}
    return [...merged.values()].map(({ entry, lines }) => ({ ...entry, lines: [...lines].sort(([a], [b]) => a - b).map(([line, hits]) => ({ line, hits })) }));
}
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
    /** Test hosts kept for later batches of their prepared output (see RunnerOptions.reuseHosts). */
    private readonly liveHosts = new Map<Preparation, LiveHost>();
    private hostSequence = 0;
    private outputLease?: RunOutputLease;
    private lease: Promise<RunOutputLease> | undefined;
    private disposed = false;
    private disposal?: Promise<void>;
    private options: RunnerOptions;
    /** Aborts reused test hosts: with the signal of the run the session serves (see rebind), or at disposal. */
    private readonly hostLifetime = new AbortController();
    private unlink: (() => void) | undefined;
    /** What each lane overrides in the options it shares with this session. */
    private readonly laneOptions = new Map<RunnerSession, Partial<RunnerOptions>>();
    constructor(options: RunnerOptions) {
        this.options = options; this.link(options.signal);
        const preparer = this.preparer = new RunnerPreparations(options, () => this.outputRoot(), this.projects, (group, preparation) => this.discoverInHost(group, preparation));
        this.prepared = preparer.prepared;
        this.lanes = new RunnerLanes((number, slot) => this.outputRoot().then(root => {
            const own: Partial<RunnerOptions> = { outputRoot: path.join(root, 'lanes', String(number)), preparationLane: slot, preparationTools: preparer.toolContexts,
                preparationToolIdentities: preparer.toolIdentities, deferCoverage: undefined, onPrepared: undefined, tryInstrumentation: undefined };
            const lane = new RunnerSession({ ...this.options, ...own });
            this.laneOptions.set(lane, own);
            return lane;
        }));
    }

    private link(signal: AbortSignal | undefined): void {
        this.unlink?.(); this.unlink = undefined;
        if (!signal) {return;}
        const abort = (): void => this.hostLifetime.abort(signal.reason);
        if (signal.aborted) {abort(); return;}
        signal.addEventListener('abort', abort, { once: true });
        this.unlink = () => signal.removeEventListener('abort', abort);
    }

    /** Whether the session can serve another run (see rebind): open, and its hosts not stopped by a cancelled run. */
    get reusable(): boolean { return !this.disposed && !this.hostLifetime.signal.aborted; }

    /** The build outputs its targets were prepared from, which a later run must find unchanged to reuse the session. */
    get sources(): readonly string[] { return [...new Set([...this.prepared.values()].flatMap(preparation => preparation.source ?? []))]; }

    /** Serve a later run whose builds left every prepared output unchanged (see engine/prepare): its signal, callbacks and settings
     * replace this run's, while prepared outputs, discoveries and reused test hosts carry over. The private outputs stay where they
     * are. Cancelling the new run stops the hosts. */
    async rebind(options: RunnerOptions): Promise<void> {
        this.assertOpen();
        if (!this.reusable) {throw new Error('The test runner session cannot serve another run.');}
        const { outputRoot, preparationLane, preparationTools, preparationToolIdentities } = this.options;
        this.options = { ...options, ...outputRoot === undefined ? {} : { outputRoot }, ...preparationLane === undefined ? {} : { preparationLane },
            ...preparationTools ? { preparationTools } : {}, ...preparationToolIdentities ? { preparationToolIdentities } : {} };
        this.link(options.signal); this.preparer.rebind(this.options);
        const lanes = await Promise.allSettled(this.lanes.sessions());
        for (const lane of lanes) {if (lane.status === 'fulfilled') {await lane.value.rebind({ ...this.options, ...this.laneOptions.get(lane.value) });}}
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
        const ended = this.options.track?.(`Discover ${path.basename(project.file)} (${project.framework})`, 'discovery');
        let found: readonly TestFile[] | undefined;
        try {found = await discover({ ...project, assembly: path.join(preparation.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes);}
        finally {ended?.(found ? { files: found.length } : { completed: false });}
        const groups = found.map(group => ({ ...group, assembly: project.assembly }));
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

    /** Positive worker IDs may reuse an idle private lane; zero keeps canonical discovery. `part`: the batch is some of the tests
     * of one file, split from it (see core/runPolicy splitLongFiles), and may run on a lane like the whole file. */
    async run(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>, workerIndex = 0, part = false): Promise<FileRun> {
        this.assertOpen();
        const pending = this.runInLane(groups, hashes, workerIndex, part);
        this.running.add(pending);
        try {return await pending;}
        finally {this.running.delete(pending);}
    }

    /** Full ordinary source files can safely acquire another prepared output. So can a part of one (`part`): the lane matches the
     * whole file's identities before it runs (see matchesFile), and a part's tests resolve the same way. */
    canRunParallel(groups: readonly TestFile[], part = false): boolean {
        const group = groups[0];
        if (!group || this.unsafeParallel.has(group.id)) {return false;}
        const key = testTargetKey(group.project, group.framework);
        const canonical = this.prepared.get(key)?.groups?.find(item => item.id === group.id);
        const requested = new Set(group.tests.map(test => test.id));
        const canonicalIds = new Set(canonical?.tests.map(test => test.id));
        return groups.length === 1 && !!group.file && !group.runtimeOnly && !group.excludedTestIds?.length
            && !!canonical && group.file === canonical.file && requested.size === group.tests.length && requested.size > 0
            && (part ? [...requested].every(id => canonicalIds.has(id)) : canonical.tests.length === requested.size && canonical.tests.every(test => requested.has(test.id)));
    }

    private async runInLane(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>, workerIndex: number, part = false): Promise<FileRun> {
        this.options.signal?.throwIfAborted();
        const group = groups[0];
        if (!group) {throw new Error('A test batch must belong to one project and target framework.');}
        const key = testTargetKey(group.project, group.framework);
        const primary = this.prepared.get(key), project = this.projects.get(key);
        if (Number.isSafeInteger(workerIndex) && workerIndex > 0 && this.queues.has(key) && this.canRunParallel(groups, part) && primary && project) {
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
        // A reused host keeps its output loaded, so the output is restored only before a new host starts (see RunnerOptions.reuseHosts).
        // A file with an isolated trait runs in a process of its own: a live host of its output ends first, since the output is restored.
        const isolated = !!options.isolatedTraits?.length && [...groups, ...executedGroups].some(item => item.tests.some(test => hasExcludedTrait(test.traits, options.isolatedTraits!)));
        const reuse = !!options.reuseHosts && !options.debug && !isolated;
        if (isolated) {const existing = this.liveHosts.get(preparation); if (existing) {this.liveHosts.delete(preparation); await existing.close();}}
        const perTest = !!single && !!options.perTestCoverage?.(single.id) && preparation.coverage && !options.debug && executedGroups.length === 1;
        const live = reuse ? this.liveHosts.get(preparation) : undefined;
        if ((preparation.runs++ || preparation.hostDiscovered) && !live?.session.alive) {await preparation.output.restore(options.signal);}
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
        let transient: LiveHost | undefined, kept: LiveHost | undefined;
        try {
            let observation: RuntimeObservation | undefined, liveObservation = false;
            const onNode = (native: TestNode): void => {
                if (native['node-type'] === 'group') {return;}
                const node = originalNode(native);
                const test = convert(node), item = groupFor(test);
                if (node['execution-state'] === 'in-progress') {options.onStarted?.(item, node.uid);}
                const result = testResult(node); if (result) {options.onResult?.(item, result, test);}
            };
            const coverage: FileCoverage[] = [];
            const testCoverage = perTest ? new Map<string, readonly FileCoverage[]>() : undefined;
            let available = preparation.coverage, started = Date.now(), nodes: readonly TestNode[];
            if (reuse || perTest) {
                const host = await this.openHost(preparation, group, assembly, hashes, reuse);
                // A host for this batch only: its observer log is read below, after it exits, and removed with it at the end.
                if (!reuse) {transient = host;}
                observation = host.observation; liveObservation = reuse; started = Date.now();
                /** Without a snapshot, coverage is lost for this batch, as when a report cannot be read below, and the hits the session
                 * still holds would belong to the next batch: the host is not reused. Test results are kept. */
                const uncollected = (error: unknown): void => {
                    options.signal?.throwIfAborted();
                    if (available) {options.output?.(`Coverage unavailable for ${path.basename(group.project)}; test results are retained. ${String(error)}\n`);}
                    available = false; preparation.collectorInterrupted = true; this.liveHosts.delete(preparation); transient ??= host;
                };
                try {
                    if (perTest) {
                        // One request per test, each followed by a snapshot that resets the session: every test's own coverage.
                        const collected: TestNode[] = [];
                        for (const [index, node] of selected.entries()) {
                            collected.push(...await host.session.run([node], { expectedTests: [node], onNode }));
                            if (!available) {continue;}
                            const testReport = path.join(preparation.root, `coverage-${preparation.runs}-${index}.xml`);
                            try {
                                await this.snapshot(preparation.session, testReport);
                                testCoverage!.set(originalNode(node).uid, await this.coverageReader.read(testReport, options.cwd, hashes, options.signal, preparation.session));
                            } catch (error) {uncollected(error);}
                            finally {await fs.rm(testReport, { force: true }).catch(() => undefined);}
                        }
                        nodes = collected;
                        if (available) {coverage.push(...mergeCoverage([...testCoverage!.values()]));}
                    } else {
                        nodes = await host.session.run(completeProject ? undefined : selected, { expectedTests: selected, onNode });
                        if (preparation.coverage) {try {await this.snapshot(preparation.session, report);} catch (error) {uncollected(error);}}
                    }
                } catch (error) {
                    // The host is unusable; its collector stopped with it, and hits it held belong to no file.
                    if (preparation.coverage) {preparation.collectorInterrupted = true;}
                    this.liveHosts.delete(preparation); await host.close();
                    throw error;
                } finally {if (transient) {await host.session.close();}}
                if (!transient) {kept = host;}
            } else {
                if (preparation.coverage) {
                    try {
                        observation = await RuntimeObservation.start(modules, assembly,
                            options.modules ?? (options.assemblies ?? [group.assembly]).map(file => ({ name: path.basename(file, path.extname(file)), sources: [...hashes.keys()] })),
                            preparation.instrumented ?? [], options.env);
                    } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Runtime observation unavailable; retaining conservative dependencies. ${String(error)}\n`);}
                }
                started = Date.now();
                const collected = (work: Promise<readonly TestNode[]>): Promise<readonly TestNode[]> => preparation.coverage
                    ? work.catch((error: unknown) => {preparation.collectorInterrupted = true; throw error;}) : work;
                nodes = await collected(requestTests({
                    ...options, env: observation?.env ?? options.env, expectedTests: selected, assembly,
                    args: ['--results-directory', resultsDirectory, ...options.testArguments],
                    wrapper: preparation.coverage ? {
                        command: options.coverageTool!, args: ['collect', '--nologo', '--session-id', preparation.session, '-f', 'cobertura', '-o', report]
                    } : undefined,
                    onNode
                }, 'run', completeProject ? undefined : selected));
            }
            options.signal?.throwIfAborted();
            const results = nodes.map(originalNode).map(testResult).filter((result): result is TestResult => !!result);
            if (!results.length) {throw new Error(`No test results were received for ${group.file ?? group.project}.`);}
            if (available && !perTest) {
                try {
                    coverage.push(...await this.coverageReader.read(report, options.cwd, hashes, options.signal, preparation.session));
                } catch (error) {
                    options.signal?.throwIfAborted(); available = false; preparation.collectorInterrupted = true;
                    options.output?.(`Coverage unavailable for ${path.basename(group.project)}; test results are retained. ${String(error)}\n`);
                }
            }
            const elapsed = Date.now() - started;
            let runtimeDependencies: readonly string[] = [], moduleProjects: readonly string[] = [], observed = !preparation.coverage;
            if (preparation.coverage) {
                try {
                    if (!observation) {throw new Error('No runtime observer was available.');}
                    const dependencies = await observation.dependencies(options.signal, liveObservation);
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
                results, coverageAvailable: available, executedGroups, elapsed, ...testCoverage && available ? { testCoverage } : {},
                trace: {
                    groupId: single?.id ?? projectCoverageId(group), dependencies, moduleProjects, coverage, reliable, timestamp: Date.now(),
                    inputs: Object.fromEntries(dependencies.map(file => [file, sourceVersion(hashes, file)]))
                }
            };
        } finally {
            // The results directory keeps attachments MTP reported (and logged) while it has any.
            const artifacts = [...preparation.coverage ? [fs.rm(report, { force: true }), removeOutput(modules)] : [], fs.rmdir(resultsDirectory), ...transient ? [transient.close()] : []];
            await Promise.all(artifacts.map(cleanup => cleanup.catch(() => undefined)));
            // After the batch has read the host's observer log: a replaced host takes it along.
            if (kept) {await this.recycleOverLimit(preparation, kept).catch((error: unknown) => {if (!this.options.signal?.aborted) {this.options.output?.(`Could not measure a reused test host's memory: ${String(error)}\n`);}});}
        }
    }

    /** Discover a target's tests in the reused test host that will run them, rather than in a process of its own: its first batch
     * then starts no process. Only for outputs prepared with coverage, which this run executes (others defer it, see
     * RunnerOptions.deferCoverage), when hosts are reused. Hits that discovery causes, for example in data sources, join the first
     * batch's coverage without a snapshot to separate them: frameworks discover again inside every run request (MSTest evaluates
     * every class's data sources for a run of one file), so a batch's coverage already holds such hits, and they only widen selection.
     * Undefined when it does not apply, or when it failed: the caller discovers in a process. */
    private async discoverInHost(group: TestFile, preparation: Preparation): Promise<readonly TestNode[] | undefined> {
        const options = this.projectOptions(group);
        if (!options.reuseHosts || options.debug || !preparation.coverage || !options.modules || this.disposed) {return undefined;}
        const assembly = path.join(preparation.output.directory, path.basename(group.assembly));
        let host: LiveHost | undefined;
        try {
            host = await this.openHost(preparation, group, assembly, new Map(), true);
            const nodes = await host.session.discover();
            preparation.hostDiscovered = true;
            return nodes;
        } catch (error) {
            // Whatever the host collected or changed is discarded with it; the output is restored after the separate discovery.
            preparation.collectorInterrupted = true;
            if (host) {this.liveHosts.delete(preparation); await host.close();}
            options.signal?.throwIfAborted();
            options.output?.(`Could not discover ${path.basename(group.project)} (${group.framework}) in its test host; discovering in a separate process. ${String(error)}\n`);
            return undefined;
        }
    }

    /** The live host of a prepared output, or a new one. `keep`: later batches reuse it until the session ends; otherwise the caller
     * closes it after its batch. Its collector reports nothing itself: the batches take snapshots (see snapshot). */
    private async openHost(preparation: Preparation, group: TestFile, assembly: string, hashes: ReadonlyMap<string, string>, keep: boolean): Promise<LiveHost> {
        const existing = this.liveHosts.get(preparation);
        if (existing?.session.alive) {return existing;}
        if (existing) {this.liveHosts.delete(preparation); await existing.close();}
        const options = this.projectOptions(group), number = ++this.hostSequence;
        const modules = path.join(preparation.root, `modules-host-${number}`), results = path.join(preparation.root, `results-host-${number}`);
        const report = path.join(preparation.root, `coverage-host-${number}.xml`);
        let observation: RuntimeObservation | undefined;
        if (preparation.coverage) {
            try {
                observation = await RuntimeObservation.start(modules, assembly,
                    options.modules ?? (options.assemblies ?? [group.assembly]).map(file => ({ name: path.basename(file, path.extname(file)), sources: [...hashes.keys()] })),
                    preparation.instrumented ?? [], options.env);
            } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Runtime observation unavailable; retaining conservative dependencies. ${String(error)}\n`);}
        }
        const cleanup = (): Promise<void> => Promise.all([fs.rm(report, { force: true }), removeOutput(modules), fs.rmdir(results)].map(work => work.catch(() => undefined))).then(() => undefined);
        let session: MtpSession;
        try {
            // A reused host may outlive this run (see rebind), so it stops with the session's host lifetime rather than the run.
            session = await MtpSession.open({ ...options, signal: this.hostLifetime.signal, env: observation?.env ?? options.env, assembly, args: ['--results-directory', results, ...options.testArguments],
                wrapper: preparation.coverage ? { command: options.coverageTool!, args: ['collect', '--nologo', '--session-id', preparation.session, '-f', 'cobertura', '-o', report] } : undefined });
        } catch (error) {
            if (preparation.coverage) {preparation.collectorInterrupted = true;}
            await cleanup(); throw error;
        }
        let closing: Promise<void> | undefined;
        const host: LiveHost = { session, observation, close: () => closing ??= session.close().then(cleanup) };
        if (keep) {this.liveHosts.set(preparation, host);}
        return host;
    }

    /** Replace a reused host whose process tree grew past `testy.testProcessMemoryLimit` after a batch: the next batch starts a new
     * one. A tree whose memory the system cannot report is kept. */
    private async recycleOverLimit(preparation: Preparation, host: LiveHost): Promise<void> {
        const limit = this.options.testProcessMemoryLimit, pid = host.session.processId;
        if (!limit || pid === undefined || this.liveHosts.get(preparation) !== host) {return;}
        const used = await treeMemory(pid, this.options.signal);
        this.options.signal?.throwIfAborted();
        if (used === undefined || used <= limit) {return;}
        this.options.output?.(`A reused test host used ${Math.round(used / 1048576)} MiB, more than testy.testProcessMemoryLimit (${Math.round(limit / 1048576)} MiB); the next test file starts a new one.\n`);
        this.liveHosts.delete(preparation); await host.close();
    }

    /** Write the coverage the session collected since its previous snapshot to `report`, and reset it. */
    private async snapshot(session: string, report: string): Promise<void> {
        // One snapshot per test file, or per test with test granularity: the collector's command-line client is its only interface,
        // so it runs without the process owner, whose start-up would roughly double its cost (see ProcessOptions.direct).
        requireSuccess(await runProcess(this.options.coverageTool!, ['snapshot', session, '--reset', '--nologo', '-o', report],
            { ...this.options, direct: true, timeoutMs: Math.min(this.options.timeoutMs ?? 600_000, 120_000) }), 'Taking a coverage snapshot');
    }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.disposal ??= (async () => {
            await Promise.allSettled([...this.running, ...this.discoveries.values(), ...this.preparer.pending()]);
            // Hosts hold their outputs open; they exit before any output is removed.
            await Promise.allSettled([...this.liveHosts.values()].map(host => host.close())); this.liveHosts.clear();
            this.unlink?.(); this.hostLifetime.abort();
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
