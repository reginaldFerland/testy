import * as path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DiscoveredTest, Project, TestFile } from '../core/model';
import { preparePathNormalizer, testFileId } from '../core/paths';
import { requestTests, testConverter, TestNode } from './mtp';
import { sourceLocations } from './analysis';
import { nodeText } from '../core/testUpdates';
import type { RunnerOptions } from './runnerTypes';

export async function discover(project: Project, options: RunnerOptions, discovered?: readonly TestNode[]): Promise<readonly TestFile[]> {
    const nodes = discovered ?? await requestTests({ ...options, cwd: path.dirname(project.file), assembly: project.assembly, args: options.testArguments }, 'discover');
    let locations: Awaited<ReturnType<typeof sourceLocations>> | undefined;
    if (options.analyzer && nodes.some(node => !node['location.file'])) {
        try {
            locations = await sourceLocations(options.dotnet, options.analyzer, project.assembly, options.storage, options);
        } catch (error) {options.signal?.throwIfAborted(); options.output?.(`Test source locations unavailable; retaining project fallback. ${String(error)}\n`);}
    }
    const byFile = new Map<string, DiscoveredTest[]>();
    const sources = new Set(project.sourceFiles), located: TestNode[] = [];
    let work = 0;
    options.signal?.throwIfAborted();
    for (let node of nodes) {
        if (!node['location.file'] && locations) {
            const location = locations.get(`${nodeText(node, 'location.type')}.${nodeText(node, 'location.method').split('(')[0]}`);
            if (location && sources.has(location.file)) {node = { ...node, 'location.file': location.file, 'location.line-start': location.line };}
        }
        located.push(node);
        if (++work % 512 === 0) {await yieldTurn(); options.signal?.throwIfAborted();}
    }
    const normalize = await preparePathNormalizer([project.file, ...locationFiles(located)], options.signal), convert = testConverter(normalize);
    for (const node of located) {
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

export function locationFiles(nodes: Iterable<TestNode>): string[] {
    const files: string[] = [];
    for (const node of nodes) {if (typeof node['location.file'] === 'string') {files.push(node['location.file']);}}
    return files;
}

export function nodeKey(node: TestNode): string {
    return JSON.stringify(['display-name', 'location.type', 'location.method', 'location.method-arity'].map(key => node[key] ?? null));
}

export function methodKey(node: Readonly<Record<string, unknown>>): string | undefined {
    return typeof node['location.type'] === 'string' && typeof node['location.method'] === 'string'
        ? JSON.stringify([node['location.type'], node['location.method'].split('(')[0]]) : undefined;
}
