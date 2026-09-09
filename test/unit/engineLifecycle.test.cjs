const test = require('node:test');
const assert = require('node:assert/strict');
const {TestEngine} = require('../../out/services/engine');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

test('engine disposal cancels and drains active runs before disposing prepared artifacts', async () => {
 const engine = new TestEngine({roots:[],storage:'/unused/testy-state',events:{output(){}},configuration:()=>({})});
 const entered = deferred(), drained = deferred(); let activeSignal, cacheDisposed = false;
 engine.preparedOutputs = {async dispose() { cacheDisposed = true; }};
 engine.runBatch = async (_batch, controller) => {
  activeSignal = controller.signal; entered.resolve();
  await drained.promise; controller.signal.throwIfAborted();
 };
 const running = engine.run({files:[],full:true}, new AbortController().signal);
 const rejected = assert.rejects(running, {name:'AbortError'});
 await entered.promise;
 const disposing = engine.dispose();
 assert.equal(activeSignal.aborted, true);
 assert.equal(cacheDisposed, false, 'active collectors still own their prepared output');
 assert.equal(engine.dispose(), disposing, 'concurrent disposal waits for the same cleanup');
 await assert.rejects(engine.run({files:[],full:true}, new AbortController().signal), /disposed/);
 drained.resolve(); await rejected; await disposing;
 assert.equal(cacheDisposed, true);
 assert.equal(engine.operations.size, 0);
});
