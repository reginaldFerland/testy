const test = require('node:test');
const assert = require('node:assert/strict');
const {TestEngine} = require('../../out/services/engine');

/** @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void}} */
function deferred() {
 /** @type {any} */ let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve};
}

test('engine disposal cancels and drains active runs before disposing prepared artifacts', async () => {
 // Partial mock: only output() and an empty configuration are exercised; private members are overridden, so the engine is typed any.
 /** @type {any} */ const engine = new TestEngine(/** @type {any} */ ({roots:[],storage:'/unused/testy-state',events:{output(){}},configuration:()=>({})}));
 const entered = deferred(), drained = deferred(); /** @type {AbortSignal | undefined} */ let activeSignal; let cacheDisposed = false;
 engine.preparedOutputs = {async dispose() { cacheDisposed = true; }};
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
