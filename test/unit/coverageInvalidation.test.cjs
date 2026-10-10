const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {CoverageStore}=require('../../out/core/coverage');

function trace(groupId='a') {return {groupId,dependencies:['/code.cs'],inputs:{'/code.cs':'v1'},reliable:true,timestamp:1,coverage:[{file:'/code.cs',hash:'v1',lines:[{line:1,hits:1}]}]};}

test('transient coverage invalidation writes only changed contributions and preserves failed writes',async()=>{
 const store=new CoverageStore(),ids=new Set(['a','b']);store.replace([trace('a'),trace('b')],ids);store.takeDelta();
 const original=store.traces.get('b');
 store.markStale(ids);store.markStale(new Set(['b']),false);
 const delta=await store.takeDeltaAsync();assert.deepEqual(delta.traces.map(t=>t.groupId),['a']);assert.equal(store.traces.get('b'),original);
 store.markStale(new Set(['a']),false);store.markStale(new Set(['a']));assert.equal((await store.takeDeltaAsync()).traces.length,0,'returning to persisted stale state is also unchanged');
 store.replace([trace('b')],ids);store.markStale(new Set(['b']));store.markStale(new Set(['b']),false);
 assert.deepEqual(store.takeDelta().traces.map(t=>t.groupId),['b'],'a new contribution is still dirty after a transient toggle');
 store.markStale(new Set(['b']));const pending=store.takeDelta();store.markStale(new Set(['b']),false);
 store.retryDelta(pending);store.markStale(new Set(['b']));
 assert.deepEqual(store.takeDelta().traces.map(t=>t.groupId),['b'],'retry state must survive a toggle while a write is in flight');
 store.markStale(new Set(['a']),false);store.takeDelta();store.markStale(ids);store.invalidate(ids);store.markStale(ids,false);
 assert.equal(store.traces.get('a').reliable,false);assert.equal(store.takeDelta().traces.length,2,'reliability changes cannot be undone by freshness restoration');
 store.markHistorical(new Set(['a']));store.markStale(new Set(['a']),false);
 assert.equal(store.traces.get('a').historical,true);assert.equal(store.traces.get('a').stale,true);
});

test('large live coverage deltas yield, retain cancellation state and restart after concurrent invalidation',async()=>{
 const store=new CoverageStore(),sourceIds=Array.from({length:9000},(_,i)=>`s${i}`),ids=new Set(['a','b']);
 store.restorePacked(sourceIds.map((id,i)=>({id,file:`/s${i}.cs`,hash:'v1',lines:[1]})),[...ids].map(groupId=>({...trace(groupId),coverage:[],sourceIds})));
 store.markStale(ids,false);store.takeDelta();store.markStale(ids);
 const abort=new AbortController(),pending=store.takeDeltaAsync(abort.signal);await turn();abort.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(store.changedTraces.size,2);
 const next=store.takeDeltaAsync();await turn();store.markStale(new Set(['b']),false);
 const delta=await next;assert.deepEqual(delta.traces.map(t=>t.groupId),['a']);assert.equal(delta.sources.length,9000);
 assert.equal(store.changedTraces.size,0);
 const aggregate=store.summarizeAsync(new Map(sourceIds.map((_,i)=>[`/s${i}.cs`,'v1'])));
 await turn();store.markStale(new Set(['b']));const summaries=await aggregate;
 assert.equal(summaries.length,9000);assert.ok(summaries.every(s=>s.stale));
});
