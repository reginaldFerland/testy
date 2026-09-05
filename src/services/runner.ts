import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult, Trace } from '../core/model';
import { contentHash, normalizePath, testFileId, testTargetKey } from '../core/paths';
import { discoveredTest, requestTests, TestNode, testResult } from './mtp';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { CoverageReader } from './coverageReader';
import { copyOutput, PreparedOutput, removeOutput } from './output';
import { sourceLocations } from './analysis';
import { claimRunOutputs, RunOutputLease } from './runOutputs';

export interface RunnerOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly storage: string;
    readonly testArguments: readonly string[];
    readonly coverageTool?: string;
    readonly assemblies?: readonly string[];
    readonly buildInputs?: ReadonlyMap<string, readonly string[]>;
    readonly analyzer?: string;
    /** Stable within an engine, isolated from every other extension instance. */
    readonly identity?: string;
    readonly outputRoot?: string;
    readonly snapshots?: ReadonlyMap<string, string>;
    readonly onResult?: (group: TestFile, result: TestResult) => void;
    readonly onStarted?: (group: TestFile, id: string) => void;
    readonly onPrepared?: (project: string) => void;
    readonly onExpanded?: (groups: readonly TestFile[]) => void;
}

export async function discover(project: Project, options: RunnerOptions, discovered?: readonly TestNode[]): Promise<readonly TestFile[]> {
    let nodes = discovered ?? await requestTests({ ...options, cwd: path.dirname(project.file), assembly: project.assembly, args: options.testArguments }, 'discover');
    if (options.analyzer && nodes.some(node => !node['location.file'])) {
        try {
            const locations = await sourceLocations(options.dotnet, options.analyzer, project.assembly, options.storage, options);
            nodes = nodes.map(node => {
                if (node['location.file']) {return node;}
                const key = `${node['location.type']}.${String(node['location.method'] ?? '').split('(')[0]}`;
                const location = locations.get(key);
                return location && project.sourceFiles.includes(location.file) ? { ...node, 'location.file': location.file, 'location.line-start': location.line } : node;
            });
        } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Test source locations unavailable; retaining project fallback. ${String(error)}\n`);}
    }
    const byFile = new Map<string, DiscoveredTest[]>();
    for (const node of nodes) {
        const test = discoveredTest(node), key = test.file ?? '';
        const tests = byFile.get(key) ?? []; tests.push(test); byFile.set(key, tests);
    }
    return [...byFile].map(([file, tests]) => ({
        id: testFileId(project.file, project.framework, file || undefined), project: project.file,
        framework: project.framework, assembly: project.assembly, file: file || undefined, tests
    }));
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
    readonly root: string; readonly output: PreparedOutput; readonly session: string; readonly coverage: boolean;
    readonly nodes: readonly TestNode[]; readonly nativeById: ReadonlyMap<string, TestNode>;
    readonly byKey: ReadonlyMap<string, readonly TestNode[]>; groups?: readonly TestFile[]; runs: number;
}

function nodeKey(node: TestNode): string {
    return JSON.stringify(['display-name', 'location.type', 'location.method', 'location.method-arity'].map(key => node[key] ?? null));
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

export class RunnerSession {
    private readonly prepared = new Map<string, Preparation>();
    private readonly coverageReader = new CoverageReader();
    private outputLease?: RunOutputLease;
    constructor(private readonly options: RunnerOptions) {}

    async discover(project: Project): Promise<readonly TestFile[]> {
        const preparation = await this.prepare({ id: testFileId(project.file, project.framework), project: project.file,
            assembly: project.assembly, framework: project.framework, tests: [] });
        const groups = (await discover({ ...project, assembly: path.join(preparation.output.directory, path.basename(project.assembly)) }, this.options, preparation.nodes))
            .map(group => ({ ...group, assembly: project.assembly }));
        preparation.groups = groups;
        return groups;
    }

    async run(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>): Promise<FileRun> {
        const group = groups[0];
        if (!group || groups.some(item => item.assembly !== group.assembly || item.project !== group.project || item.framework !== group.framework)) {throw new Error('A test batch must belong to one project and target framework.');}
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const preparation = await this.prepare(group);
        if (preparation.runs++) {await preparation.output.restore(options.signal);}
        const report = path.join(preparation.root, `coverage-${preparation.runs}.xml`);
        // Discovery and execution use one stable private path, so exact native
        // UIDs work even when displayed theory names are indistinguishable.
        const { nativeById, byKey } = preparation;
        const originals = new Map<string, TestNode>();
        const selectedNodes = new Map<string, TestNode>();
        const forbidden = new Set<string>();
        for (const item of groups) {for (const id of item.excludedTestIds ?? []) {
            const native = nativeById.get(id);
            if (!native) {throw new Error('The provider cannot honor an exclusion for a runtime or changed test identity. Select tests using the refreshed discovery identities.');}
            forbidden.add(native.uid);
        }}
        let expanded = false;
        for (const item of groups) {for (const test of item.tests) {
            let native = nativeById.get(test.id);
            if (!native) {const matching = byKey.get(nodeKey(test.node as TestNode)); if (matching?.length === 1) {native = matching[0];}}
            if (native) {
                if (!forbidden.has(native.uid)) {originals.set(native.uid, test.node as TestNode); selectedNodes.set(native.uid, native);}
                continue;
            }
            // Runtime-only rows may not be individually selectable. Use the
            // freshly discovered containing file; never send an unresolved UID
            // from an old path or guess between indistinguishable row names.
            const containing = preparation.groups?.find(group => group.id === item.id);
            if (!containing) {throw new Error('The selected test identity is unavailable. Rediscover the project before rerunning it.');}
            for (const candidate of containing.tests) {const node = nativeById.get(candidate.id); if (node && !forbidden.has(node.uid)) {selectedNodes.set(node.uid, node);}}
            expanded = true;
        }}
        const selected = [...selectedNodes.values()];
        if (!selected.length) {throw new Error('No selectable tests remain after applying exclusions.');}
        const executedGroups = expanded ? preparation.groups!.map(item => ({ ...item, tests: item.tests.filter(test => selectedNodes.has(test.id)) }))
            .filter(item => item.tests.length) : groups;
        if (expanded) {
            options.output?.('The provider cannot select this runtime or changed test identity individually; running its containing test file.\n');
            options.onExpanded?.(executedGroups);
        }
        const originalNode = (node: TestNode): TestNode => {
            const original = originals.get(node.uid);
            return original ? { ...original, ...node, uid: original.uid } : node;
        };
        const owner = new Map([...groups, ...executedGroups].flatMap(item => item.tests.map(test => [test.id, item] as const)));
        const groupFor = (node: TestNode): TestFile => owner.get(node.uid)
            ?? executedGroups.find(item => item.file === discoveredTest(node).file) ?? group;
        const selectedIds = new Set(selected.map(node => node.uid));
        const completeProject = preparation.nodes.every(node => selectedIds.has(node.uid));
        const nodes = await requestTests({
            ...options, expectedTests: selected, assembly: path.join(preparation.output.directory, path.basename(group.assembly)),
            args: ['--results-directory', path.join(preparation.root, `results-${preparation.runs}`), ...options.testArguments],
            wrapper: preparation.coverage ? {
                command: options.coverageTool!, args: ['collect', '--nologo', '--session-id', preparation.session, '-f', 'cobertura', '-o', report]
            } : undefined,
            onNode: native => {
                const node = originalNode(native);
                const item = groupFor(node);
                if (node['execution-state'] === 'in-progress') {options.onStarted?.(item, node.uid);}
                const result = testResult(node); if (result) {options.onResult?.(item, result);}
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
                options.output?.(`Coverage unavailable for ${path.basename(group.project)}; test results are retained. ${String(error)}\n`);
            }
        }
        const dependencies = [...new Set([...coverage.filter(file => file.lines.some(line => line.hits > 0)).map(file => file.file),
            ...executedGroups.flatMap(item => this.options.buildInputs?.get(item.project) ?? []),
            ...executedGroups.map(item => item.file).filter((file): file is string => !!file)])];
        const reported = new Set(results.map(result => result.id));
        const reliable = executedGroups.length === 1 && available && coverage.some(file => file.lines.some(line => line.hits > 0)) && !!group.file
            && results.every(result => result.outcome === 'passed') && executedGroups[0].tests.every(test => reported.has(test.id));
        return {
            results, coverageAvailable: available, executedGroups,
            trace: {
                groupId: executedGroups.length === 1 ? group.id : projectCoverageId(group), dependencies, coverage, reliable, timestamp: Date.now(),
                inputs: Object.fromEntries(dependencies.filter(file => hashes.has(file)).map(file => [file, hashes.get(file)!]))
            }
        };
    }

    async dispose(): Promise<void> {
        await this.coverageReader.dispose();
        for (const preparation of this.prepared.values()) {await removeOutput(preparation.root);}
        this.prepared.clear();
        await this.outputLease?.dispose();
    }

    private async prepare(group: TestFile): Promise<Preparation> {
        const key = testTargetKey(group.project, group.framework);
        const existing = this.prepared.get(key); if (existing) {return existing;}
        const options = { ...this.options, cwd: path.dirname(group.project) };
        if (!options.outputRoot && !this.outputLease) {this.outputLease = await claimRunOutputs(options.storage, options.identity, options.signal);}
        const root = path.join(options.outputRoot ?? this.outputLease!.directory, contentHash(key));
        await fs.mkdir(root, { recursive: true });
        const source = options.snapshots?.get(key) ?? path.dirname(group.assembly);
        const template = path.join(root, 'template');
        const session = randomUUID();
        let coverage = !!options.coverageTool;
        try {
            await copyOutput(source, template, options.signal);
            if (coverage) {
                const assemblies = new Set((options.assemblies ?? [group.assembly]).map(assemblyName));
                for (const assembly of await workspaceOutputs(template, assemblies, options.signal)) {
                    try {
                        requireSuccess(await runProcess(options.coverageTool!, ['instrument', assembly, '--session-id', session, '--nologo'], options), `Instrumenting ${path.basename(assembly)}`);
                    } catch (error) {
                        options.signal?.throwIfAborted(); coverage = false;
                        options.output?.(`Coverage preparation failed; running tests without collection. ${String(error)}\n`);
                        // Never execute partially instrumented output without its collector.
                        await removeOutput(template);
                        await copyOutput(source, template, options.signal); break;
                    }
                }
            }
            const output = new PreparedOutput(template, path.join(root, 'assembly'));
            await output.initialize(options.signal);
            const nodes = await requestTests({ ...options, assembly: path.join(output.directory, path.basename(group.assembly)), args: options.testArguments }, 'discover');
            // Discovery can also execute user code and mutate assets.
            await output.restore(options.signal);
            const nativeById = new Map(nodes.map(node => [node.uid, node]));
            const byKey = new Map<string, TestNode[]>();
            for (const node of nodes) {const key = nodeKey(node); const matching = byKey.get(key) ?? []; matching.push(node); byKey.set(key, matching);}
            const prepared = { root, output, session, coverage, nodes, nativeById, byKey, runs: 0 };
            this.prepared.set(key, prepared); options.onPrepared?.(group.project);
            return prepared;
        } catch (error) {await removeOutput(root); throw error;}
    }
}

export async function runTestFile(group: TestFile, hashes: ReadonlyMap<string, string>, options: RunnerOptions): Promise<FileRun> {
    const session = new RunnerSession(options);
    try {return await session.run([group], hashes);} finally {await session.dispose();}
}
