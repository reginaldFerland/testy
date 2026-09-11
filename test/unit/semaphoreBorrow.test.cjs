const test = require('node:test');
const assert = require('node:assert/strict');
const { Semaphore } = require('../../out/core/concurrency');
const turn = () => new Promise(resolve => setImmediate(resolve));

function deferred(t) {
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    t.after(() => resolve());
    return { promise, resolve, reject };
}

function unavailable(pool, signal) {
    let called = false;
    const result = pool.tryRun(signal, async () => { called = true; });
    assert.equal(result, undefined, 'unavailable capacity returns synchronously without queuing');
    assert.equal(called, false, 'declined work never starts');
}

async function fullCapacity(pool, limit, t) {
    const gate = deferred(t);
    const admitted = Array.from({ length: limit }, (_, index) => pool.tryRun(undefined, async () => { await gate.promise; return index; }));
    assert.ok(admitted.every(pending => pending instanceof Promise), 'every released permit can be borrowed again');
    unavailable(pool);
    gate.resolve();
    assert.deepEqual(await Promise.all(admitted), Array.from({ length: limit }, (_, index) => index));
}

test('a one-slot parent continues serial work when borrowing is unavailable', async t => {
    const pool = new Semaphore(1), seen = [];
    let declinedCalls = 0;
    await pool.run(undefined, async () => {
        for (let index = 0; index < 3; index++) {
            assert.equal(pool.tryRun(undefined, async () => { declinedCalls++; }), undefined);
            seen.push(index);
            await turn();
        }
    });
    await turn();
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(declinedCalls, 0, 'declined work is not queued for the parent release');
    await fullCapacity(pool, 1, t);
});

test('mixed ordinary and borrowed workers share one strict capacity bound', async t => {
    const pool = new Semaphore(3), gates = Array.from({ length: 6 }, () => deferred(t)), started = [];
    let active = 0, peak = 0;
    const work = index => async () => {
        peak = Math.max(peak, ++active); started.push(index);
        try {await gates[index].promise; return index;} finally {active--;}
    };
    const pending = [pool.run(undefined, work(0)), pool.tryRun(undefined, work(1)), pool.run(undefined, work(2)),
        pool.run(undefined, work(3)), pool.run(undefined, work(4))];
    assert.deepEqual(started, [0, 1, 2]); unavailable(pool);
    gates[1].resolve(); await turn(); assert.deepEqual(started, [0, 1, 2, 3]); unavailable(pool);
    gates[0].resolve(); await turn(); assert.deepEqual(started, [0, 1, 2, 3, 4]); unavailable(pool);
    gates[2].resolve(); await turn(); pending.push(pool.tryRun(undefined, work(5)));
    assert.ok(pending[5] instanceof Promise); assert.deepEqual(started, [0, 1, 2, 3, 4, 5]); unavailable(pool);
    for (const gate of gates) {gate.resolve();}
    assert.deepEqual(await Promise.all(pending), [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 3); assert.equal(active, 0);
    await fullCapacity(pool, 3, t);
});

test('released borrowed permits transfer to ordinary waiters in FIFO order', async t => {
    const pool = new Semaphore(2), parent = deferred(t), extra = deferred(t), first = deferred(t), second = deferred(t), started = [];
    const parentWork = pool.run(undefined, () => parent.promise);
    const borrowed = pool.tryRun(undefined, () => extra.promise);
    const firstWaiter = pool.run(undefined, async () => { started.push('first'); await first.promise; });
    const secondWaiter = pool.run(undefined, async () => { started.push('second'); await second.promise; });
    unavailable(pool);
    extra.resolve(); await borrowed;
    unavailable(pool); await turn(); assert.deepEqual(started, ['first']);
    parent.resolve(); await parentWork;
    unavailable(pool); await turn(); assert.deepEqual(started, ['first', 'second']);
    first.resolve(); second.resolve(); await Promise.all([firstWaiter, secondWaiter]);
    await fullCapacity(pool, 2, t);
});

test('success, asynchronous rejection and synchronous throws release a borrowed permit exactly once', async t => {
    const pool = new Semaphore(2), error = new Error('controlled borrowed failure');
    const value = { completed: true };
    assert.equal(await pool.tryRun(undefined, async () => value), value);
    await fullCapacity(pool, 2, t);
    const gate = deferred(t), pending = pool.tryRun(undefined, () => gate.promise);
    const rejected = assert.rejects(pending, failure => failure === error);
    gate.reject(error); await rejected;
    await fullCapacity(pool, 2, t);
    let thrown;
    assert.doesNotThrow(() => { thrown = pool.tryRun(undefined, () => { throw error; }); });
    assert.ok(thrown instanceof Promise, 'callback throws become rejections of the owned operation');
    await assert.rejects(thrown, failure => failure === error);
    await fullCapacity(pool, 2, t);
});

test('an already-aborted signal throws before admission and consumes no permit', async t => {
    const pool = new Semaphore(1), abort = new AbortController(), reason = new Error('already cancelled'), gate = deferred(t);
    abort.abort(reason);
    let called = false;
    const attempt = () => pool.tryRun(abort.signal, async () => { called = true; });
    assert.throws(attempt, error => error === reason);
    const pending = pool.tryRun(undefined, () => gate.promise); assert.ok(pending instanceof Promise);
    assert.throws(attempt, error => error === reason, 'abort remains visible even when capacity is full');
    assert.equal(called, false); gate.resolve(); await pending;
    await fullCapacity(pool, 1, t);
});

test('cancellation retains the borrowed permit until owned work and cleanup drain', async t => {
    const pool = new Semaphore(2), parent = deferred(t), cleanup = deferred(t), next = deferred(t), abort = new AbortController();
    const reason = new Error('cancel active borrowed work');
    let stopped = false, settled = false, queuedStarted = false;
    const parentWork = pool.run(undefined, () => parent.promise);
    const borrowed = pool.tryRun(abort.signal, async () => {
        await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
        stopped = true; await cleanup.promise; abort.signal.throwIfAborted();
    });
    const rejected = assert.rejects(borrowed, error => error === reason);
    void borrowed.then(() => { settled = true; }, () => { settled = true; });
    const queued = pool.run(undefined, async () => { queuedStarted = true; await next.promise; });
    abort.abort(reason); await turn();
    assert.equal(stopped, true); assert.equal(settled, false); assert.equal(queuedStarted, false); unavailable(pool);
    cleanup.resolve(); await rejected; await turn();
    assert.equal(settled, true); assert.equal(queuedStarted, true); unavailable(pool);
    next.resolve(); parent.resolve(); await Promise.all([queued, parentWork]);
    await fullCapacity(pool, 2, t);
});

test('an aborted ordinary waiter passes the borrowed permit to the next live waiter', async t => {
    const pool = new Semaphore(1), owner = deferred(t), live = deferred(t), abort = new AbortController(), started = [];
    const borrowed = pool.tryRun(undefined, () => owner.promise);
    const cancelled = pool.run(abort.signal, async () => { started.push('cancelled'); });
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    const waiting = pool.run(undefined, async () => { started.push('live'); await live.promise; });
    abort.abort(); unavailable(pool); owner.resolve(); await borrowed;
    await rejected; await turn(); assert.deepEqual(started, ['live']); unavailable(pool);
    live.resolve(); await waiting;
    await fullCapacity(pool, 1, t);
});
