import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult, Trace } from '../core/model';
import { contentHash, pathNormalizer, sourceVersion, testFileId, testTargetKey } from '../core/paths';
import { requestTests, testConverter, TestNode, testResult } from './mtp';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { CoverageReader } from './coverageReader';
import { copyOutput, fileHash, PreparedOutput, removeOutput } from './output';
import { sourceLocations } from './analysis';
import { claimRunOutputs, RunOutputLease } from './runOutputs';
import { RuntimeModule, RuntimeObservation } from './runtimeObservation';
import { PreparedArtifact, PreparedArtifactLease, PreparedOutputCache, preparationToolIdentity } from './preparedOutputCache';
import { windowsPreparationTools } from './preparationIdentity';

export interface RunnerOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly storage: string;
    readonly testArguments: readonly string[];
    readonly coverageTool?: string;
    /** The pinned collector receives a stable instrumentation environment across editor launches. */
    readonly managedCoverageTool?: boolean;
    /** Borrow an idle primary-preparation permit without waiting; the caller already owns one. */
    readonly tryInstrumentation?: <T>(signal: AbortSignal | undefined, work: () => Promise<T>) => Promise<T> | undefined;
    readonly assemblies?: readonly string[];
    readonly modules?: readonly RuntimeModule[];
    readonly buildInputs?: ReadonlyMap<string, readonly string[]>;
    readonly analyzer?: string;
    /** Stable within an engine, isolated from every other extension instance. */
    readonly identity?: string;
    readonly outputRoot?: string;
    readonly snapshots?: ReadonlyMap<string, string>;
    readonly preparedOutputCache?: PreparedOutputCache;
    /** Evaluated target, reference, SDK and build configuration identity. */
    readonly preparationContexts?: ReadonlyMap<string, string>;
    /** Internal per-target private output slot; zero retains canonical native IDs. */
    readonly preparationLane?: number;
    /** Shared only by the private lanes of one run. */
    readonly preparationTools?: Map<string, Promise<string>>;
    /** Resolve commands per project, then share hashes of the same executable within one run. */
    readonly preparationToolIdentities?: Map<string, Promise<string>>;
    /** Defer coverage for targets awaiting affected-file selection; discovery remains fresh. */
    readonly deferCoverage?: (target: Pick<TestFile, 'project' | 'framework'>) => boolean;
    readonly onResult?: (group: TestFile, result: TestResult, test?: DiscoveredTest) => void;
    readonly onStarted?: (group: TestFile, id: string) => void;
    readonly onPrepared?: (project: string) => void;
    readonly onExpanded?: (groups: readonly TestFile[]) => void;
}

export async function discover(project: Project, options: RunnerOptions, discovered?: readonly TestNode[]): Promise<readonly TestFile[]> {
    const nodes = discovered ?? await requestTests({ ...options, cwd: path.dirname(project.file), assembly: project.assembly, args: options.testArguments }, 'discover');
    let locations: Awaited<ReturnType<typeof sourceLocations>> | undefined;
    if (options.analyzer && nodes.some(node => !node['location.file'])) {
        try {
            locations = await sourceLocations(options.dotnet, options.analyzer, project.assembly, options.storage, options);
        } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Test source locations unavailable; retaining project fallback. ${String(error)}\n`);}
    }
    const byFile = new Map<string, DiscoveredTest[]>();
    const sources = new Set(project.sourceFiles), normalize = pathNormalizer(), convert = testConverter(normalize);
    let work = 0;
    options.signal?.throwIfAborted();
    for (let node of nodes) {
        if (!node['location.file'] && locations) {
            const location = locations.get(`${node['location.type']}.${String(node['location.method'] ?? '').split('(')[0]}`);
            if (location && sources.has(location.file)) {node = { ...node, 'location.file': location.file, 'location.line-start': location.line };}
        }
        const test = convert(node), key = test.file ?? '';
        const tests = byFile.get(key) ?? []; tests.push(test); byFile.set(key, tests);
        if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
    }
    const groups: TestFile[] = [];
    for (const [file, tests] of byFile) {
        groups.push({ id: testFileId(project.file, project.framework, file || undefined, normalize), project: project.file,
            framework: project.framework, assembly: project.assembly, file: file || undefined, tests });
        if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
    }
    return groups;
}

/** Compatibility helper for callers that explicitly need a complete snapshot. */
export async function sourceHashes(projects: readonly Project[]): Promise<ReadonlyMap<string, string>> {
    const hashes = new Map<string, string>();
    for (const file of new Set(projects.flatMap(project => [...project.sourceFiles]))) {
        try { hashes.set(file, contentHash(await fs.readFile(file))); }
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}}
    }
    return hashes;
}

export function projectCoverageId(group: TestFile): string { return `project:${testFileId(group.project, group.framework)}`; }
export interface FileRun {
    readonly results: readonly TestResult[];
    readonly trace: Trace;
    readonly coverageAvailable: boolean;
    readonly executedGroups: readonly TestFile[];
}
interface Preparation {
    readonly root: string; output: PreparedOutput; readonly session: string; coverage: boolean; coveragePending?: boolean;
    nodes: readonly TestNode[]; nativeById: ReadonlyMap<string, TestNode>;
    byKey: ReadonlyMap<string, readonly TestNode[]>; instrumented?: readonly string[]; groups?: readonly TestFile[]; runs: number;
    readonly lease?: PreparedArtifactLease;
}
interface RunnerLane { readonly session: Promise<RunnerSession>; busy: boolean; }

function nodeKey(node: TestNode): string {
    return JSON.stringify(['display-name', 'location.type', 'location.method', 'location.method-arity'].map(key => node[key] ?? null));
}

function methodKey(node: Readonly<Record<string, unknown>>): string | undefined {
    return typeof node['location.type'] === 'string' && typeof node['location.method'] === 'string'
        ? JSON.stringify([node['location.type'], node['location.method'].split('(')[0]]) : undefined;
}

function assemblyName(file: string): string {
    const name = path.basename(file);
    return process.platform === 'win32' ? name.toLowerCase() : name;
}

async function workspaceOutputs(directory: string, names: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {files.push(...await workspaceOutputs(file, names, signal));}
        else if (entry.isFile() && names.has(assemblyName(entry.name))) {files.push(file);}
    }
    return files;
}

/** Keep one inherited worker progressing even when every other preparation owns a permit. */
async function instrumentWithSpareCapacity<T>(
    assemblies: readonly string[], signal: AbortSignal | undefined, borrow: NonNullable<RunnerOptions['tryInstrumentation']>,
    work: (assembly: string, signal: AbortSignal) => Promise<T>
): Promise<T[]> {
    signal?.throwIfAborted();
    const controller = new AbortController(), results = new Array<T>(assemblies.length);
    const running = new Set<Promise<void>>();
    let next = 0, inheritedBusy = false, failed = false, failure: unknown;
    const fail = (error: unknown): void => {
        if (!failed) {failed = true; failure = error; controller.abort(error);}
    };
    const abort = (): void => fail(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const admit = (index: number, borrowed?: Promise<T>): void => {
        if (!borrowed) {inheritedBusy = true;}
        const pending = (borrowed ?? Promise.resolve().then(() => work(assemblies[index], controller.signal)))
            .then(result => {results[index] = result;}, fail).finally(() => {
                if (!borrowed) {inheritedBusy = false;}
                running.delete(pending);
            });
        running.add(pending);
    };
    try {
        while ((!failed && next < assemblies.length) || running.size) {
            if (!failed && !inheritedBusy && next < assemblies.length) {admit(next++);}
            while (!failed && next < assemblies.length) {
                const index = next;
                const borrowed = borrow(controller.signal, () => Promise.resolve().then(() => work(assemblies[index], controller.signal)));
                if (!borrowed) {break;}
                next++; admit(index, borrowed);
            }
            if (running.size) {await Promise.race(running);}
        }
    } catch (error) {fail(error);}
    finally {
        // No rollback, cache release or output removal may race an admitted instrument process.
        await Promise.all(running);
        signal?.removeEventListener('abort', abort);
    }
    if (failed) {throw failure;}
    signal?.throwIfAborted();
    return results;
}

export class RunnerSession {
    private readonly prepared = new Map<string, Preparation>();
    private readonly preparations = new Map<string, Promise<Preparation>>();
    private readonly discoveries = new Map<string, Promise<readonly TestFile[]>>();
    private readonly projects = new Map<string, Project>();
    private readonly lanes = new Map<string, RunnerLane[]>();
    private readonly unsafeParallel = new Set<string>();
    private laneSequence = 0;
    private readonly queues = new Map<string, Promise<void>>();
    private readonly running = new Set<Promise<FileRun>>();
    private readonly coverageReader = new CoverageReader();
    private outputLease?: RunOutputLease;
    private lease?: Promise<RunOutputLease>;
    private disposed = false;
    private disposal?: Promise<void>;
    private failed = false;
    private readonly toolContexts: Map<string, Promise<string>>;
    private readonly toolIdentities: Map<string, Promise<string>>;
    constructor(private readonly options: RunnerOptions) {
        this.toolContexts = options.preparationTools ?? new Map();
        this.toolIdentities = options.preparationToolIdentities ?? new Map();
    }

    async discover(project: Project): Promise<readonly TestFile[]> {
        this.assertOpen();
        const key = testTargetKey(project.file, project.framework);
        const existing = this.discoveries.get(key); if (existing) {return existing;}
        this.projects.set(key, project);
        const pending = this.discoverProject(project);
        this.discoveries.set(key, pending);
        try {return await pending;}
        catch (error) {this.failed = true; this.discoveries.delete(key); throw error;}
    }

    private async discoverProject(project: Project): Promise<readonly TestFile[]> {
        const preparation = await this.prepare({ id: testFileId(project.file, project.framework), project: project.file,
            assembly: project.assembly, framework: project.framework, tests: [] });
        const groups = (await discover({ ...project, assembly: path.join(preparation.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes))
            .map(group => ({ ...group, assembly: project.assembly }));
        preparation.groups = groups;
        return groups;
    }

    private async resolve(groups: readonly TestFile[]): Promise<{ preparation: Preparation; selected: TestNode[]; executedGroups: readonly TestFile[]; originals: ReadonlyMap<string, TestNode> }> {
        const group = groups[0];
        if (!group || groups.some(item => item.assembly !== group.assembly || item.project !== group.project || item.framework !== group.framework)) {throw new Error('A test batch must belong to one project and target framework.');}
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const preparation = await this.prepare(group);
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
        catch (error) {this.failed = true; throw error;}
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
            const lanes = this.lanes.get(key) ?? [];
            let slot = lanes.find(lane => !lane.busy);
            if (!slot) {
                const number = ++this.laneSequence, laneIndex = lanes.length + 1;
                slot = { busy: false, session: this.outputRoot().then(root => new RunnerSession({ ...this.options,
                    outputRoot: path.join(root, 'lanes', String(number)), preparationLane: laneIndex, preparationTools: this.toolContexts,
                    preparationToolIdentities: this.toolIdentities, deferCoverage: undefined, onPrepared: undefined,
                    tryInstrumentation: undefined })) };
                lanes.push(slot); this.lanes.set(key, lanes);
            }
            // Reserve before yielding; changing pool worker IDs must not grow the lane count.
            slot.busy = true;
            try {
                const lane = await slot.session;
                await lane.discover(project);
                const canonical = primary.groups!.find(item => item.id === group.id)!;
                if (this.matchesFile(canonical, primary, lane.prepared.get(key)!)) {return await lane.run(groups, hashes);}
                this.unsafeParallel.add(group.id);
                this.options.output?.(`Parallel test identities could not be matched for ${path.basename(group.file!)}; using its primary runner.\n`);
            } finally {
                slot.busy = false;
            }
        }
        // Fallbacks and partial selections share canonical native IDs and output.
        // They must remain serial even when several pool workers request them.
        const previous = this.queues.get(key) ?? Promise.resolve();
        const execution = previous.then(() => this.execute(groups, hashes));
        // Keep the rejection until every already-queued request has drained.
        // Engine cancellation may arrive after this promise's next microtask.
        const tail = execution.then(() => undefined);
        this.queues.set(key, tail);
        const clear = (): void => {if (this.queues.get(key) === tail) {this.queues.delete(key);}};
        void tail.then(clear, clear);
        return execution;
    }

    /** Never guess between indistinguishable rows or run a different file shape. */
    private matchesFile(group: TestFile, primary: Preparation, lane: Preparation): boolean {
        const local = lane.groups?.find(item => item.id === group.id && item.file === group.file);
        if (!local || local.tests.length !== group.tests.length) {return false;}
        const localIds = new Set(local.tests.map(test => test.id)), matched = new Set<string>();
        for (const test of group.tests) {
            const key = nodeKey(test.node as TestNode);
            let native = lane.nativeById.get(test.id);
            if (native && nodeKey(native) !== key) {return false;}
            if (!native) {
                const candidates = lane.byKey.get(key);
                if (candidates?.length !== 1 || primary.byKey.get(key)?.length !== 1) {return false;}
                native = candidates[0];
            }
            if (!localIds.has(native.uid) || matched.has(native.uid)) {return false;}
            matched.add(native.uid);
        }
        return matched.size === localIds.size;
    }

    private async execute(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>): Promise<FileRun> {
        this.options.signal?.throwIfAborted();
        const initial = await this.prepare(groups[0]);
        if (initial.coveragePending) {await this.prepareSelectedCoverage(groups[0], initial);}
        const { preparation, selected, executedGroups, originals } = await this.resolve(groups);
        const group = groups[0], options = { ...this.options, cwd: path.dirname(group.project) };
        if (preparation.runs++) {await preparation.output.restore(options.signal);}
        const report = path.join(preparation.root, `coverage-${preparation.runs}.xml`);
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
        const convert = testConverter();
        const unknown: TestFile = executedGroups.length === 1 ? executedGroups[0]
            : { ...group, id: `runtime:${testFileId(group.project, group.framework)}`, file: undefined, tests: [], excludedTestIds: undefined, runtimeOnly: true };
        const groupFor = (test: DiscoveredTest): TestFile => owner.get(test.id)
            ?? (test.file ? files.get(test.file) : undefined) ?? methods.get(methodKey(test.node) ?? '') ?? unknown;
        const selectedIds = new Set(selected.map(node => node.uid));
        const completeProject = preparation.nodes.every(node => selectedIds.has(node.uid));
        const assembly = path.join(preparation.output.directory, path.basename(group.assembly));
        let observation: RuntimeObservation | undefined;
        if (preparation.coverage) {
            try {
                observation = await RuntimeObservation.start(path.join(preparation.root, `modules-${preparation.runs}`), assembly,
                    options.modules ?? (options.assemblies ?? [group.assembly]).map(file => ({ name: path.basename(file, path.extname(file)), sources: [...hashes.keys()] })),
                    preparation.instrumented ?? [], options.env);
            } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Runtime observation unavailable; retaining conservative dependencies. ${String(error)}\n`);}
        }
        const nodes = await requestTests({
            ...options, env: observation?.env ?? options.env, expectedTests: selected, assembly,
            args: ['--results-directory', path.join(preparation.root, `results-${preparation.runs}`), ...options.testArguments],
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
        }, 'run', completeProject ? undefined : selected);
        options.signal?.throwIfAborted();
        const results = nodes.map(originalNode).map(testResult).filter((result): result is TestResult => !!result);
        if (!results.length) {throw new Error(`No test results were received for ${group.file ?? group.project}.`);}
        const coverage: FileCoverage[] = [];
        let available = preparation.coverage;
        if (available) {
            try {
                coverage.push(...await this.coverageReader.read(report, options.cwd, hashes, options.signal));
            } catch (error) {
                options.signal?.throwIfAborted(); available = false;
                this.failed = true;
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
        const reported = new Set(results.map(result => result.id));
        const reliable = executedGroups.length === 1 && available && observed && coverage.some(file => file.lines.some(line => line.hits > 0)) && !!executedGroups[0].file
            && results.every(result => result.outcome === 'passed') && executedGroups[0].tests.every(test => reported.has(test.id));
        return {
            results, coverageAvailable: available, executedGroups,
            trace: {
                groupId: executedGroups.length === 1 ? executedGroups[0].id : projectCoverageId(group), dependencies, moduleProjects, coverage, reliable, timestamp: Date.now(),
                inputs: Object.fromEntries(dependencies.map(file => [file, sourceVersion(hashes, file)]))
            }
        };
    }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.disposal ??= (async () => {
            await Promise.allSettled([...this.running, ...this.discoveries.values(), ...this.preparations.values()]);
            const lanes = await Promise.allSettled([...this.lanes.values()].flatMap(lanes => lanes.map(lane => lane.session)));
            const actions = [() => this.coverageReader.dispose(), ...lanes.filter((lane): lane is PromiseFulfilledResult<RunnerSession> => lane.status === 'fulfilled')
                .map(lane => () => lane.value.dispose()), ...[...this.prepared.values()].map(preparation => () => preparation.lease
                ? preparation.lease.release(!this.failed && !this.options.signal?.aborted) : removeOutput(preparation.root))];
            // Every private owner must be released even if another owner's cleanup fails.
            const cleaned = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
            this.prepared.clear();
            const outputs = await Promise.allSettled([Promise.resolve().then(() => this.outputLease?.dispose())]);
            const errors = [...cleaned, ...outputs].filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
            if (errors.length) {throw new AggregateError(errors, `Test runner cleanup failed: ${errors.map(String).join('; ')}`);}
        })();
    }

    private assertOpen(): void {if (this.disposed) {throw new Error('The test runner session has been disposed.');}}

    private async outputRoot(): Promise<string> {
        if (this.options.outputRoot) {return this.options.outputRoot;}
        if (!this.lease) {
            this.lease = claimRunOutputs(this.options.storage, this.options.identity, this.options.signal);
        }
        try {this.outputLease = await this.lease; return this.outputLease.directory;}
        catch (error) {this.lease = undefined; throw error;}
    }

    private async prepare(group: TestFile): Promise<Preparation> {
        const key = testTargetKey(group.project, group.framework);
        const existing = this.prepared.get(key); if (existing) {return existing;}
        const preparing = this.preparations.get(key); if (preparing) {return preparing;}
        const pending = this.prepareTarget(group);
        this.preparations.set(key, pending);
        try {return await pending;}
        finally {this.preparations.delete(key);}
    }

    private async prepareTarget(group: TestFile): Promise<Preparation> {
        const key = testTargetKey(group.project, group.framework);
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const source = options.snapshots?.get(key) ?? path.dirname(group.assembly);
        let lease: PreparedArtifactLease | undefined;
        if (options.preparedOutputCache) {
            let context: string | undefined;
            try {context = await this.preparationContext(group);}
            catch (error) {options.signal?.throwIfAborted(); options.output?.(`Prepared output caching unavailable for ${path.basename(group.project)}: ${String(error)}\n`);}
            lease = await options.preparedOutputCache.acquire(source, context ?? randomUUID(), async root => {
                const artifact = await this.createArtifact(group, source, root);
                return context ? artifact : { ...artifact, reusable: false };
            }, options.signal, JSON.stringify([key, options.preparationLane ?? 0]));
            options.output?.(`Prepared output cache ${lease?.hit ? 'hit' : 'miss'} for ${path.basename(group.project)} (${group.framework}).\n`);
        }
        let artifact: PreparedArtifact;
        if (lease) {artifact = lease.artifact;}
        else {
            const root = path.join(await this.outputRoot(), contentHash(key));
            await fs.mkdir(root, { recursive: true });
            try {artifact = await this.createArtifact(group, source, root);}
            catch (error) {await removeOutput(root); throw error;}
        }
        const root = artifact.root;
        try {
            if (artifact.coveragePending && !options.deferCoverage?.(group)) {
                artifact = await this.upgradeArtifact(group, source, artifact);
                await lease?.update(artifact, options.signal);
            }
            const { output, session, coverage, coveragePending, instrumented } = artifact;
            const prepared = { root, output, session, coverage, coveragePending, ...await this.discoverArtifact(group, output), instrumented, lease, runs: 0 };
            this.prepared.set(key, prepared); options.onPrepared?.(group.project);
            return prepared;
        } catch (error) {
            if (lease) {await lease.release(false);} else {await removeOutput(root);}
            throw error;
        }
    }

    private async discoverArtifact(group: TestFile, output: PreparedOutput): Promise<Pick<Preparation, 'nodes' | 'nativeById' | 'byKey'>> {
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const nodes = await requestTests({ ...options, assembly: path.join(output.directory, path.basename(group.assembly)), args: options.testArguments }, 'discover');
        // Discovery can also execute user code and mutate assets.
        await output.restore(options.signal);
        const nativeById = new Map<string, TestNode>(), byKey = new Map<string, TestNode[]>();
        let work = 0;
        for (const node of nodes) {
            nativeById.set(node.uid, node);
            const key = nodeKey(node); const matching = byKey.get(key) ?? []; matching.push(node); byKey.set(key, matching);
            if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
        }
        return { nodes, nativeById, byKey };
    }

    private async prepareSelectedCoverage(group: TestFile, preparation: Preparation): Promise<void> {
        const source = this.options.snapshots?.get(testTargetKey(group.project, group.framework)) ?? path.dirname(group.assembly);
        this.options.output?.(`Preparing coverage for selected ${path.basename(group.project)} (${group.framework}).\n`);
        const artifact = await this.upgradeArtifact(group, source, { root: preparation.root, output: preparation.output,
            session: preparation.session, coverage: preparation.coverage, coveragePending: true, instrumented: preparation.instrumented ?? [],
            reusable: preparation.lease?.artifact.reusable ?? true });
        await preparation.lease?.update(artifact, this.options.signal);
        Object.assign(preparation, artifact, await this.discoverArtifact(group, artifact.output));
        // Providers may derive IDs from the rewritten binary. Resolve selections only
        // against this refreshed inventory, retaining the ordinary ambiguity guards.
        const project = this.projects.get(testTargetKey(group.project, group.framework));
        if (project) {
            preparation.groups = (await discover({ ...project, assembly: path.join(artifact.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes))
                .map(item => ({ ...item, assembly: project.assembly }));
        }
    }

    private async preparationContext(group: TestFile): Promise<string> {
        const options = this.options;
        const cwd = path.dirname(group.project);
        let toolContext = this.toolContexts.get(cwd);
        if (!toolContext) {toolContext = (async () => {
            const env = this.preparationEnvironment();
            let tools: unknown;
            if (process.platform === 'win32') {tools = await windowsPreparationTools(options, env, cwd, this.toolIdentities);}
            else {
                const identities = await Promise.allSettled([options.dotnet, options.coverageTool, options.analyzer]
                    .map(command => preparationToolIdentity(command, env, options.signal, cwd, this.toolIdentities)));
                tools = identities.map(identity => {if (identity.status === 'rejected') {throw identity.reason;} return identity.value;});
            }
            return contentHash(JSON.stringify({ tools, env: Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
                arguments: options.testArguments, assemblies: [...(options.assemblies ?? [])].sort(), modules: options.modules,
                runtime: process.version, platform: process.platform, architecture: process.arch }));
        })(); this.toolContexts.set(cwd, toolContext);}
        // Bump when preparation semantics change; retained templates can cross editor lifetimes.
        return JSON.stringify({ version: process.platform === 'win32' ? 4 : 3, tools: await toolContext, project: group.project, framework: group.framework,
            assembly: group.assembly, context: options.preparationContexts?.get(testTargetKey(group.project, group.framework)) });
    }

    private preparationEnvironment(): NodeJS.ProcessEnv {
        const env = { ...process.env, ...this.options.env };
        if (this.options.managedCoverageTool) {env.SHLVL = undefined; env.VSCODE_PID = undefined;}
        return env;
    }

    private async createArtifact(group: TestFile, source: string, root: string): Promise<PreparedArtifact> {
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const template = path.join(root, 'template');
        const session = randomUUID();
        try {
            await copyOutput(source, template, options.signal);
            const coveragePending = !!options.coverageTool && !!options.deferCoverage?.(group);
            if (coveragePending) {options.output?.(`Deferring coverage preparation for ${path.basename(group.project)} (${group.framework}) until selection.\n`);}
            const { coverage, instrumented } = coveragePending ? { coverage: false, instrumented: [] }
                : await this.instrumentTemplate(group, source, template, root, session);
            const output = new PreparedOutput(template, path.join(root, 'assembly'));
            await output.initialize(options.signal);
            return { root, output, session, coverage, coveragePending, instrumented, reusable: coveragePending || coverage === !!options.coverageTool };
        } catch (error) {await removeOutput(root); throw error;}
    }

    private async upgradeArtifact(group: TestFile, source: string, artifact: PreparedArtifact): Promise<PreparedArtifact> {
        const { coverage, instrumented } = await this.instrumentTemplate(group, source, artifact.output.template, artifact.root, artifact.session);
        const output = new PreparedOutput(artifact.output.template, artifact.output.directory);
        await removeOutput(output.directory);
        await output.initialize(this.options.signal);
        return { ...artifact, output, coverage, coveragePending: false, instrumented, reusable: artifact.reusable && coverage === !!this.options.coverageTool };
    }

    private async instrumentTemplate(group: TestFile, source: string, template: string, root: string, session: string): Promise<{ coverage: boolean; instrumented: string[] }> {
        const options = { ...this.options, cwd: path.dirname(group.project),
            env: this.options.managedCoverageTool ? this.preparationEnvironment() : this.options.env };
        let coverage = !!options.coverageTool;
        const instrumented: string[] = [];
        if (coverage) {
            const assemblies = new Set((options.assemblies ?? [group.assembly]).map(assemblyName));
            const files = await workspaceOutputs(template, assemblies, options.signal);
            const instrument = async (assembly: string, signal: AbortSignal | undefined): Promise<string | undefined> => {
                const before = await fileHash(assembly, signal);
                requireSuccess(await runProcess(options.coverageTool!, ['instrument', assembly, '--session-id', session, '--nologo'],
                    { ...options, signal }), `Instrumenting ${path.basename(assembly)}`);
                // The collector can exit 0 after skipping a module (for
                // example, no_symbols). An unchanged DLL must retain its
                // whole-module dependency when the observer sees it load.
                if (await fileHash(assembly, signal) !== before) {
                    return path.join(root, 'assembly', path.relative(template, assembly));
                }
                options.output?.(`No instrumentation change in ${path.basename(assembly)}; retaining module dependencies.\n`);
                return undefined;
            };
            try {
                if (options.managedCoverageTool && options.tryInstrumentation) {
                    const results = await instrumentWithSpareCapacity(files, options.signal, options.tryInstrumentation, instrument);
                    instrumented.push(...results.filter((assembly): assembly is string => assembly !== undefined));
                } else {
                    for (const assembly of files) {const result = await instrument(assembly, options.signal); if (result) {instrumented.push(result);}}
                }
            } catch (error) {
                options.signal?.throwIfAborted(); coverage = false;
                options.output?.(`Coverage preparation failed; running tests without collection. ${String(error)}\n`);
                // All sibling commands have drained before restoring the pristine template.
                await removeOutput(template);
                await copyOutput(source, template, options.signal);
            }
        }
        return { coverage, instrumented };
    }
}

export async function runTestFile(group: TestFile, hashes: ReadonlyMap<string, string>, options: RunnerOptions): Promise<FileRun> {
    const session = new RunnerSession(options);
    try {return await session.run([group], hashes);} finally {await session.dispose();}
}
