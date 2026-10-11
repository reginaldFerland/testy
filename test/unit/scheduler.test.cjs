const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Scheduler} = require('../../out/core/scheduler');
const flush = async()=>{for(let i=0;i<12;i++) await Promise.resolve();};
/** @returns {{promise:Promise<void>,resolve:()=>void,reject:(error?:unknown)=>void}} */
const gate=()=>{let resolve=/** @type {()=>void} */ (()=>{}),reject=/** @type {(error?:unknown)=>void} */ (()=>{});const promise=new Promise((yes,no)=>{resolve=/** @type {()=>void} */ (yes);reject=no;});return {promise,resolve,reject};};
/** @typedef {ReturnType<typeof gate> & {batch:import('../../out/core/scheduler').ChangeBatch,signal:AbortSignal}} Run */
function setup(){

 /** @type {(()=>void)|undefined} */
 let callback;
 /** @type {Run[]} */
 const runs=[];
 /** @type {unknown[]} */
 const errors=[];
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
 const s=setup();const manual=gate();let signal=/** @type {AbortSignal|undefined} */ (undefined);const task=s.scheduler.runManual(token=>{signal=token;return manual.promise;});
 s.scheduler.request(['a']);await s.tick();assert.equal(/** @type {AbortSignal} */ (signal).aborted,false);assert.equal(s.runs.length,0);
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

test('queued manual cancellation settles immediately without cancelling active work or consuming changes',async()=>{
 const s=setup(),wait=gate(),abort=new AbortController();let activeSignal=/** @type {AbortSignal|undefined} */ (undefined);let ran=false;
 const active=s.scheduler.runManual(signal=>{activeSignal=signal;return wait.promise;});
 s.scheduler.request(['a'],true);await s.tick();
 const queued=s.scheduler.runManual(async()=>{ran=true;},abort.signal,true);
 const cancelled=assert.rejects(queued,{name:'AbortError'});abort.abort();await flush();
 assert.equal(/** @type {any} */ (s.scheduler).manual.length,0);await cancelled;assert.equal(ran,false);assert.equal(/** @type {AbortSignal} */ (activeSignal).aborted,false);
 wait.resolve();await active;await flush();assert.deepEqual(s.runs[0].batch.files,['a']);assert.equal(s.runs[0].batch.full,true);
 s.runs[0].resolve();await flush();s.scheduler.dispose();
});

test('removing cancelled queued jobs preserves remaining manual FIFO order',async()=>{
 const s=setup(),wait=gate(),abort=new AbortController(),/** @type {string[]} */ order=[];
 const first=s.scheduler.runManual(()=>wait.promise);
 const cancelled=s.scheduler.runManual(async()=>{order.push('cancelled');},abort.signal);
 const rejection=assert.rejects(cancelled,{name:'AbortError'});
 const second=s.scheduler.runManual(async()=>{order.push('second');}),third=s.scheduler.runManual(async()=>{order.push('third');});
 abort.abort();await rejection;wait.resolve();await Promise.all([first,second,third]);
 assert.deepEqual(order,['second','third']);s.scheduler.dispose();
});
test('an idle job starts after a quiet period, and changes, manual runs and pauses cancel it until the next one',async()=>{
 const s=setup();
 /** @type {AbortSignal[]} */
 const idle=[];
 let release=gate();
 s.scheduler.setIdle(signal=>{idle.push(signal);return release.promise;},2000);
 await s.tick();assert.equal(idle.length,1,'nothing was pending, so it starts after its delay');
 s.scheduler.request(['a']);assert.equal(idle[0].aborted,true,'a change cancels it like an automatic run');
 await s.tick();assert.equal(s.runs.length,0,'the change waits for the cancelled job to exit');
 release.resolve();await flush();assert.equal(s.runs.length,1);
 release=gate();s.runs[0].resolve();await flush();
 await s.tick();assert.equal(idle.length,2,'the cancelled job waits for the next quiet period');
 const manual=s.scheduler.runManual(async()=>{});assert.equal(idle[1].aborted,true,'a manual run cancels it too');
 release.resolve();await manual;await flush();
 release=gate();s.scheduler.setPaused(true);await s.tick();assert.equal(idle.length,2,'paused: it does not start');
 s.scheduler.setPaused(false);await s.tick();assert.equal(idle.length,3);
 release.resolve();await flush();await s.tick();assert.equal(idle.length,3,'a completed job does not run again');
 s.scheduler.setIdle(async()=>{throw new Error('broken');});await s.tick();assert.equal(s.errors.length,1,'its errors are reported');
 s.scheduler.setIdle(async()=>{idle.push(new AbortController().signal);});s.scheduler.setIdle(undefined);await s.tick();assert.equal(idle.length,3,'undefined removes it');
 s.scheduler.dispose();
});

/** A scheduler whose timers fire only when a test runs them, by delay. @param {number} grace */
function timedSetup(grace){
 /** @type {{fn:()=>void,delay:number}[]} */
 const timers=[];
 /** @type {(Run & {superseded:AbortSignal})[]} */
 const runs=[];
 const scheduler=new Scheduler({debounce:100,schedule:(fn,delay)=>{const timer={fn,delay};timers.push(timer);return ()=>{const index=timers.indexOf(timer);if(index!==-1)timers.splice(index,1);};},
  run:(batch,signal,superseded)=>{const wait=gate();runs.push({batch,signal,superseded,...wait});return wait.promise;}});
 scheduler.setGrace(grace);
 const fire=async(/** @type {number} */ delay)=>{for(const timer of timers.filter(item=>item.delay===delay)){timers.splice(timers.indexOf(timer),1);timer.fn();}await flush();};
 return {scheduler,runs,timers,fire};
}

test('a save supersedes an automatic run instead of aborting it, and aborts it once the grace period passes',async()=>{
 const {Superseded}=require('../../out/core/scheduler');
 const s=timedSetup(5000);s.scheduler.request(['a']);await s.fire(100);
 const run=s.runs[0];s.scheduler.request(['b']);
 assert.equal(run.signal.aborted,false);assert.equal(run.superseded.aborted,true);
 assert.ok(run.superseded.reason instanceof Superseded);assert.deepEqual(run.superseded.reason.files,['b']);
 /** @type {string[][]} */ const later=[];run.superseded.reason.onChange(files=>later.push([...files]));
 s.scheduler.request(['c']);assert.deepEqual(later,[['c']]);assert.deepEqual(run.superseded.reason.files,['b','c']);
 await s.fire(100);assert.equal(s.runs.length,1,'the next run waits for the superseded one');
 await s.fire(5000);assert.equal(run.signal.aborted,true);
 run.resolve();await flush();assert.equal(s.runs.length,2);
 assert.deepEqual(s.runs[1].batch.files,['a','b','c'],'a superseded run consumes none of its changes, even when it resolves');
 s.runs[1].resolve();await flush();s.scheduler.dispose();
});

test('a superseded run that ends within the grace period starts the next run without aborting',async()=>{
 const s=timedSetup(5000);s.scheduler.request(['a']);await s.fire(100);
 const run=s.runs[0];s.scheduler.request(['b']);await s.fire(100);
 run.reject(new (require('../../out/core/errors').Cancelled)());await flush();
 assert.equal(run.signal.aborted,false);assert.equal(s.runs.length,2);assert.equal(s.timers.some(timer=>timer.delay===5000),false,'the deadline is cleared');
 s.runs[1].resolve();await flush();s.scheduler.dispose();
});

test('full refreshes, pauses, manual runs and a zero grace period still abort an automatic run at once',async()=>{
 for(const action of ['full','pause','manual','zero']){
  const s=timedSetup(action==='zero'?0:5000);s.scheduler.request(['a']);await s.fire(100);const run=s.runs[0];
  if(action==='full')s.scheduler.request([],true);
  else if(action==='pause')s.scheduler.setPaused(true);
  else if(action==='manual')void s.scheduler.runManual(async()=>{}).catch(()=>{});
  else s.scheduler.request(['b']);
  assert.equal(run.signal.aborted,true,action);run.resolve();await flush();s.scheduler.dispose();
 }
});
