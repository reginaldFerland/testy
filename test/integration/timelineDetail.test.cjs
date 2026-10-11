const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./support/regressions.cjs');
const {traceEvents}=require('../../out/core/timeline');

test('a run reports its batches to the queue and records builds, discovery, instrumentation and event-loop delay on the timeline',{timeout:240000},async t=>{
 const f=await fixture(t);
 /** @type {import('../../out/core/queue').QueueEntry[][]} */ const updates=[];
 /** @type {any} */ (f.engine.options.events).queue=(/** @type {import('../../out/core/queue').QueueEntry[]} */ entries)=>updates.push(entries);
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 assert.ok(updates.some(entries=>entries.some(entry=>entry.state==='running')),'running batches were reported');
 const last=updates.at(-1)??[];
 assert.ok(last.length>=2&&last.every(entry=>entry.state==='passed'),JSON.stringify(last));
 const spans=f.engine.timeline.recent(),categories=new Set(spans.map(span=>span.category));
 for(const category of ['build','discovery','instrumentation','batch','run'])assert.ok(categories.has(/** @type {any} */ (category)),`${category} spans: ${[...categories]}`);
 const trace=traceEvents(spans,f.engine.timeline.samples());
 assert.ok(trace.traceEvents.some(event=>event.name==='thread_name'&&/Preparation 1/.test(String(/** @type {any} */ (event.args).name))));
 assert.ok(trace.traceEvents.some(event=>event.ph==='C'),'event-loop delay samples');
});
