import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConnectionError, ConnectionErrors, createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { DiscoveredTest, TestResult } from '../core/model';
import { normalizePath, pathNormalizer } from '../core/paths';
import { nodeTraits } from '../core/traits';
import { EnvironmentError } from '../core/errors';
import { mergeTestUpdate, nodeName, nodeText, testName, TestNode } from '../core/testUpdates';
import { OwnedProcess, ProcessOptions, ProcessResult, startProcess } from './process';
import { resolveOwnedCommand } from './executable';
import { extensionVersion } from './assets';

export type { TestNode } from '../core/testUpdates';
// Protocol messages from the test host; optional parts may be absent.
interface TestUpdates { readonly runId: string; readonly changes?: readonly { readonly node: TestNode }[] | null; }
interface AttachmentUpdates { readonly runId: string; readonly attachments?: readonly { readonly uri?: string; readonly 'display-name'?: string; readonly description?: string; readonly producer?: string }[] | null; }
interface InitializeResult { readonly capabilities?: { readonly testing?: { readonly supportsDiscovery?: boolean } }; }

export interface MtpOptions extends ProcessOptions {
    readonly dotnet: string;
    readonly assembly: string;
    readonly args?: readonly string[];
    /** A coverage collector can wrap the same owned MTP process. */
    readonly wrapper?: { readonly command: string; readonly args: readonly string[] } | undefined;
    readonly onNode?: (node: TestNode) => void;
    readonly expectedTests?: readonly TestNode[];
    /** Run under a debugger: the host waits until this attaches to the reported process. */
    readonly debug?: ((processId: number) => Promise<void>) | undefined;
}

/** After a complete result stream, how long the host may take to exit. A coverage
 * collector writes its report after the host exits, so it receives longer. */
export const mtpTiming = { exitGraceMs: 10_000, wrappedExitGraceMs: 120_000,
    /** How long the host may take to connect; a collector's cold start is slower. Never beyond the process timeout. */
    connectMs: 30_000, wrappedConnectMs: 120_000,
    /** How long a host waiting for a debugger may take to report its process ID. */
    attachMs: 60_000,
    /** After the connection closes, how long to wait for the host's exit before failing pending requests. */
    closeGraceMs: 5_000 };

/** MTP's exit code when no test matched the request, e.g. because the selected IDs no longer exist. */
const zeroTestsRan = 8;

/** The exit result, or undefined after stopping a process that did not exit in time. */
async function exitWithin(owned: OwnedProcess, graceMs: number): Promise<ProcessResult | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<undefined>(resolve => {timer = setTimeout(() => resolve(undefined), graceMs);});
    try {
        const result = await Promise.race([owned.done, expired]);
        if (result) {return result;}
    } finally {clearTimeout(timer);}
    owned.stop();
    await owned.done.catch(() => undefined);
    return undefined;
}

/** MTP prints the waiting process's ID when TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1.
 * The spawned process may be an owner or wrapper, so its own PID is not the host's.
 * Never resolves: a failed attach rejects, and a successful one lets the host connect. */
function attachWhenWaiting(owned: OwnedProcess, attach: (processId: number) => Promise<void>): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
        let text = '';
        // Only the wait for the ID is bounded; once a debugger attaches, the user sets the pace.
        const timer = setTimeout(() => {
            owned.child.stdout?.off('data', listener);
            reject(new Error(`The test application did not report a process ID for the debugger within ${Math.round(mtpTiming.attachMs / 1000)} seconds.`));
        }, mtpTiming.attachMs);
        const stop = (): void => clearTimeout(timer);
        function listener(chunk: Buffer | string): void {
            text = (text + chunk.toString()).slice(-4096);
            const match = /Process\s*Id\s*[:=]\s*(\d+)/i.exec(text);
            if (!match) {return;}
            stop();
            owned.child.stdout?.off('data', listener);
            attach(Number(match[1])).catch(reject);
        }
        owned.child.stdout?.on('data', listener);
        owned.done.then(stop, stop);
    });
}

/** The host may close the socket after its final update, before Testy says goodbye. */
export function connectionClosed(error: unknown): boolean {
    if (error instanceof ConnectionError) {return error.code === ConnectionErrors.Closed || error.code === ConnectionErrors.Disposed;}
    return ['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
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
    let lingering = false;
    try {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
        });
        const port = (server.address() as net.AddressInfo).port;
        // MTP's protocol has no handshake secret: the client port is the only
        // rendezvous, so a local process could connect first and impersonate the
        // test host. The real host always connects exactly once, so any second
        // connection means one of them was not ours and the results are discarded.
        const debugging = operation === 'run' ? options.debug : undefined;
        let rejectIntrusion: (error: Error) => void = () => undefined;
        const intrusion = new Promise<never>((_resolve, reject) => {rejectIntrusion = reject;});
        void intrusion.catch(() => undefined);
        let rejectConnection: (error: Error) => void = () => undefined;
        const connected = new Promise<net.Socket>((resolve, reject) => {
            rejectConnection = reject;
            server.on('connection', candidate => {
                if (socket) {
                    candidate.destroy();
                    rejectIntrusion(new Error('Another local process connected to the test port; the results of this test run were discarded.'));
                    return;
                }
                socket = candidate;
                clearTimeout(connectionTimer);
                resolve(candidate);
            });
            server.once('error', reject);
        });
        const args = [options.assembly, '--server', '--client-port', String(port), ...options.args ?? []];
        const ownedOptions = { ...options, cleanupDescendants: true, env: debugging ? { ...options.env, TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER: '1' } : options.env };
        // The Windows owner must not search the workspace for a bare command name.
        // The CLI and the host are usually the same command: resolve each distinct one once, in parallel.
        const commands = [...new Set([options.dotnet, options.dotnetHost ?? 'dotnet', ...options.wrapper ? [options.wrapper.command] : []])];
        const resolved = new Map(await Promise.all(commands.map(async command => [command, await resolveOwnedCommand(command, ownedOptions.env, options.cwd)] as const)));
        const dotnet = resolved.get(options.dotnet)!;
        const wrapper = options.wrapper && resolved.get(options.wrapper.command)!;
        const hostOptions = { ...ownedOptions, dotnetHost: resolved.get(options.dotnetHost ?? 'dotnet')! };
        // A debugged host connects only after the debugger attaches. A coverage
        // collector's cold start is slower, but nothing outlives the process timeout.
        if (!debugging) {
            const limit = Math.min(options.wrapper ? mtpTiming.wrappedConnectMs : mtpTiming.connectMs, options.timeoutMs ?? 600_000);
            connectionTimer = setTimeout(() => rejectConnection(new EnvironmentError('not-mtp', 'The test application did not connect to Testy. Use a .NET 10+ Microsoft.Testing.Platform project.')), limit);
        }
        process = wrapper
            ? startProcess(wrapper, [...options.wrapper.args, dotnet, ...args], hostOptions)
            : startProcess(dotnet, args, hostOptions);
        const attached = debugging ? attachWhenWaiting(process, debugging) : new Promise<never>(() => undefined);
        void attached.catch(() => undefined);
        const peer = await Promise.race([
            connected, intrusion, attached,
            process.done.then(result => { throw new Error(`The test application exited before connecting (exit ${result.code}).\n${result.stderr || result.stdout}`); })
        ]);
        // Some MTP server versions count incoming JSON characters as bytes.
        // JSON escapes preserve Unicode names and paths while making framing
        // unambiguous for both those peers and conforming UTF-8 readers.
        const writer = new StreamMessageWriter(peer, { contentTypeEncoder: {
            name: 'application/json',
            encode: message => Promise.resolve(Buffer.from(JSON.stringify(message).replace(/[\u007f-\uffff]/g,
                character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`), 'utf8'))
        } });
        rpc = createMessageConnection(new StreamMessageReader(peer), writer);
        // Closing a transport does not itself reject vscode-jsonrpc's pending
        // requests. Disposal is essential when a cancelled/crashed runner exits.
        // Give process exit/timeout its diagnostic before RPC disposal rejects
        // outstanding requests with an otherwise unhelpful transport error: wait
        // until the exit is observed (it can lag the socket under load), bounded
        // for a host that closes the connection but keeps running.
        const host = process;
        rpc.onClose(() => {
            const dispose = (delay: number): void => {clearTimeout(closeTimer); closeTimer = setTimeout(() => rpc?.dispose(), delay);};
            dispose(mtpTiming.closeGraceMs);
            void host.done.then(() => dispose(0), () => dispose(0));
        });
        const exited = process.done.then(result => {
            throw new Error(`The test application exited during ${operation} (exit ${result.code}).\n${result.stderr || result.stdout}`);
        });
        void exited.catch(() => undefined);
        const request = <T>(method: string, parameters: object): Promise<T> => Promise.race([rpc!.sendRequest<T>(method, parameters), exited, intrusion]);
        const nodes = new Map<string, TestNode>();
        const pendingOutput = new Map<string, { stdout: string[]; stderr: string[] }>();
        const runId = randomUUID();
        // Set by the update notification; `as boolean` keeps the read after the requests from narrowing to false.
        let completed = false as boolean;
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
        rpc.onNotification('testing/testUpdates/attachments', (update: AttachmentUpdates) => {
            if (update.runId !== runId) {return;}
            for (const line of attachmentLines(update.attachments)) {options.output?.(`${line}\n`);}
        });
        rpc.listen();
        const initialized = await request<InitializeResult>('initialize', {
            processId: global.process.pid,
            clientInfo: { name: 'Testy', version: extensionVersion() },
            capabilities: { testing: { debuggerProvider: false, isStateful: true } }
        });
        if (!initialized.capabilities?.testing?.supportsDiscovery && operation === 'discover') {throw new Error('This MTP test framework does not support discovery.');}
        await request(operation === 'discover' ? 'testing/discoverTests' : 'testing/runTests', { runId, ...(tests ? { tests } : {}) });
        if (!completed) {throw new Error('The test runner ended without a complete test update stream.');}
        // A host that already closed the connection after its final update still produced a complete run.
        try {await rpc.sendNotification('exit', {});}
        catch (error) {if (!connectionClosed(error)) {throw error;}}
        // Every result has arrived. A host kept alive by a lingering foreground
        // thread must not hold the batch until the run timeout and lose them.
        const result = await Promise.race([exitWithin(process, options.wrapper ? mtpTiming.wrappedExitGraceMs : mtpTiming.exitGraceMs), intrusion]);
        if (!result) {
            lingering = true;
            options.output?.(`The test application did not exit after completing ${operation}; it was stopped and its results were kept.\n`);
        } else if (result.code !== 0 && (operation === 'discover' || (result.code !== 2 && result.code !== zeroTestsRan))) {throw new Error(`The test application failed during ${operation} (exit ${result.code}).\n${result.stderr || result.stdout}`);}
        if (operation === 'discover') {
            const failure = [...nodes.values()].find(node => ['failed', 'errored'].includes(testResult(node)?.outcome ?? ''));
            if (failure) {throw new Error(`Test discovery failed: ${nodeName(failure)}. ${nodeText(failure, 'error.message')}`);}
        }
        const failedGroup = [...nodes.values()].find(node => node['node-type'] === 'group' && ['failed', 'errored'].includes(testResult(node)?.outcome ?? ''));
        if (operation === 'run' && failedGroup) {throw new Error(`The test group failed: ${nodeName(failedGroup)}. ${nodeText(failedGroup, 'error.message')}`);}
        if (operation === 'run' && result?.code === 2 && ![...nodes.values()].some(node => {
            if (node['node-type'] === 'group') {return false;}
            const outcome = testResult(node)?.outcome;
            return outcome === 'failed' || outcome === 'errored';
        })) {throw new Error('MTP reported a failing run (exit 2), but did not provide a matching failed test result. The run cannot be reported as passing.');}
        // Nothing ran: the caller's handling of missing results applies, and an
        // incomplete-stream error would only hide the reason.
        if (operation === 'run' && result?.code === zeroTestsRan && ![...nodes.values()].some(node => node['node-type'] !== 'group')) {return [];}
        if (operation === 'run') {assertComplete([...nodes.values()], options.expectedTests ?? tests ?? [], options.onNode);}
        options.signal?.throwIfAborted();
        return [...nodes.values()].filter(node => node['node-type'] !== 'group');
    } catch (error) {
        if (process?.interruption && !lingering) {throw process.interruption;}
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

/** One output line per attachment: its name, the local path (file URIs are converted), and any description. */
export function attachmentLines(attachments: AttachmentUpdates['attachments']): string[] {
    return (attachments ?? []).flatMap(attachment => {
        if (typeof attachment.uri !== 'string' || !attachment.uri) {return [];}
        let location = attachment.uri;
        try {if (location.startsWith('file:')) {location = fileURLToPath(location);}} catch { /* Keep the URI. */ }
        const name = attachment['display-name'], extra = [attachment.producer, attachment.description].filter(Boolean).join(': ');
        return [`Attachment${name ? ` ${name}` : ''}: ${location}${extra ? ` (${extra})` : ''}`];
    });
}

/** Deferred theories can report new row IDs; match those to their discovered method. */
export function assertComplete(nodes: readonly TestNode[], expected: readonly TestNode[], onIncomplete?: (node: TestNode) => void): void {
    const leaves = nodes.filter(node => node['node-type'] !== 'group');
    const expectedIds = new Set(expected.map(node => node.uid));
    const byId = new Map(leaves.map(node => [node.uid, node]));
    const method = (node: TestNode): string | undefined => typeof node['location.type'] === 'string' && typeof node['location.method'] === 'string'
        ? JSON.stringify([node['location.type'], node['location.method'].split('(')[0]]) : undefined;
    const expectedMethods = new Map<string | undefined, number>();
    for (const node of expected) {const key = method(node); expectedMethods.set(key, (expectedMethods.get(key) ?? 0) + 1);}
    const runtimeMethods = new Set(leaves.filter(node => !expectedIds.has(node.uid) && isTerminal(node)).map(method).filter(Boolean));
    const replaced = (node: TestNode): boolean => expectedIds.has(node.uid) && !!method(node)
        && expectedMethods.get(method(node)) === 1 && runtimeMethods.has(method(node));
    const unfinished = leaves.filter(node => !node['retry.is-superseded'] && !isTerminal(node) && !replaced(node));
    const missing = expected.filter(node => !isTerminal(byId.get(node.uid) ?? node) && !replaced(node));
    if (unfinished.length || missing.length) {
        const names = [...new Set([...unfinished, ...missing].map(node => nodeName(node)))];
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
    const traits = nodeTraits(node);
    return {
        id: node.uid, name: testName(node),
        fullyQualifiedName: qualifiedName(node),
        file: typeof node['location.file'] === 'string' ? normalize(node['location.file']) : undefined,
        line: typeof node['location.line-start'] === 'number' ? Math.max(1, node['location.line-start']) : 1,
        ...(typeof node['location.line-end'] === 'number' && typeof node['location.line-start'] === 'number' && node['location.line-end'] >= node['location.line-start']
            ? { endLine: node['location.line-end'] } : {}),
        ...traits ? { traits } : {},
        node
    };
}

export function testResult(node: TestNode): TestResult | undefined {
    if (!isTerminal(node)) {return undefined;}
    const state = node['execution-state'];
    return {
        id: node.uid, name: testName(node), fullyQualifiedName: qualifiedName(node),
        outcome: state === 'passed' ? 'passed' : state === 'failed' ? 'failed' : state === 'skipped' ? 'skipped' : 'errored',
        duration: Number(node['time.duration-ms'] ?? 0),
        message: typeof node['error.message'] === 'string' ? node['error.message'] : undefined,
        stack: typeof node['error.stacktrace'] === 'string' ? node['error.stacktrace'] : undefined,
        // Some frameworks (MSTest) send both values empty and describe them in the message instead.
        ...(typeof node['assert.expected'] === 'string' && typeof node['assert.actual'] === 'string' && (node['assert.expected'] || node['assert.actual'])
            ? { expected: node['assert.expected'], actual: node['assert.actual'] } : {}),
        output: [node.standardOutput, node.standardError].filter(value => typeof value === 'string' && value.length).join('\n'), node
    };
}
