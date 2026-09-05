import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { DiscoveredTest, FileCoverage, Project, TestFile, TestResult, Trace } from '../core/model';
import { contentHash, normalizePath, testFileId } from '../core/paths';
import { discoveredTest, requestTests, TestNode, testResult } from './mtp';
import { ProcessOptions } from './process';
import { parseCobertura } from './reports';

export interface RunnerOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly storage: string;
    readonly testArguments: readonly string[];
    readonly coverageTool?: string;
    readonly onResult?: (group: TestFile, result: TestResult) => void;
    readonly onStarted?: (group: TestFile, id: string) => void;
}

export async function discover(project: Project, options: RunnerOptions): Promise<readonly TestFile[]> {
    const nodes = await requestTests({ ...options, assembly: project.assembly, args: options.testArguments }, 'discover');
    const byFile = new Map<string, DiscoveredTest[]>();
    for (const node of nodes) {
        const test = discoveredTest(node);
        const key = test.file ?? '';
        const tests = byFile.get(key) ?? [];
        tests.push(test); byFile.set(key, tests);
    }
    return [...byFile].map(([file, tests]) => ({
        id: testFileId(project.file, project.framework, file || undefined), project: project.file,
        framework: project.framework, assembly: project.assembly, file: file || undefined, tests
    }));
}

export async function sourceHashes(projects: readonly Project[]): Promise<ReadonlyMap<string, string>> {
    const hashes = new Map<string, string>();
    for (const file of new Set(projects.flatMap(project => [...project.sourceFiles]))) {
        try { hashes.set(file, contentHash(await fs.readFile(file))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;} }
    }
    return hashes;
}

export interface FileRun { readonly results: readonly TestResult[]; readonly trace: Trace; }

export async function runTestFile(group: TestFile, hashes: ReadonlyMap<string, string>, options: RunnerOptions): Promise<FileRun> {
    await fs.mkdir(options.storage, { recursive: true });
    const directory = await fs.mkdtemp(path.join(options.storage, 'run-'));
    try {
        options.signal?.throwIfAborted();
        const shadow = path.join(directory, 'assembly');
        await fs.cp(path.dirname(group.assembly), shadow, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: file => !/(^|[/\\])TestResults([/\\]|$)/.test(file) });
        options.signal?.throwIfAborted();
        const report = path.join(directory, 'coverage.xml');
        const nodes = await requestTests({
            ...options, assembly: path.join(shadow, path.basename(group.assembly)),
            args: ['--results-directory', path.join(directory, 'results'), ...options.testArguments],
            wrapper: options.coverageTool ? {
                command: options.coverageTool,
                args: ['collect', '--nologo', '--include-files', path.join(shadow, '*.dll'), '-f', 'cobertura', '-o', report]
            } : undefined,
            onNode: node => {
                if (node['execution-state'] === 'in-progress') {options.onStarted?.(group, node.uid);}
                const result = testResult(node);
                if (result) {options.onResult?.(group, result);}
            }
        }, 'run', group.tests.map(test => test.node as TestNode));
        options.signal?.throwIfAborted();
        const results = nodes.map(testResult).filter((result): result is TestResult => result !== undefined);
        if (!results.length) {throw new Error(`No test results were received for ${group.file ?? group.project}.`);}
        const coverage: FileCoverage[] = [];
        if (options.coverageTool) {
            const parsed = parseCobertura(await fs.readFile(report, 'utf8'), options.cwd, new Set(hashes.keys()));
            for (const [file, lines] of parsed) {coverage.push({ file, hash: hashes.get(file)!, lines });}
            if (!coverage.some(file => file.lines.some(line => line.hits > 0))) {throw new Error('The coverage collector reported no executed workspace code. Check that portable debug symbols are enabled.');}
        }
        const dependencies = coverage.filter(file => file.lines.some(line => line.hits > 0)).map(file => normalizePath(file.file));
        if (group.file) {dependencies.push(normalizePath(group.file));}
        const reliable = !!options.coverageTool && !!group.file
            && results.every(result => result.outcome === 'passed')
            && group.tests.every(test => results.some(result => result.id === test.id));
        return { results, trace: { groupId: group.id, dependencies: [...new Set(dependencies)], coverage, reliable, timestamp: Date.now() } };
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}
