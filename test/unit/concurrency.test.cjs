const test = require('node:test');
const assert = require('node:assert/strict');
const { mapConcurrent, resolveConcurrency, SerialQueue, Semaphore } = require('../../out/core/concurrency');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('automatic process budgets reserve a CPU and explicit limits remain configurable', () => {
    assert.equal(resolveConcurrency(0, 1), 1);
    assert.equal(resolveConcurrency(0, 4), 3);
    assert.equal(resolveConcurrency(0, 16), 4);
    assert.equal(resolveConcurrency(12, 4), 12);
    for (const value of [-1, 1.5, NaN, Infinity]) { assert.throws(() => resolveConcurrency(value)); }
});

test('bounded workers overlap, retain input order and reuse stable worker numbers', async () => {
    const gates = Array.from({ length: 5 }, deferred), started = [], workers = [];
    let active = 0, peak = 0;
    const pending = mapConcurrent(gates, 2, undefined, async (gate, index, signal, worker) => {
        started.push(index); workers.push(worker); peak = Math.max(peak, ++active);
        await gate.promise; active--; signal.throwIfAborted(); return index;
    });
    assert.deepEqual(started, [0, 1]);
    gates[1].resolve(); await turn(); assert.deepEqual(started, [0, 1, 2]);
    gates[2].resolve(); await turn(); gates[3].resolve(); await turn();
    gates[4].resolve(); gates[0].resolve();
    assert.deepEqual(await pending, [0, 1, 2, 3, 4]);
    assert.equal(peak, 2); assert.deepEqual(workers, [0, 1, 1, 1, 1]);
});

test('a failing worker cancels siblings and drains them before rejecting', async () => {
    const gate = deferred(), release = deferred(), error = new Error('failed');
    let started = 0, stopped = false, settled = false, failureCalls = 0;
    const pending = mapConcurrent([0, 1, 2], 2, undefined, async (value, _index, signal) => {
        started++;
        if (value === 0) { await gate.promise; throw error; }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        stopped = true; await release.promise;
    }, failure => { assert.equal(failure, error); failureCalls++; });
    pending.catch(() => { settled = true; });
    gate.resolve(); await turn();
    assert.equal(started, 2); assert.equal(stopped, true); assert.equal(settled, false);
    release.resolve(); await assert.rejects(pending, failure => failure === error);
    assert.equal(failureCalls, 1);
});

test('sequential mode and parent cancellation never launch queued jobs', async () => {
    const abort = new AbortController(), gate = deferred(); let started = 0;
    const pending = mapConcurrent([1, 2, 3], 1, abort.signal, async (_value, _index, signal) => {
        started++; await gate.promise; signal.throwIfAborted();
    });
    abort.abort(); gate.resolve(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(started, 1);
    await assert.rejects(mapConcurrent([], 1, abort.signal, async () => {}), { name: 'AbortError' });
});

test('commits stay serialized even when one commit fails', async () => {
    const queue = new SerialQueue(), gate = deferred(), seen = [];
    const first = queue.run(async () => { seen.push(1); await gate.promise; throw new Error('commit'); });
    const second = queue.run(async () => { seen.push(2); return 2; });
    await turn(); assert.deepEqual(seen, [1]); gate.resolve();
    await assert.rejects(first, /commit/); assert.equal(await second, 2); assert.deepEqual(seen, [1, 2]);
});

test('separate producers share one I/O budget and aborted queued work releases its slot', async () => {
    const pool = new Semaphore(2), gate = deferred(), abort = new AbortController();
    let active = 0, peak = 0, queuedStarted = false;
    const work = () => pool.run(undefined, async () => { peak = Math.max(peak, ++active); await gate.promise; active--; });
    const first = work(), second = work();
    const queued = pool.run(abort.signal, async () => { queuedStarted = true; });
    abort.abort(); gate.resolve(); await Promise.all([first, second]);
    await assert.rejects(queued, { name: 'AbortError' });
    await pool.run(undefined, async () => {});
    assert.equal(peak, 2); assert.equal(queuedStarted, false);
});
