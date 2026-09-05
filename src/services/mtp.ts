import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createMessageConnection, MessageConnection } from 'vscode-jsonrpc/node';
import { DiscoveredTest, TestResult } from '../core/model';
import { normalizePath } from '../core/paths';
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
}

/** MTP's IDE protocol, transported over a loopback socket using Content-Length framing. */
export async function requestTests(options: MtpOptions, operation: 'discover' | 'run', tests?: readonly TestNode[]): Promise<readonly TestNode[]> {
    options.signal?.throwIfAborted();
    const server = net.createServer();
    let socket: net.Socket | undefined;
    let rpc: MessageConnection | undefined;
    let process: OwnedProcess | undefined;
    let connectionTimer: NodeJS.Timeout | undefined;
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
        process = options.wrapper
            ? startProcess(options.wrapper.command, [...options.wrapper.args, options.dotnet, ...args], options)
            : startProcess(options.dotnet, args, options);
        const peer = await Promise.race([
            connected,
            process.done.then(result => { throw new Error(`The test application exited before connecting (exit ${result.code}).\n${result.stderr || result.stdout}`); })
        ]);
        rpc = createMessageConnection(peer, peer);
        // Closing a transport does not itself reject vscode-jsonrpc's pending
        // requests. Disposal is essential when a cancelled/crashed runner exits.
        rpc.onClose(() => rpc?.dispose());
        const nodes = new Map<string, TestNode>();
        const runId = randomUUID();
        let completed = false;
        rpc.onNotification('testing/testUpdates/tests', (update: TestUpdates) => {
            if (update.runId !== runId) {return;}
            if (update.changes === null) { completed = true; return; }
            for (const { node } of update.changes ?? []) {
                const merged = operation === 'run' ? mergeTestUpdate(nodes.get(node.uid), node) : { ...nodes.get(node.uid), ...node };
                nodes.set(node.uid, merged);
                options.onNode?.(merged);
            }
        });
        rpc.onNotification('client/log', (message: { level?: string | number; message?: string }) => {
            if (message.level === 'Error' || message.level === 'Warning' || (typeof message.level === 'number' && message.level >= 3)) {options.output?.(`${message.message ?? ''}\n`);}
        });
        rpc.onNotification('telemetry/update', () => undefined);
        rpc.onNotification('testing/testUpdates/attachments', () => undefined);
        rpc.listen();
        const initialized = await rpc.sendRequest<InitializeResult>('initialize', {
            processId: global.process.pid,
            clientInfo: { name: 'Testy', version: '1.0.0' },
            capabilities: { testing: { debuggerProvider: false, isStateful: true } }
        });
        if (!initialized.capabilities?.testing?.supportsDiscovery && operation === 'discover') {throw new Error('This MTP test framework does not support discovery.');}
        await rpc.sendRequest(operation === 'discover' ? 'testing/discoverTests' : 'testing/runTests', { runId, ...(tests ? { tests } : {}) });
        if (!completed) {throw new Error('The test runner ended without a complete test update stream.');}
        await rpc.sendNotification('exit', {});
        const result = await process.done;
        if (result.code !== 0 && result.code !== 2) {throw new Error(`The test application failed (exit ${result.code}).\n${result.stderr || result.stdout}`);}
        const failedGroup = [...nodes.values()].find(node => node['node-type'] === 'group' && ['failed', 'errored'].includes(testResult(node)?.outcome ?? ''));
        if (operation === 'run' && failedGroup) {throw new Error(`The test group failed: ${failedGroup['display-name'] ?? failedGroup.uid}. ${failedGroup['error.message'] ?? ''}`);}
        if (operation === 'run' && result.code === 2 && ![...nodes.values()].some(node => {
            if (node['node-type'] === 'group') {return false;}
            const outcome = testResult(node)?.outcome;
            return outcome === 'failed' || outcome === 'errored';
        })) {throw new Error('MTP reported a failing run (exit 2), but did not provide a matching failed test result. The run cannot be reported as passing.');}
        options.signal?.throwIfAborted();
        return [...nodes.values()].filter(node => node['node-type'] !== 'group');
    } finally {
        clearTimeout(connectionTimer);
        rpc?.dispose();
        socket?.destroy();
        server.close();
        process?.stop();
        await process?.done.catch(() => undefined);
    }
}

export function discoveredTest(node: TestNode): DiscoveredTest {
    const type = typeof node['location.type'] === 'string' ? node['location.type'] : '';
    const method = typeof node['location.method'] === 'string' ? node['location.method'] : '';
    return {
        id: node.uid, name: String(node['display-name'] ?? node.uid),
        fullyQualifiedName: [type, method].filter(Boolean).join('.'),
        file: typeof node['location.file'] === 'string' ? normalizePath(node['location.file']) : undefined,
        line: typeof node['location.line-start'] === 'number' ? Math.max(1, node['location.line-start']) : 1,
        node
    };
}

export function testResult(node: TestNode): TestResult | undefined {
    if (node['retry.is-superseded']) {return undefined;}
    const state = node['execution-state'];
    if (state === 'discovered' || state === 'in-progress' || state === undefined) {return undefined;}
    return {
        id: node.uid, name: String(node['display-name'] ?? node.uid), fullyQualifiedName: discoveredTest(node).fullyQualifiedName,
        outcome: state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : state === 'skipped' ? 'skipped' : 'errored',
        duration: Number(node['time.duration-ms'] ?? 0),
        message: typeof node['error.message'] === 'string' ? node['error.message'] : undefined,
        stack: typeof node['error.stacktrace'] === 'string' ? node['error.stacktrace'] : undefined,
        output: [node.standardOutput, node.standardError].filter(value => typeof value === 'string').join('\n'), node
    };
}
