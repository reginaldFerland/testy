const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {TestEngine}=require('../../out/services/engine');
const {executeSelection}=require('../../out/services/engine/execute');
const {Baseline}=require('../../out/services/engine/baseline');
const {CoverageCache}=require('../../out/services/cache');
const {CoverageStore}=require('../../out/core/coverage');

/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-saves-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 /** @type {string[]} */ const outputs=[];
 const cache=new CoverageCache(path.join(root,'state'),()=>{});
 /** @type {string[][]} */ const writes=[],save=cache.save.bind(cache);
 cache.save=async(/** @type {import('../../out/core/coverage').CoverageDelta} */ delta,/** @type {AbortSignal | undefined} */ signal)=>{writes.push(delta.traces.map(trace=>trace.groupId));return save(delta,signal);};
 const engine=new TestEngine({roots:[root],storage:path.join(root,'state'),tools:root,analyzer:'',configuration:()=>/** @type {any} */ ({}) /* partial mock: unused by these scenarios */,events:{
  output:text=>outputs.push(text),phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},result(){}}},{coverageCache:cache}),
  /** @type {any} */ internals=engine; // private members: saveDelay, options
 internals.saveDelay=40;
 const persisted=async()=>{const store=new CoverageStore();await new CoverageCache(path.join(root,'state'),()=>{}).restore(store);return [...store.traces.keys()].sort();};
 return {root,engine,internals,cache,writes,save,outputs,persisted};
}
const trace=(/** @type {string} */ groupId,/** @type {string} */ file=`/w/${groupId}.cs`)=>({groupId,dependencies:[file],coverage:[{file,hash:'h',lines:[{line:1,hits:1}]}],reliable:true,timestamp:1,inputs:{}});
const live=new Set(['a','b','c','d','e']);

test('contributions completing close together share one locked write',async t=>{
 const f=await fixture(t);
 for(const id of ['a','b','c']){f.engine.coverage.replace([trace(id)],live);f.engine.scheduleSave();}
 assert.deepEqual(f.writes,[],'nothing is written while the window is open');
 await delay(200);
 assert.deepEqual(f.writes,[['a','b','c']]);
 assert.deepEqual(await f.persisted(),['a','b','c']);
 f.engine.coverage.replace([trace('d')],live);f.engine.scheduleSave();
 await f.engine.save();
 assert.deepEqual(f.writes,[['a','b','c'],['d']],'an explicit save writes at once and replaces the scheduled one');
 await delay(100);assert.equal(f.writes.length,2);
});

test('a cancelled caller stops waiting for a blocked save, and its changes stay pending in order',async t=>{
 const f=await fixture(t);/** @type {() => void} */ let release=()=>{};const gate=new Promise(resolve=>{release=()=>resolve(undefined);});
 f.cache.save=async(/** @type {import('../../out/core/coverage').CoverageDelta} */ delta,/** @type {AbortSignal | undefined} */ signal)=>{f.writes.push(delta.traces.map(trace=>trace.groupId));await gate;return f.save(delta,signal);};
 f.engine.coverage.replace([trace('a')],live);
 const first=f.engine.save();
 await delay(10);
 f.engine.coverage.replace([trace('b')],live);
 const abort=new AbortController(),waiting=f.engine.save(abort.signal);abort.abort();
 await assert.rejects(waiting,{name:'AbortError'});
 assert.deepEqual(f.writes,[['a']],'the cancelled save never overtakes the blocked one');
 release();await first;
 assert.deepEqual(await f.persisted(),['a']);
 await f.engine.save();
 assert.deepEqual(await f.persisted(),['a','b'],'the cancelled delta is written by the next save');
});

test('cancelling a run mid-batch keeps committed files published and flushes them on disposal',async t=>{
 const f=await fixture(t),engine=f.engine;
 f.internals.saveDelay=60_000; // Only disposal can flush this scheduled save.
 const group=(/** @type {string} */ name)=>({id:name,project:'/w/T.csproj',framework:'net10.0',assembly:'/w/T.dll',file:`/w/${name}.cs`,tests:[{id:`${name}1`,name,fullyQualifiedName:name,line:1,node:{uid:`${name}1`}}]});
 const a=group('a'),b=group('b');engine.groups=[a,b];
 const controller=new AbortController(),/** @type {string[][]} */ coverage=[];
 f.internals.options.events.coverage=()=>coverage.push([...engine.coverage.traces.keys()]);
 const sessions={canRunParallel:()=>true,run:async(/** @type {import('../../out/core/model').TestFile[]} */ groups,/** @type {unknown} */ _before,/** @type {unknown} */ _worker)=>{
  if(groups[0].id==='a'){return {results:[{id:'a1',name:'a',fullyQualifiedName:'a',outcome:'passed',duration:1}],coverageAvailable:true,executedGroups:groups,trace:trace('a')};}
  await new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}));return undefined;
 }};
 const baseline=new Baseline('generation',new Map());
 const run=/** @type {any} */ ({controller,signal:controller.signal,config:{mode:'affected',configuration:'Debug'},configured:{coverage:true,configuration:'Debug'},manualOperation:false,changes:[],testLimit:2,topology:engine.topology,baseline}); // partial RunContext: only the fields executeSelection reads here
 const executing=executeSelection(engine,run,/** @type {any} */ ({before:new Map(),revision:engine.sources.revision,obsoleteBuild:false}),
  /** @type {any} */ ({coverageTool:'collector',sessions,liveIds:new Set(['a','b']),runtimeTreeChanged:false}),/** @type {any} */ ({selection:{groups:[a,b]}})); // partial BuildResult/PreparedTests/SelectedRun mocks
 while(!engine.coverage.traces.has('a')){await delay(5);}
 await delay(10);controller.abort();
 await assert.rejects(executing,{name:'AbortError'});
 assert.ok(coverage.some(ids=>ids.includes('a')),'the completed file was published before cancellation');
 assert.deepEqual([...baseline.completed],['a'],'only the committed file is checkpointed');
 assert.deepEqual(f.writes,[],'the batch is still waiting for its window');
 await engine.dispose();
 assert.deepEqual(f.writes,[['a']]);
 assert.deepEqual(await f.persisted(),['a'],'the cache holds exactly the committed contribution');
});
