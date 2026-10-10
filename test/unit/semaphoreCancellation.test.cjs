const test=require('node:test'),assert=require('node:assert/strict');
const {Semaphore}=require('../../out/core/concurrency');

test('an aborted semaphore waiter leaves the queue without taking or leaking a permit',async()=>{
 const pool=new Semaphore(1);let release;
 const holder=pool.run(undefined,()=>new Promise(resolve=>{release=resolve;}));
 const abort=new AbortController(),started=[];
 const waiting=pool.run(abort.signal,async()=>{started.push('aborted');});
 abort.abort();
 // Rejected while the permit is still held: the waiter does not wait for its turn.
 await assert.rejects(waiting,{name:'AbortError'});
 assert.equal(pool.waiting.length,0);
 const next=pool.run(undefined,async()=>{started.push('next');});
 release();await holder;await next;
 assert.deepEqual(started,['next']);
 // Every permit was returned: the full capacity can be borrowed again.
 const borrowed=pool.tryRun(undefined,async()=>'borrowed');
 assert.ok(borrowed);assert.equal(await borrowed,'borrowed');
});
