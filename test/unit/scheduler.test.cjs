const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Scheduler} = require('../../out/core/scheduler');
const flush = async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function setup(){
 let callback; const runs=[]; const errors=[];
 const scheduler=new Scheduler({debounce:100, schedule:fn=>{callback=fn;return ()=>{if(callback===fn)callback=undefined;};},error:error=>errors.push(error),run:(batch,signal)=>{const wait=gate();runs.push({batch,signal,...wait});return wait.promise;}});
 return {scheduler,runs,errors,tick:async()=>{const fn=callback;callback=undefined;fn?.();await flush();}};
}
test('a burst starts one run containing every changed file',async()=>{
 const s=setup();s.scheduler.request(['a']);s.scheduler.request(['b']);await s.tick();
 assert.equal(s.runs.length,1);assert.deepEqual(s.runs[0].batch.files,['a','b']);s.runs[0].resolve();await flush();s.scheduler.dispose();
});
test('cancels immediately but waits for exit and debounce before restart',async()=>{
 const s=setup();s.scheduler.request(['a'],true);await s.tick();s.scheduler.request(['b']);
 assert.equal(s.runs[0].signal.aborted,true);await s.tick();assert.equal(s.runs.length,1);
 s.runs[0].resolve();await flush();assert.equal(s.runs.length,2);
 assert.deepEqual(s.runs[1].batch,{files:['a','b'],full:true,generation:s.runs[0].batch.generation});s.runs[1].resolve();await flush();s.scheduler.dispose();
});
test('a save does not cancel a manual run',async()=>{
 const s=setup();const manual=gate();let signal;const task=s.scheduler.runManual(token=>{signal=token;return manual.promise;});
 s.scheduler.request(['a']);await s.tick();assert.equal(signal.aborted,false);assert.equal(s.runs.length,0);
 manual.resolve();await task;await flush();assert.equal(s.runs.length,1);s.runs[0].resolve();await flush();s.scheduler.dispose();
});
test('a failed build preserves pending changes without spinning in retries',async()=>{
 const s=setup();s.scheduler.request(['a']);await s.tick();s.runs[0].reject(new Error('build failed'));await flush();
 assert.equal(s.runs.length,1);assert.equal(s.errors.length,1);s.scheduler.request(['b']);await s.tick();
 assert.deepEqual(s.runs[1].batch.files,['a','b']);s.runs[1].resolve();await flush();s.scheduler.dispose();
});
test('pause retains changes and resume schedules them',async()=>{
 const s=setup();s.scheduler.setPaused(true);s.scheduler.request(['a']);await s.tick();assert.equal(s.runs.length,0);
 s.scheduler.setPaused(false);await s.tick();assert.equal(s.runs.length,1);s.runs[0].resolve();await flush();s.scheduler.dispose();
});
test('changing debounce replaces a queued timer instead of duplicating runs',async()=>{
 const s=setup();s.scheduler.request(['a']);s.scheduler.setDebounce(200);await s.tick();await s.tick();assert.equal(s.runs.length,1);
 s.runs[0].resolve();await flush();s.scheduler.dispose();
});
test('disposal cancels work and removes queued startup timers',async()=>{
 const s=setup();s.scheduler.request([],true);s.scheduler.dispose();await s.tick();assert.equal(s.runs.length,0);
});
