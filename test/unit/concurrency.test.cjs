const test = require('node:test');
const assert = require('node:assert/strict');
const { mapConcurrent, mapConcurrentByKey, resolveConcurrency, resolveTestFileConcurrency, SerialQueue, Semaphore } = require('../../out/core/concurrency');
const turn = () => new Promise(resolve => setImmediate(resolve));
/** @returns {{ promise: Promise<void>, resolve: () => void }} */
function deferred() { let resolve = () => {}; const promise = /** @type {Promise<void>} */ (new Promise(done => { resolve = done; })); return { promise, resolve }; }

test('automatic project budgets reserve a CPU and explicit limits remain configurable', () => {
    assert.equal(resolveConcurrency(0, 1), 1);
    assert.equal(resolveConcurrency(0, 4), 3);
    assert.equal(resolveConcurrency(0, 16), 4);
    assert.equal(resolveConcurrency(12, 4), 12);
    for (const value of [-1, 1.5, NaN, Infinity]) { assert.throws(() => resolveConcurrency(value)); }
});

test('automatic test-file workers scale with available CPUs while project preparation stays bounded', () => {
    for (const [cpus, files, projects] of [[1, 1, 1], [2, 1, 1], [4, 3, 3], [10, 9, 4], [16, 15, 4], [64, 63, 4]]) {
        assert.equal(resolveTestFileConcurrency(0, cpus), files);
        assert.equal(resolveConcurrency(0, cpus), projects);
    }
    for (const resolve of [resolveConcurrency, resolveTestFileConcurrency]) {
        assert.equal(resolve(1, 64), 1);
        assert.equal(resolve(12, 4), 12);
        for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {assert.throws(() => resolve(value));}
    }
});

test('bounded workers overlap, retain input order and reuse stable worker numbers', async () => {
    const gates = Array.from({ length: 5 }, deferred), /** @type {number[]} */ started = [], /** @type {number[]} */ workers = [];
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

test('target scheduling admits idle targets first and retains FIFO and result order', async () => {
    const items = ['A1', 'A2', 'A3', 'B1', 'B2', 'C1'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    const pending = mapConcurrentByKey(items, 3, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    });
    assert.deepEqual(started, ['A1', 'B1', 'C1']);
    gates[3].resolve(); await turn(); assert.deepEqual(started, ['A1', 'B1', 'C1', 'B2']);
    gates[4].resolve(); await turn(); assert.equal(started.at(-1), 'A2');
    gates[1].resolve(); await turn(); assert.equal(started.at(-1), 'A3');
    for (const gate of gates) { gate.resolve(); }
    assert.deepEqual(await pending, items);
});

test('between equally busy targets the earliest queued item starts first', async () => {
    const items = ['A1', 'B1', 'A2', 'B2'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    const pending = mapConcurrentByKey(items, 1, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    });
    for (const gate of gates) { gate.resolve(); }
    assert.deepEqual(await pending, items);
    assert.deepEqual(started, items, 'one worker follows the queue across targets');
});

test('a fast lane takes from the end of the queue while the other workers take from the front', async () => {
    const items = ['A1', 'A2', 'A3', 'A4', 'A5'], gates = items.map(deferred), /** @type {[string, number][]} */ started = [];
    const pending = mapConcurrentByKey(items, 2, undefined, value => value[0], async (value, index, _signal, worker) => {
        started.push([value, worker]); await gates[index].promise; return value;
    }, { fastLane: true });
    assert.deepEqual(started, [['A5', 0], ['A1', 1]]);
    gates[4].resolve(); await turn(); assert.deepEqual(started.at(-1), ['A4', 0]);
    gates[0].resolve(); await turn(); assert.deepEqual(started.at(-1), ['A2', 1]);
    gates[3].resolve(); await turn(); assert.deepEqual(started.at(-1), ['A3', 0]);
    for (const gate of gates) { gate.resolve(); }
    assert.deepEqual(await pending, items, 'results keep input order');
});

test('items sharing an exclusive resource never overlap, and later items may start while one waits', async () => {
    const items = ['A1', 'A2', 'A3', 'B1'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    /** @type {Record<string, import('../../out/core/concurrency').ItemResources>} */
    const needs = { A1: { exclusive: ['db'], serial: false }, A2: { exclusive: ['db'], serial: false }, B1: { exclusive: ['db', 'ports'], serial: false } };
    const pending = mapConcurrentByKey(items, 4, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    }, { resources: value => needs[value] });
    assert.deepEqual(started, ['A1', 'A3'], 'A2 and B1 wait for the database; A3 needs nothing');
    gates[0].resolve(); await turn(); assert.deepEqual(started, ['A1', 'A3', 'B1'], 'an idle target takes the free resource first');
    gates[3].resolve(); await turn(); assert.deepEqual(started, ['A1', 'A3', 'B1', 'A2']);
    for (const gate of gates) { gate.resolve(); }
    assert.deepEqual(await pending, items);
});

test('a serial item waits until nothing runs, and nothing starts beside it', async () => {
    const items = ['A1', 'B1', 'C1', 'D1'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    const pending = mapConcurrentByKey(items, 3, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    }, { resources: value => value === 'B1' ? { exclusive: [], serial: true } : undefined });
    assert.deepEqual(started, ['A1', 'C1', 'D1']);
    gates[0].resolve(); gates[2].resolve(); await turn(); assert.deepEqual(started, ['A1', 'C1', 'D1'], 'D1 still runs');
    gates[3].resolve(); await turn(); assert.deepEqual(started, ['A1', 'C1', 'D1', 'B1']);
    gates[1].resolve(); assert.deepEqual(await pending, items);
});

test('target scheduling redistributes spare workers over skewed targets and reuses worker slots', async () => {
    const items = ['A1', 'A2', 'A3', 'A4', 'B1'], gates = items.map(deferred), /** @type {string[]} */ started = [], /** @type {number[]} */ workers = [];
    let active = 0, peak = 0;
    const pending = mapConcurrentByKey(items, 3, undefined, value => value[0], async (value, index, _signal, worker) => {
        started.push(value); workers.push(worker); peak = Math.max(peak, ++active);
        await gates[index].promise; active--; return value;
    });
    assert.deepEqual(started, ['A1', 'B1', 'A2']);
    gates[4].resolve(); await turn(); assert.deepEqual(started, ['A1', 'B1', 'A2', 'A3']);
    gates[1].resolve(); await turn(); assert.equal(started.at(-1), 'A4');
    for (const gate of gates) { gate.resolve(); }
    assert.deepEqual(await pending, items);
    assert.equal(peak, 3); assert.deepEqual(workers, [0, 1, 2, 1, 2]);
});

test('exclusive target work leaves spare slots for eligible work on other targets', async () => {
    const items = ['A1', 'A2', 'A3', 'B1', 'B2'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    const pending = mapConcurrentByKey(items, 3, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    }, { parallelEligible: value => value[0] !== 'A' });
    assert.deepEqual(started, ['A1', 'B1', 'B2']);
    gates[3].resolve(); gates[4].resolve(); await turn(); assert.equal(started.length, 3);
    gates[0].resolve(); await turn(); assert.equal(started.at(-1), 'A2');
    assert.equal(started.length, 4);
    gates[1].resolve(); await turn(); assert.equal(started.at(-1), 'A3');
    gates[2].resolve(); assert.deepEqual(await pending, items);
});

test('an exclusive item waits for active target work and prevents later FIFO items bypassing it', async () => {
    const items = ['A1', 'A2', 'A3'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    const pending = mapConcurrentByKey(items, 3, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    }, { parallelEligible: value => value !== 'A2' });
    assert.deepEqual(started, ['A1']);
    gates[0].resolve(); await turn(); assert.deepEqual(started, ['A1', 'A2']);
    gates[1].resolve(); await turn(); assert.deepEqual(started, items);
    gates[2].resolve(); assert.deepEqual(await pending, items);
});

test('parallel eligibility is refreshed when a target learns it requires exclusive execution', async () => {
    const items = ['A1', 'A2', 'A3', 'A4'], gates = items.map(deferred), /** @type {string[]} */ started = [];
    let parallel = true;
    const pending = mapConcurrentByKey(items, 2, undefined, value => value[0], async (value, index) => {
        started.push(value); await gates[index].promise; return value;
    }, { parallelEligible: () => parallel });
    assert.deepEqual(started, ['A1', 'A2']);
    parallel = false; gates[0].resolve(); await turn(); assert.deepEqual(started, ['A1', 'A2']);
    gates[1].resolve(); await turn(); assert.deepEqual(started, ['A1', 'A2', 'A3']);
    gates[2].resolve(); await turn(); assert.deepEqual(started, items);
    gates[3].resolve(); assert.deepEqual(await pending, items);
});

test('target scheduler cancels and drains admitted work on the first failure', async () => {
    const gate = deferred(), release = deferred(), error = new Error('failed'), /** @type {string[]} */ started = [];
    let stopped = false, settled = false, failureCalls = 0;
    const pending = mapConcurrentByKey(['A1', 'A2', 'B1', 'B2'], 2, undefined, value => value[0], async (value, _index, signal) => {
        started.push(value);
        if (value === 'A1') { await gate.promise; throw error; }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        stopped = true; await release.promise;
    }, { onFailure: failure => { assert.equal(failure, error); failureCalls++; } });
    pending.catch(() => { settled = true; });
    gate.resolve(); await turn();
    assert.deepEqual(started, ['A1', 'B1']); assert.equal(stopped, true); assert.equal(settled, false);
    release.resolve(); await assert.rejects(pending, failure => failure === error);
    assert.equal(failureCalls, 1);
});

test('target scheduler wakes parked workers on cancellation and drains exclusive work', async () => {
    const abort = new AbortController(), gate = deferred(), /** @type {string[]} */ started = []; let settled = false;
    const pending = mapConcurrentByKey(['A1', 'A2', 'A3'], 3, abort.signal, value => value[0], async value => {
        started.push(value); await gate.promise;
    }, { parallelEligible: () => false });
    pending.catch(() => { settled = true; });
    abort.abort(); await turn(); assert.deepEqual(started, ['A1']); assert.equal(settled, false);
    gate.resolve(); await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(mapConcurrentByKey([], 1, abort.signal, value => value, async () => {}), { name: 'AbortError' });
});

test('target scheduler handles empty inputs, validates limits and supports one worker', async () => {
    assert.deepEqual(await mapConcurrentByKey([], 1, undefined, value => value, async value => value), []);
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
        await assert.rejects(mapConcurrentByKey([], limit, undefined, value => value, async value => value), /Worker limit/);
    }
    const items = ['A1', 'A2', 'B1'], /** @type {string[]} */ started = [];
    assert.deepEqual(await mapConcurrentByKey(items, 1, undefined, value => value[0], async value => {
        started.push(value); await turn(); return value;
    }), items);
    assert.deepEqual(started, items);
});

test('commits stay serialized even when one commit fails', async () => {
    const queue = new SerialQueue(), gate = deferred(), /** @type {number[]} */ seen = [];
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

test('a drained keyed run finishes admitted items, starts no others and resolves',async()=>{
 const {mapConcurrentByKey}=require('../../out/core/concurrency');
 const drain=new AbortController();
 /** @type {number[]} */ const started=[];
 /** @type {(()=>void)[]} */ const finish=[];
 const done=mapConcurrentByKey([0,1,2,3,4],2,undefined,item=>String(item),item=>{started.push(item);return new Promise(resolve=>finish.push(()=>resolve(item*10)));},{drain:drain.signal});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,[0,1]);
 drain.abort();finish[0]();finish[1]();
 const results=await done;assert.deepEqual(started,[0,1]);assert.deepEqual(results.slice(0,2),[0,10]);assert.equal(results[2],undefined);
});

test('inclusive holders of a resource run together but never beside an exclusive holder, and heavy items take several worker slots',async()=>{
 const {mapConcurrentByKey}=require('../../out/core/concurrency');
 /** @param {readonly any[]} needs @param {number} limit */
 const trace=async(needs,limit)=>{
  /** @type {Set<number>} */ const active=new Set();
  /** @type {number[][]} */ const overlaps=[];
  await mapConcurrentByKey(needs.map((_,index)=>index),limit,undefined,index=>String(index),async index=>{
   active.add(index);overlaps.push([...active].sort());await new Promise(resolve=>setTimeout(resolve,20));active.delete(index);
  },{resources:index=>needs[index]});
  return overlaps;
 };
 const reader={exclusive:[],serial:false,inclusive:['db']},writer={exclusive:['db'],serial:false};
 const shared=await trace([reader,reader,writer,undefined],4);
 assert.ok(shared.some(set=>set.includes(0)&&set.includes(1)),'readers share the resource');
 assert.ok(shared.every(set=>!(set.includes(2)&&(set.includes(0)||set.includes(1)))),'the writer never overlaps a reader');
 const heavy=await trace([{exclusive:[],serial:false,workers:3},undefined,undefined,undefined],4);
 assert.ok(heavy.every(set=>!set.includes(0)||set.length<=2),`a three-slot item leaves room for one more: ${JSON.stringify(heavy)}`);
});
