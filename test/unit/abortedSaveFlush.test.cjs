const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {TestEngine}=require('../../out/services/engine');
const {CoverageCache}=require('../../out/services/cache');
const {CoverageStore}=require('../../out/core/coverage');

/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-aborted-save-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const engine=/** @type {any} */ (new TestEngine(/** @type {any} */ ({roots:[root],storage:path.join(root,'state'),tools:root,analyzer:'',configuration:()=>({}),events:{
  output(){},phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},result(){}}})));
 const save=engine.cache.save.bind(engine.cache),writes=/** @type {string[][]} */ ([]);
 let blocked=true,started=false;
 // The first write waits on another window's lock until its signal aborts; later writes go through.
 engine.cache.save=async(/** @type {any} */ delta,/** @type {AbortSignal} */ signal)=>{
  writes.push(delta.traces.map((/** @type {any} */ trace)=>trace.groupId));
  if(blocked&&delta.traces.length){blocked=false;started=true;await new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}
  return save(delta,signal);
 };
 const persisted=async()=>{const store=new CoverageStore();await new CoverageCache(path.join(root,'state'),()=>{}).restore(store);return [...store.traces.keys()].sort();};
 return {engine,writes,persisted,started:()=>started};
}
const trace=(/** @type {string} */ groupId)=>({groupId,dependencies:[`/w/${groupId}.cs`],coverage:[{file:`/w/${groupId}.cs`,hash:'h',lines:[{line:1,hits:1}]}],reliable:true,timestamp:1,inputs:{}});

test('a delta whose end-of-run save was aborted is written when the engine is disposed',async t=>{
 const f=await fixture(t);
 f.engine.coverage.replace([trace('a')],new Set(['a']));
 const run=new AbortController(),saving=f.engine.save(run.signal);
 while(!f.started()){await delay(1);}
 run.abort(new Error('closing'));
 await assert.rejects(saving);
 await delay(10);
 assert.deepEqual(await f.persisted(),[],'the aborted write stored nothing');
 await f.engine.dispose();
 assert.deepEqual(await f.persisted(),['a'],'disposal flushed the pending delta under the engine signal');
 assert.deepEqual(f.writes,[['a'],['a']]);
});

test('the flush at the end of a run writes a delta its aborted save left pending, without a scheduled save',async t=>{
 const f=await fixture(t);
 f.engine.coverage.replace([trace('b')],new Set(['b']));
 const run=new AbortController(),saving=f.engine.save(run.signal);
 while(!f.started()){await delay(1);}
 run.abort(new Error('cancelled'));
 await assert.rejects(saving);
 assert.equal(f.engine.saveTimer,undefined,'no save is scheduled');
 await f.engine.flushSaves();
 assert.deepEqual(await f.persisted(),['b']);
 await f.engine.flushSaves();
 assert.deepEqual(f.writes.slice(2),[[]],'a second flush has nothing left to write');
 await f.engine.dispose();
});
