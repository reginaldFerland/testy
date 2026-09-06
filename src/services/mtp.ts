import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { DiscoveredTest, TestResult } from '../core/model';
import { normalizePath, pathNormalizer } from '../core/paths';
import { mergeTestUpdate, TestNode } from '../core/testUpdates';
import { OwnedProcess, ProcessOptions, startProcess } from './process';

export type { TestNode } from '../core/testUpdates';
interface TestUpdates { readonly runId: string; readonly changes: readonly { readonly node: TestNode }[] | null; }
interface InitializeResult { readonly capabilities: { readonly testing: { readonly supportsDiscovery: boolean } }; }

export interface MtpOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly assembly: string;
    readonly args?: readonly string[];
    /** A coverage collector can wrap the same owned MTP process. */
    readonly wrapper?: { readonly command: string; readonly args: readonly string[] };
    readonly onNode?: (node: TestNode) => void;
    readonly expectedTests?: readonly TestNode[];
}

/** MTP's IDE protocol, transported over a loopback socket using Content-Length framing. */
export async function requestTests(options: MtpOptions, operation: 'discover' | 'run', tests?: readonly TestNode[]): Promise<readonly TestNode[]> {
    options.signal?.throwIfAborted();
    const server = net.createServer();
    let socket: net.Socket | undefined;
    let rpc: MessageConnection | undefined;
    let process: OwnedProcess | undefined;
    let connectionTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
        });
        const port = (server.address() as net.AddressInfo).port;
        const connected = new Promise<net.Socket>((resolve, reject) => {
            connectionTimer = setTimeout(() => reject(new Error('The test application did not connect to Testy. Use a .NET 10+ Microsoft.Testing.Platform project.')), 30_000);
            server.on('connection', candidate => {
                if (socket) { candidate.destroy(); return; }
                socket = candidate;
                clearTimeout(connectionTimer);
                resolve(candidate);
            });
            server.once('error', reject);
        });
        const args = [options.assembly, '--server', '--client-port', String(port), ...options.args ?? []];
        const ownedOptions = { ...options, cleanupDescendants: true };
        process = options.wrapper
            ? startProcess(options.wrapper.command, [...options.wrapper.args, options.dotnet, ...args], ownedOptions)
            : startProcess(options.dotnet, args, ownedOptions);
        const peer = await Promise.race([
            connected,
            process.done.then(result => { throw new Error(`The test application exited before connecting (exit ${result.code}).\n${result.stderr || result.stdout}`); })
        ]);
        // Some MTP server versions count incoming JSON characters as bytes.
        // JSON escapes preserve Unicode names and paths while making framing
        // unambiguous for both those peers and conforming UTF-8 readers.
        const writer = new StreamMessageWriter(peer, { contentTypeEncoder: {
            name: 'application/json',
            encode: async message => Buffer.from(JSON.stringify(message).replace(/[\u007f-\uffff]/g,
                character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`), 'utf8')
        } });
        rpc = createMessageConnection(new StreamMessageReader(peer), writer);
        // Closing a transport does not itself reject vscode-jsonrpc's pending
        // requests. Disposal is essential when a cancelled/crashed runner exits.
        // Give process exit/timeout its diagnostic before RPC disposal rejects
        // outstanding requests with an otherwise unhelpful transport error.
        rpc.onClose(() => {closeTimer = setTimeout(() => rpc?.dispose(), 100);});
        const exited = process.done.then(result => {
            throw new Error(`The test application exited during ${operation} (exit ${result.code}).\n${result.stderr || result.stdout}`);
        });
        void exited.catch(() => undefined);
        const request = <T>(method: string, parameters: object): Promise<T> => Promise.race([rpc!.sendRequest<T>(method, parameters), exited]);
        const nodes = new Map<string, TestNode>();
        const pendingOutput = new Map<string, { stdout: string[]; stderr: string[] }>();
        const runId = randomUUID();
        let completed = false;
        rpc.onNotification('testing/testUpdates/tests', (update: TestUpdates) => {
            if (update.runId !== runId) {return;}
            if (update.changes === null) { completed = true; return; }
            for (const { node } of update.changes ?? []) {
                const previous = nodes.get(node.uid);
                const merged = operation === 'run' ? mergeTestUpdate(previous, node) : { ...previous, ...node };
                nodes.set(node.uid, merged);
                if (merged === previous) {continue;} // An older retry update.
                const output = pendingOutput.get(node.uid) ?? { stdout: [], stderr: [] };
                if (typeof node.standardOutput === 'string') {output.stdout.push(node.standardOutput);}
                if (typeof node.standardError === 'string') {output.stderr.push(node.standardError);}
                pendingOutput.set(node.uid, output);
                const terminal = isTerminal(merged);
                // Keep complete snapshots for result accounting, but publish
                // output only once. Preserve output received before completion.
                options.onNode?.({ ...merged, standardOutput: terminal ? output.stdout.join('') : undefined,
                    standardError: terminal ? output.stderr.join('') : undefined });
                if (terminal) {pendingOutput.delete(node.uid);}
            }
        });
        rpc.onNotification('client/log', (message: { level?: string | number; message?: string }) => {
            if (message.level === 'Error' || message.level === 'Warning' || (typeof message.level === 'number' && message.level >= 3)) {options.output?.(`${message.message ?? ''}\n`);}
        });
        rpc.onNotification('telemetry/update', () => undefined);
        rpc.onNotification('testing/testUpdates/attachments', () => undefined);
        rpc.listen();
        const initialized = await request<InitializeResult>('initialize', {
            processId: global.process.pid,
            clientInfo: { name: 'Testy', version: '1.0.0' },
            capabilities: { testing: { debuggerProvider: false, isStateful: true } }
        });
        if (!initialized.capabilities?.testing?.supportsDiscovery && operation === 'discover') {throw new Error('This MTP test framework does not support discovery.');}
        await request(operation === 'discover' ? 'testing/discoverTests' : 'testing/runTests', { runId, ...(tests ? { tests } : {}) });
        if (!completed) {throw new Error('The test runner ended without a complete test update stream.');}
        await rpc.sendNotification('exit', {});
        const result = await process.done;
        if (result.code !== 0 && (operation === 'discover' || result.code !== 2)) {throw new Error(`The test application failed during ${operation} (exit ${result.code}).\n${result.stderr || result.stdout}`);}
        if (operation === 'discover') {
            const failure = [...nodes.values()].find(node => ['failed', 'errored'].includes(testResult(node)?.outcome ?? ''));
            if (failure) {throw new Error(`Test discovery failed: ${failure['display-name'] ?? failure.uid}. ${failure['error.message'] ?? ''}`);}
        }
        const failedGroup = [...nodes.values()].find(node => node['node-type'] === 'group' && ['failed', 'errored'].includes(testResult(node)?.outcome ?? ''));
        if (operation === 'run' && failedGroup) {throw new Error(`The test group failed: ${failedGroup['display-name'] ?? failedGroup.uid}. ${failedGroup['error.message'] ?? ''}`);}
        if (operation === 'run' && result.code === 2 && ![...nodes.values()].some(node => {
            if (node['node-type'] === 'group') {return false;}
            const outcome = testResult(node)?.outcome;
            return outcome === 'failed' || outcome === 'errored';
        })) {throw new Error('MTP reported a failing run (exit 2), but did not provide a matching failed test result. The run cannot be reported as passing.');}
        if (operation === 'run') {assertComplete([...nodes.values()], options.expectedTests ?? tests ?? [], options.onNode);}
        options.signal?.throwIfAborted();
        return [...nodes.values()].filter(node => node['node-type'] !== 'group');
    } catch (error) {
        if (process?.interruption) {throw process.interruption;}
        throw error;
    } finally {
        clearTimeout(connectionTimer);
        clearTimeout(closeTimer);
        rpc?.dispose();
        socket?.destroy();
        server.close();
        process?.stop();
        await process?.done.catch(() => undefined);
    }
}

/** Deferred theories can report new row IDs; match those to their discovered method. */
export function assertComplete(nodes: readonly TestNode[], expected: readonly TestNode[], onIncomplete?: (node: TestNode) => void): void {
    const leaves = nodes.filter(node => node['node-type'] !== 'group');
    const expectedIds = new Set(expected.map(node => node.uid));
    const byId = new Map(leaves.map(node => [node.uid, node]));
    const method = (node: TestNode): string | undefined => typeof node['location.type'] === 'string' && typeof node['location.method'] === 'string'
        ? JSON.stringify([node['location.type'], String(node['location.method']).split('(')[0]]) : undefined;
    const expectedMethods = new Map<string | undefined, number>();
    for (const node of expected) {const key = method(node); expectedMethods.set(key, (expectedMethods.get(key) ?? 0) + 1);}
    const runtimeMethods = new Set(leaves.filter(node => !expectedIds.has(node.uid) && isTerminal(node)).map(method).filter(Boolean));
    const replaced = (node: TestNode): boolean => expectedIds.has(node.uid) && !!method(node)
        && expectedMethods.get(method(node)) === 1 && runtimeMethods.has(method(node));
    const unfinished = leaves.filter(node => !node['retry.is-superseded'] && !isTerminal(node) && !replaced(node));
    const missing = expected.filter(node => !isTerminal(byId.get(node.uid) ?? node) && !replaced(node));
    if (unfinished.length || missing.length) {
        const names = [...new Set([...unfinished, ...missing].map(node => String(node['display-name'] ?? node.uid)))];
        for (const node of new Map([...unfinished, ...missing].map(node => [node.uid, node])).values()) {
            onIncomplete?.({ ...node, 'execution-state': 'error', 'error.message': 'The test runner ended without a terminal outcome for this test.' });
        }
        throw new Error(`Incomplete test run: ${names.length} selected or started tests have no terminal outcome (${names.slice(0, 5).join(', ')}). Completed results are retained; no baseline or coverage was learned from this batch.`);
    }
}

function qualifiedName(node: TestNode): string {
    const type = typeof node['location.type'] === 'string' ? node['location.type'] : '';
    const method = typeof node['location.method'] === 'string' ? node['location.method'] : '';
    return [type, method].filter(Boolean).join('.');
}

export function isTerminal(node: TestNode): boolean {
    return !node['retry.is-superseded'] && node['execution-state'] !== undefined
        && node['execution-state'] !== 'discovered' && node['execution-state'] !== 'in-progress';
}

export function discoveredTest(node: TestNode): DiscoveredTest {
    return testMetadata(node, normalizePath);
}

export function testConverter(normalize = pathNormalizer()): (node: TestNode) => DiscoveredTest {
    return node => testMetadata(node, normalize);
}

function testMetadata(node: TestNode, normalize: (file: string) => string): DiscoveredTest {
    return {
        id: node.uid, name: String(node['display-name'] ?? node.uid),
        fullyQualifiedName: qualifiedName(node),
        file: typeof node['location.file'] === 'string' ? normalize(node['location.file']) : undefined,
        line: typeof node['location.line-start'] === 'number' ? Math.max(1, node['location.line-start']) : 1,
        node
    };
}

export function testResult(node: TestNode): TestResult | undefined {
    if (!isTerminal(node)) {return undefined;}
    const state = node['execution-state'];
    return {
        id: node.uid, name: String(node['display-name'] ?? node.uid), fullyQualifiedName: qualifiedName(node),
        outcome: state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : state === 'skipped' ? 'skipped' : 'errored',
        duration: Number(node['time.duration-ms'] ?? 0),
        message: typeof node['error.message'] === 'string' ? node['error.message'] : undefined,
        stack: typeof node['error.stacktrace'] === 'string' ? node['error.stacktrace'] : undefined,
        output: [node.standardOutput, node.standardError].filter(value => typeof value === 'string' && value.length).join('\n'), node
    };
}
