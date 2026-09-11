const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createRequire } = require('node:module'), { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Semaphore } = require('../../out/core/concurrency');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (predicate()) { return; } await delay(1); }
    assert.fail('controlled work did not reach its expected state');
}
async function fixture(t, config = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'testy-instruments-')));
    const source = path.join(root, 'build'), workspace = path.join(root, 'workspace');
    await fs.mkdir(source); await fs.mkdir(workspace);
    const names = ['App', 'Core', 'Infra', 'Tests', 'Web'];
    for (const name of [...names, 'External']) { await fs.writeFile(path.join(source, `${name}.dll`), `pristine-${name}`); }
    const project = { file: path.join(workspace, 'Tests.csproj'), framework: 'net10.0', assembly: path.join(source, 'Tests.dll'),
        sourceFiles: ['A.cs', 'B.cs'].map(name => path.join(workspace, name)) };
    const control = new AbortController(), budget = new Semaphore(config.limit ?? 4);
    const state = { calls: [], active: new Set(), peak: 0, removals: [], discoveries: [], runs: [], messages: [], borrows: 0 };
    const file = path.resolve('out/services/runner.js'), realRequire = createRequire(file), exports = {};
    const output = realRequire('./output'), processTools = realRequire('./process'), mtp = realRequire('./mtp'), cacheTools = realRequire('./preparedOutputCache');
    const nodes = project.sourceFiles.map((file, i) => ({ uid: `native-${i}`, 'display-name': `Test${i}`,
        'location.file': file, 'location.type': `Suite${i}`, 'location.method': 'Run' }));
    const modules = {
        './process': { ...processTools, runProcess: async (_command, args, options) => {
            assert.equal(args[0], 'instrument'); options.signal?.throwIfAborted();
            const call = { name: path.basename(args[1], '.dll'), assembly: args[1], session: args[3], signal: options.signal };
            state.calls.push(call); state.active.add(call); state.peak = Math.max(state.peak, state.active.size);
            try {
                const result = await config.instrument?.(call, state);
                if (!config.unchanged?.includes(call.name)) { await fs.appendFile(call.assembly, ':instrumented'); }
                return { code: result?.code ?? 0, stdout: '', stderr: '' };
            } finally { state.active.delete(call); }
        } },
        './output': { ...output, removeOutput: async directory => {
            for (const call of state.active) { assert.equal(call.assembly.startsWith(directory + path.sep), false, 'processes drain before output removal'); }
            state.removals.push(directory); return output.removeOutput(directory);
        } },
        './mtp': { ...mtp, requestTests: async (options, operation, selected) => {
            const artifactRoot = path.dirname(path.dirname(options.assembly));
            for (const call of state.active) { assert.equal(call.assembly.startsWith(artifactRoot + path.sep), false, 'discovery/execution waits for its template instrumentation'); }
            if (operation === 'discover') { state.discoveries.push(options.assembly); return nodes; }
            state.runs.push(options);
            await config.run?.(options, state);
            return (selected ?? options.expectedTests).map(node => ({ ...node, 'execution-state': 'passed' }));
        } },
        './preparedOutputCache': { ...cacheTools, preparationToolIdentity: async command => command ?? '' },
        './preparationIdentity': { windowsPreparationTools: async options => ({ dotnet: options.dotnet, collector: options.coverageTool, analyzer: options.analyzer, instrumentationLaunch: 'node' }) },
        './coverageReader': { CoverageReader: class { async read() { return []; } async dispose() {} } },
        './runtimeObservation': { RuntimeObservation: class { static async start(_directory, _assembly, _modules, _instrumented, env) {
            return { env, dependencies: async () => ({ files: [], projects: [] }) };
        } } }
    };
    vm.runInNewContext(await fs.readFile(file, 'utf8'), { exports, process, AbortController, require: name => modules[name] ?? realRequire(name) });
    const cache = config.cache ? new cacheTools.PreparedOutputCache(path.join(root, 'cache'), randomUUID()) : undefined;
    const sessions = [];
    let enabled = true;
    const borrow = (signal, work) => { state.borrows++; return enabled ? budget.tryRun(signal, work) : undefined; };
    const createSession = (overrides = {}) => {
        const session = new exports.RunnerSession({ dotnet: 'dotnet', storage: path.join(root, 'runs'), testArguments: [], signal: control.signal, cleanupDescendants: false,
            coverageTool: 'collector', managedCoverageTool: config.managed ?? true, assemblies: names.map(name => path.join(source, `${name}.dll`)),
            preparedOutputCache: cache, tryInstrumentation: borrow, output: message => state.messages.push(message), ...overrides });
        sessions.push(session); return session;
    };
    const session = createSession();
    t.after(async () => {
        control.abort(); config.release?.();
        await Promise.allSettled(sessions.map(session => session.dispose())); await cache?.dispose();
        assert.equal(state.active.size, 0); await fs.rm(root, { recursive: true, force: true });
    });
    const start = (runner = session, target = project) => budget.run(control.signal, () => runner.discover(target));
    const pristine = async directory => {
        for (const name of [...names, 'External']) { assert.equal(await fs.readFile(path.join(directory, `${name}.dll`), 'utf8'), `pristine-${name}`); }
    };
    return { root, source, project, names, state, session, createSession, control, budget, start, pristine,
        disableBorrowing: () => { enabled = false; }, hashes: new Map(project.sourceFiles.map(file => [file, 'hash'])) };
}

test('DLLs share one session, borrow only spare capacity, and retain original result order', { timeout: 10000 }, async t => {
    const gates = new Map(['App', 'Core', 'Infra', 'Tests', 'Web'].map(name => [name, deferred()]));
    const f = await fixture(t, { instrument: call => gates.get(call.name).promise, release: () => { for (const gate of gates.values()) { gate.resolve(); } } });
    const pending = f.start();
    await eventually(() => f.state.calls.length === 4);
    assert.equal(f.state.peak, 4); assert.equal(f.budget.active, 4); assert.equal(f.budget.waiting.length, 0);
    gates.get('Core').resolve(); await eventually(() => f.state.calls.length === 5);
    for (const name of ['Web', 'Tests', 'Infra', 'App']) { gates.get(name).resolve(); }
    await pending;
    const preparation = [...f.session.prepared.values()][0];
    assert.deepEqual(Array.from(preparation.instrumented, file => path.basename(file, '.dll')), f.names);
    assert.equal(new Set(f.state.calls.map(call => call.session)).size, 1);
    assert.equal(preparation.coverage, true); assert.equal(f.budget.active, 0);
    assert.equal(await fs.readFile(path.join(preparation.output.directory, 'External.dll'), 'utf8'), 'pristine-External');
    await f.pristine(f.source);
});

test('one inherited permit progresses when no extra permit can be borrowed', { timeout: 10000 }, async t => {
    const f = await fixture(t, { limit: 1 }); await f.start();
    assert.equal(f.state.calls.length, 5); assert.equal(f.state.peak, 1); assert.equal(f.budget.active, 0); assert.equal(f.budget.waiting.length, 0);
});

test('four targets keep their inherited slots without nested waits or oversubscription', { timeout: 10000 }, async t => {
    const gate = deferred();
    const f = await fixture(t, { instrument: () => gate.promise, release: () => gate.resolve() });
    const targets = Array.from({ length: 4 }, (_, i) => ({ ...f.project, file: path.join(path.dirname(f.project.file), `Tests${i}.csproj`) }));
    const pending = Promise.all(targets.map(target => f.start(f.session, target)));
    await eventually(() => f.state.calls.length === 4);
    assert.equal(f.budget.active, 4); assert.equal(f.budget.waiting.length, 0); gate.resolve(); await pending;
    assert.equal(f.state.calls.length, 20); assert.equal(f.state.peak, 4); assert.equal(f.budget.active, 0);
    assert.equal(f.state.discoveries.length, 4);
});

test('instrumentation retries borrowing when analysis releases occupied capacity', { timeout: 10000 }, async t => {
    const holdAnalysis = deferred(), first = deferred(), others = deferred();
    const f = await fixture(t, { instrument: call => (call.name === 'App' ? first : others).promise,
        release: () => { holdAnalysis.resolve(); first.resolve(); others.resolve(); } });
    const analysis = Array.from({ length: 3 }, () => f.budget.run(f.control.signal, () => holdAnalysis.promise));
    const pending = f.start(); await eventually(() => f.state.calls.length === 1);
    assert.equal(f.state.peak, 1); holdAnalysis.resolve(); await Promise.all(analysis); first.resolve();
    await eventually(() => f.state.calls.length === 5); assert.equal(f.state.peak, 4);
    others.resolve(); await pending; assert.equal(f.budget.active, 0);
});

test('custom collectors and sessions without the callback remain serial', { timeout: 10000 }, async t => {
    const f = await fixture(t, { managed: false }); await f.start();
    assert.equal(f.state.peak, 1); assert.equal(f.state.borrows, 0);
    const managed = f.createSession({ managedCoverageTool: true, tryInstrumentation: undefined }); await f.start(managed);
    assert.equal(f.state.calls.length, 10); assert.equal(f.state.peak, 1); assert.equal(f.state.borrows, 0);
});

test('unchanged DLLs retain whole-module fallback eligibility without failing coverage', { timeout: 10000 }, async t => {
    const f = await fixture(t, { unchanged: ['Core', 'Web'] }); await f.start();
    const preparation = [...f.session.prepared.values()][0];
    assert.equal(preparation.coverage, true);
    assert.deepEqual(Array.from(preparation.instrumented, file => path.basename(file, '.dll')), ['App', 'Infra', 'Tests']);
    assert.equal(f.state.messages.filter(message => message.includes('retaining module dependencies')).length, 2);
});

for (const scenario of ['inherited failure', 'borrowed failure', 'cancellation']) {
    test(`${scenario} cancels siblings and drains delayed cleanup before rollback or removal`, { timeout: 10000 }, async t => {
        const fail = deferred(), drain = deferred(); let aborted = 0;
        const f = await fixture(t, { instrument: async call => {
            await fs.appendFile(call.assembly, ':partial');
            if (scenario !== 'cancellation' && call.name === (scenario === 'inherited failure' ? 'App' : 'Core')) { await fail.promise; return { code: 17 }; }
            await new Promise(resolve => {
                if (call.signal.aborted) { aborted++; resolve(); }
                else { call.signal.addEventListener('abort', () => { aborted++; resolve(); }, { once: true }); }
            });
            await drain.promise; call.signal.throwIfAborted();
        }, release: () => { fail.resolve(); drain.resolve(); } });
        const pending = f.start();
        const observed = scenario === 'cancellation' ? assert.rejects(pending, error => error.name === 'AbortError') : pending;
        await eventually(() => f.state.calls.length === 4);
        if (scenario !== 'cancellation') { fail.resolve(); } else { f.control.abort(); }
        await eventually(() => aborted === (scenario !== 'cancellation' ? 3 : 4));
        assert.equal(f.state.calls.length, 4, 'fifth DLL is not admitted after interruption');
        assert.equal(f.state.removals.length, 0, 'rollback waits for asynchronous sibling cleanup');
        assert.ok(f.budget.active > 0, 'borrowed permits remain held until process cleanup settles');
        drain.resolve(); await observed;
        assert.equal(f.state.active.size, 0); assert.equal(f.budget.active, 0); await f.pristine(f.source);
        if (scenario !== 'cancellation') {
            const preparation = [...f.session.prepared.values()][0];
            assert.equal(preparation.coverage, false); await f.pristine(preparation.output.template); await f.pristine(preparation.output.directory);
            assert.equal(f.state.messages.filter(message => message.includes('Coverage preparation failed')).length, 1);
        } else { assert.equal(f.session.prepared.size, 0); assert.equal(f.state.discoveries.length, 0); }
    });
}

test('private file lanes omit the callback and a closed primary phase cannot borrow', { timeout: 10000 }, async t => {
    const hold = deferred(), entered = deferred();
    const f = await fixture(t, { run: async (_options, state) => { if (state.runs.length === 1) { entered.resolve(); await hold.promise; } }, release: () => hold.resolve() });
    const groups = await f.start(); const afterDiscovery = f.state.borrows;
    f.state.peak = 0;
    const first = f.session.run([groups[0]], f.hashes, 0); await entered.promise;
    const second = f.session.run([groups[1]], f.hashes, 1); await second; hold.resolve(); await first;
    assert.equal(f.state.borrows, afterDiscovery, 'private lane cannot borrow even if parent callback remains enabled');
    assert.equal(f.state.calls.filter(call => call.assembly.includes(`${path.sep}lanes${path.sep}`)).length, 5);
    assert.equal(f.state.peak, 1, 'private-lane instrumentation remains serial');
    f.disableBorrowing(); const deferredSession = f.createSession({ deferCoverage: () => true });
    const deferredGroups = await f.start(deferredSession); const before = f.state.calls.length;
    await deferredSession.run([deferredGroups[0]], f.hashes);
    assert.equal(f.state.calls.length, before + 5, 'newly selected deferred target still prepares coverage');
    assert.equal(f.state.peak, 1, 'disabled primary callback cannot parallelize deferred instrumentation');
    assert.equal(f.budget.active, 0, 'post-primary preparation has no borrowed project permits');
});

test('serial and parallel preparation share the same retained artifact contract', { timeout: 10000 }, async t => {
    const f = await fixture(t, { cache: true });
    const serial = f.createSession({ tryInstrumentation: undefined }); await f.start(serial); await serial.dispose();
    assert.equal(f.state.calls.length, 5);
    await f.start(); await f.session.dispose(); assert.equal(f.state.calls.length, 5, 'parallel acquisition reuses serial preparation');
    const again = f.createSession({ tryInstrumentation: undefined }); await f.start(again);
    assert.equal(f.state.calls.length, 5, 'serial acquisition reuses the same artifact afterward');
});
