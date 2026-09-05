import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult, Trace } from '../core/model';
import { contentHash, normalizePath, testFileId } from '../core/paths';
import { discoveredTest, requestTests, TestNode, testResult } from './mtp';
import { ProcessOptions, requireSuccess, runProcess } from './process';
import { parseCobertura } from './reports';
import { copyOutput, PreparedOutput } from './output';
import { sourceLocations } from './analysis';

export interface RunnerOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly storage: string;
    readonly testArguments: readonly string[];
    readonly coverageTool?: string;
    readonly assemblies?: readonly string[];
    readonly analyzer?: string;
    readonly onResult?: (group: TestFile, result: TestResult) => void;
    readonly onStarted?: (group: TestFile, id: string) => void;
    readonly onPrepared?: (project: string) => void;
}

export async function discover(project: Project, options: RunnerOptions): Promise<readonly TestFile[]> {
    let nodes = await requestTests({ ...options, cwd: path.dirname(project.file), assembly: project.assembly, args: options.testArguments }, 'discover');
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
}
interface Preparation { readonly root: string; readonly output: PreparedOutput; readonly session: string; readonly coverage: boolean; readonly nodes: readonly TestNode[]; runs: number; }

function nodeKey(node: TestNode): string {
    return JSON.stringify(['display-name', 'location.type', 'location.method', 'location.method-arity'].map(key => node[key] ?? null));
}

async function workspaceOutputs(directory: string, names: ReadonlySet<string>, signal?: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {files.push(...await workspaceOutputs(file, names, signal));}
        else if (entry.isFile() && names.has(entry.name)) {files.push(file);}
    }
    return files;
}

export class RunnerSession {
    private readonly prepared = new Map<string, Preparation>();
    constructor(private readonly options: RunnerOptions) {}

    async run(groups: readonly TestFile[], hashes: ReadonlyMap<string, string>): Promise<FileRun> {
        const group = groups[0];
        if (!group || groups.some(item => item.assembly !== group.assembly)) {throw new Error('A test batch must belong to one project and target framework.');}
        const options = { ...this.options, cwd: path.dirname(group.project) };
        const preparation = await this.prepare(group);
        if (preparation.runs++) {await preparation.output.restore(options.signal);}
        const report = path.join(preparation.root, `coverage-${preparation.runs}.xml`);
        // Some providers include the assembly path in their UIDs. Match their
        // private-output discovery back to the original UI identities.
        const nativeById = new Map(preparation.nodes.map(node => [node.uid, node]));
        const byKey = new Map<string, TestNode[]>();
        for (const node of preparation.nodes) {const key = nodeKey(node); const nodes = byKey.get(key) ?? []; nodes.push(node); byKey.set(key, nodes);}
        const originals = new Map<string, TestNode>();
        const selected = groups.flatMap(item => item.tests.map(test => {
            const matching = byKey.get(nodeKey(test.node as TestNode));
            const native = nativeById.get(test.id) ?? (matching?.length === 1 ? matching[0] : undefined);
            if (native) {originals.set(native.uid, test.node as TestNode);}
            return native ?? test.node as TestNode;
        }));
        const originalNode = (node: TestNode): TestNode => {
            const original = originals.get(node.uid);
            return original ? { ...original, ...node, uid: original.uid } : node;
        };
        const owner = new Map(groups.flatMap(item => item.tests.map(test => [test.id, item] as const)));
        const groupFor = (node: TestNode): TestFile => owner.get(node.uid)
            ?? groups.find(item => item.file === discoveredTest(node).file) ?? group;
        const nodes = await requestTests({
            ...options, assembly: path.join(preparation.output.directory, path.basename(group.assembly)),
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
        }, 'run', selected);
        options.signal?.throwIfAborted();
        const results = nodes.map(originalNode).map(testResult).filter((result): result is TestResult => !!result);
        if (!results.length) {throw new Error(`No test results were received for ${group.file ?? group.project}.`);}
        const coverage: FileCoverage[] = [];
        let available = preparation.coverage;
        if (available) {
            try {
                const parsed = parseCobertura(await fs.readFile(report, 'utf8'), options.cwd, new Set(hashes.keys()));
                for (const [file, lines] of parsed) {coverage.push({ file, hash: hashes.get(file)!, lines });}
            } catch (error) {
                options.signal?.throwIfAborted(); available = false;
                options.output?.(`Coverage unavailable for ${path.basename(group.project)}; test results are retained. ${String(error)}\n`);
            }
        }
        const dependencies = [...new Set([...coverage.filter(file => file.lines.some(line => line.hits > 0)).map(file => file.file),
            ...groups.map(item => item.file).filter((file): file is string => !!file)])];
        const reliable = groups.length === 1 && available && coverage.some(file => file.lines.some(line => line.hits > 0)) && !!group.file
            && results.every(result => result.outcome === 'passed') && group.tests.every(test => results.some(result => result.id === test.id));
        return {
            results, coverageAvailable: available,
            trace: {
                groupId: groups.length === 1 ? group.id : projectCoverageId(group), dependencies, coverage, reliable, timestamp: Date.now(),
                inputs: Object.fromEntries(dependencies.filter(file => hashes.has(file)).map(file => [file, hashes.get(file)!]))
            }
        };
    }

    async dispose(): Promise<void> {
        for (const preparation of this.prepared.values()) {await fs.rm(preparation.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });}
        this.prepared.clear();
    }

    private async prepare(group: TestFile): Promise<Preparation> {
        const existing = this.prepared.get(group.assembly); if (existing) {return existing;}
        const options = { ...this.options, cwd: path.dirname(group.project) };
        await fs.mkdir(options.storage, { recursive: true });
        const root = await fs.mkdtemp(path.join(options.storage, 'run-'));
        const template = path.join(root, 'template');
        const session = randomUUID();
        let coverage = !!options.coverageTool;
        try {
            await copyOutput(path.dirname(group.assembly), template, options.signal);
            if (coverage) {
                const assemblies = new Set((options.assemblies ?? [group.assembly]).map(file => path.basename(file)));
                for (const assembly of await workspaceOutputs(template, assemblies, options.signal)) {
                    try {
                        requireSuccess(await runProcess(options.coverageTool!, ['instrument', assembly, '--session-id', session, '--nologo'], options), `Instrumenting ${path.basename(assembly)}`);
                    } catch (error) {
                        options.signal?.throwIfAborted(); coverage = false;
                        options.output?.(`Coverage preparation failed; running tests without collection. ${String(error)}\n`);
                        // Never execute partially instrumented output without its collector.
                        await fs.rm(template, { recursive: true, force: true });
                        await copyOutput(path.dirname(group.assembly), template, options.signal); break;
                    }
                }
            }
            const output = new PreparedOutput(template, path.join(root, 'assembly'));
            await output.initialize(options.signal);
            const nodes = await requestTests({ ...options, assembly: path.join(output.directory, path.basename(group.assembly)), args: options.testArguments }, 'discover');
            // Discovery can also execute user code and mutate assets.
            await output.restore(options.signal);
            const prepared = { root, output, session, coverage, nodes, runs: 0 };
            this.prepared.set(group.assembly, prepared); options.onPrepared?.(group.project);
            return prepared;
        } catch (error) {await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); throw error;}
    }
}

export async function runTestFile(group: TestFile, hashes: ReadonlyMap<string, string>, options: RunnerOptions): Promise<FileRun> {
    const session = new RunnerSession(options);
    try {return await session.run([group], hashes);} finally {await session.dispose();}
}
