// Regression scenarios: baseline checkpoints, cancellation and persisted coverage. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {defined,fixture}=require('./support/regressions.cjs');

test('ordinary save invalidation persists only the newly executed file contribution',{timeout:90000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Arithmetic.cs');assert.equal((await f.run([],true)).passed,3);
 const /** @type {string[]} */ writes=[],save=f.internal.cache.save.bind(f.internal.cache);
 f.internal.cache.save=async(/** @type {{traces: {groupId: string}[]}} */ delta,/** @type {unknown[]} */ ...args)=>{writes.push(...delta.traces.map(t=>t.groupId));return save(delta,...args);};
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 0'));
 await f.engine.markChanged([source]);const result=await f.run([source]);assert.equal(result.passed,2);assert.deepEqual(f.state.selected,['CalculatorTests.cs']);
 const selected=defined(f.engine.groups.find(group=>defined(group.file).endsWith('CalculatorTests.cs')));
 assert.deepEqual(writes,[selected.id]);assert.ok([...f.engine.coverage.traces.values()].every(trace=>!trace.stale));
});

test('manual multi-file coverage retains the unselected part of an all-mode aggregate',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.mode='all';
 await fs.writeFile(f.file('ImpactDemo/Third.cs'),'namespace ImpactDemo; public static class Third { public static int Value()=>42; }');
 await fs.writeFile(f.file('ImpactDemo.Tests/ThirdTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; using ImpactDemo; [TestClass] public class ThirdTests { [TestMethod] public void Test()=>Assert.AreEqual(42,Third.Value()); }');
 assert.equal((await f.run([],true)).passed,4);
 const before=defined(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes));
 const selected=f.engine.groups.filter(group=>!defined(group.file).endsWith('ThirdTests.cs'));
 const result=await f.run([],false,{groups:new Set(selected.map(group=>group.id)),coverage:true});
 assert.equal(result.tests,3);assert.equal(result.files,2);
 const after=defined(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes));
 assert.equal(after.covered,before.covered);assert.equal(after.total,before.total);
 assert.equal(after.stale,true,'an aggregate has no file attribution, so its retained history must be marked honestly');
 for(const group of selected)assert.ok(f.engine.coverage.traces.has(group.id),'the new complete file contribution must be collected');
 await f.run([],false,{groups:new Set([selected[0].id]),coverage:false});
 assert.equal(defined(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes)).stale,true,'matching hashes cannot refresh a superseded aggregate');
 assert.equal((await f.run([],true)).passed,4);
 assert.equal(defined(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes)).stale,false);
});

test('an aborted checkpoint retries its unsaved coverage without relearning the completed file',{timeout:90000},async t=>{
 const f=await fixture(t),abort=new AbortController();
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
 const {withLock}=require('../../out/services/lock'),{CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage');
 /** @type {() => void} */ let release=()=>{};
 /** @type {() => void} */ let ready=()=>{};
 let released=false;
 /** @type {Promise<void>} */ const gate=new Promise(resolve=>release=()=>{released=true;resolve();}), /** @type {Promise<void>} */ acquired=new Promise(resolve=>ready=resolve);
 const holding=withLock(path.join(f.temp,'state','coverage-v3.lock'),undefined,async()=>{ready();await gate;});await acquired;
 const save=f.internal.cache.save.bind(f.internal.cache);
 f.internal.cache.save=async(/** @type {unknown} */ delta,/** @type {AbortSignal} */ signal)=>{
  const pending=save(delta,signal);abort.abort();
  const fallback=setTimeout(release,2000);
  try{return await pending;}finally{clearTimeout(fallback);}
 };
 try{
  await assert.rejects(f.engine.run({files:[],full:true,generation:99},abort.signal),{name:'AbortError'});
  assert.equal(released,false,'cancellation must finish while the other writer still owns the lock');
  assert.equal(defined(f.engine.baselineProgress).completed,1);
 }finally{release();await holding;f.internal.cache.save=save;}
 const resumed=await f.engine.run({files:[],full:true,generation:99},new AbortController().signal);
 assert.equal(resumed.files,1);
 const restored=new CoverageStore();await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(restored);
 assert.equal(restored.traces.size,2,'both the retried checkpoint and remaining file must be persisted');
});

test('switching from all to affected mode retains aggregate history through cancelled learning',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.mode='all';
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
 assert.equal((await f.run([],true)).passed,3);
 const {projectCoverageId}=require('../../out/services/runner');
 const aggregate=projectCoverageId(f.engine.groups[0]);assert.ok(f.engine.coverage.traces.has(aggregate));
 const original=f.engine.coverage.summarize(f.engine.hashes);
 f.config.mode='affected';const abort=new AbortController();
 /** @type {string | undefined} */ let active;
 f.state.started=group=>{if(active&&active!==group.id)abort.abort();active=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:123},abort.signal),()=>abort.signal.aborted);
 assert.equal(defined(f.engine.baselineProgress).completed,1);
 assert.equal(defined(f.engine.coverage.traces.get(aggregate)).historical,true);
 for(const source of original){
  const retained=defined(f.engine.coverage.summary(source.file,f.engine.hashes));
  assert.equal(retained.covered,source.covered,'interrupted learning must retain the unlearned contribution');
 }
 f.state.started=()=>{};
 const resumed=await f.engine.run({files:[],full:true,generation:123},new AbortController().signal);
 assert.equal(resumed.files,1);assert.equal(f.engine.coverage.traces.has(aggregate),false);
 assert.ok(f.engine.coverage.summarize(f.engine.hashes).every(source=>!source.stale));
});

test('baseline checkpoints completed files and resumes without rerunning unchanged completed work',{timeout:90000},async t=>{
 const f=await fixture(t), abort=new AbortController();
 /** @type {string | undefined} */ let active;
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
 f.state.started=(group)=>{if(active && active!==group.id){abort.abort();}active=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:42},abort.signal),()=>abort.signal.aborted);
 assert.equal(f.engine.coverage.traces.size,1);assert.deepEqual(f.engine.baselineProgress,{completed:1,total:2});
 const completed=[...f.engine.coverage.traces.values()][0];f.state.started=()=>{};
 const pending=defined(f.engine.groups.find(group=>group.id!==completed.groupId));
 await f.run([],false,{groups:new Set([pending.id]),coverage:false});
 assert.equal(defined(f.engine.baselineProgress).completed,1,'a manual run without collection must not mark an unlearned file complete');
 const resumed=await f.engine.run({files:[],full:true,generation:42},new AbortController().signal);
 assert.equal(resumed.files,1);assert.equal(f.engine.baselineProgress,undefined);
 assert.equal(defined(f.engine.coverage.traces.get(completed.groupId)).timestamp,completed.timestamp);
 // Reopen restores stale coverage, while a new baseline is still required.
 const {CoverageStore}=require('../../out/core/coverage'), {CoverageCache}=require('../../out/services/cache');
 const restored=new CoverageStore();await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(restored);
 assert.equal(restored.traces.size,2);assert.ok([...restored.traces.values()].every(trace=>trace.stale && !trace.reliable));
});
