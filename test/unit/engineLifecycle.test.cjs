const test = require('node:test');
const assert = require('node:assert/strict');
const {TestEngine} = require('../../out/services/engine');

/** @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void}} */
function deferred() {
 /** @type {any} */ let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve};
}

/** Partial engine options: only output() and an empty configuration are exercised.
 * @param {Record<string, unknown>} services partial services (any) @param {string[]} [outputs] */
function engineWith(services, outputs = []) {
 return /** @type {any} */ (new TestEngine(/** @type {any} */ ({roots:[],storage:'/unused/testy-state',events:{output:(/** @type {string} */ text)=>outputs.push(text)},configuration:()=>({})}), /** @type {any} */ (services)));
}

test('engine disposal cancels and drains active runs before disposing prepared artifacts', async () => {
 let cacheDisposed = false;
 // runBatch is replaced to hold a run open until the test releases it.
 const engine = engineWith({preparedOutputs:{async dispose() { cacheDisposed = true; }}});
 const entered = deferred(), drained = deferred(); /** @type {AbortSignal | undefined} */ let activeSignal;
 engine.runBatch = async (/** @type {unknown} */ _batch, /** @type {AbortController} */ controller) => {
  activeSignal = controller.signal; entered.resolve();
  await drained.promise; controller.signal.throwIfAborted();
 };
 const running = engine.run({files:[],full:true}, new AbortController().signal);
 const rejected = assert.rejects(running, {name:'AbortError'});
 await entered.promise;
 const disposing = engine.dispose();
 assert.equal(/** @type {AbortSignal} */ (/** @type {unknown} */ (activeSignal)).aborted, true);
 assert.equal(cacheDisposed, false, 'active collectors still own their prepared output');
 assert.equal(engine.dispose(), disposing, 'concurrent disposal waits for the same cleanup');
 await assert.rejects(engine.run({files:[],full:true}, new AbortController().signal), /disposed/);
 drained.resolve(); await rejected; await disposing;
 assert.equal(cacheDisposed, true);
 assert.equal(engine.operations.size, 0);
});

test('every disposal step runs when earlier ones fail, and the failures are reported', async () => {
 /** @type {string[]} */ const steps = [];
 /** @type {string[]} */ const outputs = [];
 const engine = engineWith({
  analyzerServers:{async dispose() { steps.push('analyzers'); throw new Error('analyzers failed'); }},
  projectEvaluations:{async dispose() { steps.push('evaluations'); throw new Error('snapshot failed'); }},
  preparedOutputs:{async dispose() { steps.push('prepared'); }}
 }, outputs);
 const error = await engine.dispose().then(() => undefined, (/** @type {unknown} */ reason) => reason);
 assert.deepEqual(steps, ['analyzers', 'evaluations', 'prepared'], 'the evaluation snapshot and prepared containers are still handled');
 assert.ok(error instanceof AggregateError);
 assert.deepEqual(error.errors.map((/** @type {Error} */ failure) => failure.message), ['analyzers failed', 'snapshot failed']);
 assert.equal(outputs.filter(text => text.includes('cleanup failed')).length, 2);
});

test('each engine owns its analyzer servers: disposing one leaves another running', async () => {
 /** @type {string[]} */ const disposed = [];
 const servers = (/** @type {string} */ name) => ({async dispose() { disposed.push(name); }});
 const first = engineWith({analyzerServers:servers('first'), preparedOutputs:{async dispose() {}}});
 const second = engineWith({analyzerServers:servers('second'), preparedOutputs:{async dispose() {}}});
 await first.dispose();
 assert.deepEqual(disposed, ['first']);
 await second.dispose();
 assert.deepEqual(disposed, ['first', 'second']);
 const defaults = [engineWith({}), engineWith({})];
 assert.notEqual(defaults[0].analyzerServers, defaults[1].analyzerServers, 'default engines do not share a pool');
});
