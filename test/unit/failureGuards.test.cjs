const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mapConcurrent}=require('../../out/core/concurrency');
const {Scheduler}=require('../../out/core/scheduler');
const flush=async()=>{for(let i=0;i<12;i++) await Promise.resolve();};

test('a throwing failure notification does not bypass draining sibling workers',async()=>{
 const drained=[];let release;const slow=new Promise(resolve=>{release=resolve;});
 const run=mapConcurrent([0,1],2,undefined,async(item,_index,signal)=>{
  if(item===0)throw new Error('first failure');
  await slow;drained.push(signal.aborted);return item;
 },()=>{throw new Error('notification failure');});
 await flush();release();
 await assert.rejects(run,/first failure/);
 assert.deepEqual(drained,[true]);
});

function scheduler(run){
 let callback;const errors=[];
 const instance=new Scheduler({debounce:1,schedule:fn=>{callback=fn;return()=>{if(callback===fn)callback=undefined;};},error:error=>errors.push(error),run});
 return{instance,errors,tick:async()=>{const fn=callback;callback=undefined;fn?.();await flush();}};
}

test('a run that throws synchronously reports its error and does not wedge the scheduler',async()=>{
 let throwing=true;const batches=[];
 const s=scheduler(batch=>{if(throwing)throw new Error('synchronous failure');batches.push(batch);return Promise.resolve();});
 s.instance.request(['a']);await s.tick();
 assert.equal(s.errors.length,1);assert.equal(s.instance.isRunning,false);
 throwing=false;s.instance.request(['b']);await s.tick();
 assert.deepEqual(batches.map(batch=>batch.files),[['a','b']]);assert.equal(s.instance.isRunning,false);
 s.instance.dispose();
});

test('a manual job that throws synchronously rejects and lets later jobs run',async()=>{
 const s=scheduler(()=>Promise.resolve());
 await assert.rejects(s.instance.runManual(()=>{throw new Error('synchronous manual failure');}),/synchronous manual failure/);
 assert.equal(s.instance.isRunning,false);
 let ran=false;await s.instance.runManual(async()=>{ran=true;});
 assert.equal(ran,true);s.instance.dispose();
});
