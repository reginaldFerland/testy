const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {TestEngine}=require('../../out/services/engine');
const {selectRun}=require('../../out/services/engine/select');
const {CoverageCache}=require('../../out/services/cache');
const {ProjectIndex}=require('../../out/core/selection');
const {contentHash,normalizePath}=require('../../out/core/paths');
const {TestOutcomes}=require('../../out/core/runPolicy');
const {createTesty}=require('./support/controller.cjs');
/** @typedef {import('../../out/core/coverage').CoverageDelta & {outcomes: import('../../out/core/runPolicy').OutcomeDelta}} SavedDelta */

/** @param {import('node:test').TestContext} t */
async function storage(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-outcomes-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return path.join(root,'state');
}
/**
 * @param {string} state
 * @param {string[]} [outputs]
 * @param {Partial<import('../../out/services/engine').EngineServices>} [services]
 */
function engine(state,outputs=[],services={}){
 return new TestEngine({roots:[],storage:state,tools:state,analyzer:'',configuration:()=>/** @type {any} */ ({}) /* partial mock: unused by these scenarios */,events:{output:(/** @type {string} */ text)=>outputs.push(text),phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},result(){}}},services);
}
/**
 * @param {string} state
 * @param {string[]} [outputs]
 * @param {Partial<import('../../out/services/engine').EngineServices>} [services]
 */
async function restored(state,outputs,services){const next=engine(state,outputs,services);await next.restore();return next;}
// `lastOutcomes` is a private member of the engine.
const record=(/** @type {any} */ target,/** @type {string} */ group,/** @type {Record<string, import('../../out/core/runPolicy').TestOutcome>} */ outcomes)=>{for(const [id,outcome] of Object.entries(outcomes))target.lastOutcomes.record(group,{id,outcome});};
const outcomes=(/** @type {TestEngine} */ target)=>Object.fromEntries([...target.outcomes].sort(([a],[b])=>a.localeCompare(b)));
const saved=(/** @type {string} */ state,/** @type {string} */ group)=>fs.readFile(path.join(state,'coverage-v3','outcomes',`${contentHash(group)}.json`),'utf8').then(JSON.parse,()=>undefined);

test('test outcomes round-trip through the coverage cache as one compact record per file',async t=>{
 const state=await storage(t),first=engine(state);
 record(first,'/w/A.cs',{a1:'passed',a2:'failed',a3:'skipped'});record(first,'/w/B.cs',{b1:'errored',b2:'passed'});
 await first.save();
 assert.deepEqual(await saved(state,'/w/A.cs'),{format:3,groupId:'/w/A.cs',passed:['a1'],failed:['a2'],skipped:['a3']},'ids are listed under their outcome; empty lists are omitted');
 /** @type {SavedDelta[]} */ const writes=[],coverageCache=new CoverageCache(state,()=>{}),save=coverageCache.save.bind(coverageCache);
 coverageCache.save=async(/** @type {SavedDelta} */ delta,/** @type {AbortSignal | undefined} */ signal)=>{writes.push(delta);return save(delta,signal);};
 const second=await restored(state,[],{coverageCache});
 assert.deepEqual(outcomes(second),{'/w/A.cs:a1':'passed','/w/A.cs:a2':'failed','/w/A.cs:a3':'skipped','/w/B.cs:b1':'errored','/w/B.cs:b2':'passed'});
 assert.equal(second.failing.has('/w/A.cs'),true);assert.equal(second.failing.has('/w/B.cs'),true);
 writes.length=0;await second.save();assert.deepEqual(writes.filter(delta=>delta.outcomes.saved.length||delta.outcomes.removed.length),[],'restored outcomes are not written back');
 record(second,'/w/A.cs',{a2:'passed'});await second.save();
 assert.deepEqual(writes.filter(delta=>delta.outcomes.saved.length).map(delta=>delta.outcomes.saved.map((/** @type {import('../../out/core/runPolicy').StoredOutcomes} */ stored)=>stored.groupId)),[['/w/A.cs']],'only a changed file is rewritten');
 const third=await restored(state);assert.equal(third.outcomes.get('/w/A.cs:a2'),'passed');assert.equal(third.failing.has('/w/A.cs'),false);
});

test('a cache written before outcomes were saved still restores its coverage, with no outcomes',async t=>{
 const state=await storage(t);
 /** @type {string[]} */ const outputs=[];
 await new CoverageCache(state,()=>{}).save({sources:[],traces:[{groupId:'/w/A.cs',sourceIds:[],dependencies:['/w/A.cs'],coverage:[],reliable:false,timestamp:1,inputs:{}}],removedSources:[],removedTraces:[]});
 await assert.rejects(fs.access(path.join(state,'coverage-v3','outcomes')),'the old layout has no outcome records');
 const loaded=await restored(state,outputs);
 assert.deepEqual([...loaded.coverage.traces.keys()],['/w/A.cs']);assert.equal(loaded.outcomes.size,0);assert.equal(loaded.failing.has('/w/A.cs'),false);
 assert.deepEqual(outputs.filter(text=>/unavailable/.test(text)),[]);
 // A corrupt record is discarded on its own; valid outcomes and the coverage are kept.
 record(loaded,'/w/A.cs',{a1:'failed'});await loaded.save();
 const corrupt=path.join(state,'coverage-v3','outcomes',`${contentHash('/w/B.cs')}.json`);
 await fs.writeFile(corrupt,'{"groupId":"/w/B.cs","failed":[1]}');
 const again=await restored(state,outputs);
 assert.deepEqual(outcomes(again),{'/w/A.cs:a1':'failed'});assert.equal(again.coverage.traces.size,1);
 await assert.rejects(fs.access(corrupt));assert.ok(outputs.some(text=>/Discarding a corrupt coverage cache entry/.test(text)));
});

test('outcomes of tests and files that no longer exist are dropped and deleted from the cache',async t=>{
 const state=await storage(t),first=engine(state);
 const group=(/** @type {string} */ id,/** @type {string[]} */ ...tests)=>/** @type {any} */ ({id,file:id,project:'/w/Tests.csproj',framework:'net10.0',tests:tests.map(test=>({id:test,name:test,line:1}))}); // partial TestFile: no assembly or test identity
 first.groups=[group('/w/A.cs','a1','a2'),group('/w/B.cs','b1'),group('/w/C.cs','c1','c2')];
 record(first,'/w/A.cs',{a1:'failed',a2:'passed'});record(first,'/w/B.cs',{b1:'failed'});record(first,'/w/C.cs',{c1:'passed',c2:'failed'});
 await first.save();
 // A complete run of A reported only a2; rediscovery removed B and changed C's tests.
 first.lastOutcomes.settle('/w/A.cs',new Set(['a2']));
 await first.reconcileGroups([group('/w/A.cs','a2'),group('/w/C.cs','c1','c3')]);
 assert.deepEqual(outcomes(first),{'/w/A.cs:a2':'passed','/w/C.cs:c1':'passed'});
 assert.equal(first.failing.has('/w/A.cs'),false);assert.equal(first.failing.has('/w/C.cs'),false);
 await first.save();
 assert.equal(await saved(state,'/w/B.cs'),undefined,'a removed file loses its record');
 assert.deepEqual(outcomes(await restored(state)),{'/w/A.cs:a2':'passed','/w/C.cs:c1':'passed'});
 // Reset forgets every outcome, on disk too.
 const second=await restored(state);await second.reset();
 assert.equal(second.outcomes.size,0);assert.equal((await restored(state)).outcomes.size,0);
 assert.deepEqual(await fs.readdir(path.join(state,'coverage-v3','outcomes')),[]);
});

test('a failed save keeps changed outcomes pending for the next one',()=>{
 const tracker=new TestOutcomes();
 tracker.record('a',{id:'1',outcome:'failed'});tracker.record('b',{id:'2',outcome:'passed'});
 const delta=tracker.take();assert.deepEqual(tracker.take(),{saved:[],removed:[]});
 tracker.retain(new Set(['a']));tracker.retry(delta);
 assert.deepEqual(tracker.take(),{saved:[{groupId:'a',failed:['1']}],removed:['b']},'a retry writes current outcomes, including removals since');
 tracker.record('a',{id:'1',outcome:'failed'});assert.deepEqual(tracker.take(),{saved:[],removed:[]},'an unchanged outcome is not saved again');
 tracker.restore([{groupId:'a',passed:['1']},{groupId:'c',errored:['3']}]);
 assert.equal(tracker.byTest.get('a:1'),'failed','an outcome recorded this session is newer than a restored one');
 assert.equal(tracker.failing.has('c'),true);assert.deepEqual(tracker.take(),{saved:[],removed:[]});
});

test('the status bar shows the restored pass and fail counts after a reload',async t=>{
 const state=await storage(t),first=engine(state);
 record(first,'/workspace/A.cs',{a1:'passed',a2:'failed'});record(first,'/workspace/B.cs',{b1:'passed',b2:'skipped'});await first.save();
 const f=createTesty({api:{extensions:{getExtension:()=>undefined},Uri:{file:(/** @type {string} */ fsPath)=>({fsPath}),joinPath:()=>({})},Range:class{},TestTag:class{constructor(/** @type {string} */ id){this.id=id;}}},window:{showInformationMessage:async()=>undefined},
  tests:{createTestItem:(/** @type {string} */ id,/** @type {string} */ label,/** @type {unknown} */ uri)=>({id,label,uri,tags:[],children:{replace(){},add(){}}})}});t.after(()=>f.testy.dispose());
 const reloaded=f.testy.engine;
 // The reloaded window's engine reads the first window's storage.
 Object.assign(reloaded,{options:{...reloaded.options,storage:state},cache:new CoverageCache(state,()=>{})});
 f.testy.scheduler.request=()=>undefined;
 await f.testy.start();
 assert.equal(f.testy.tree.passed,2);assert.equal(f.testy.tree.failed,1);
 assert.match(f.testy.statusBar.text,/1 failed/);assert.match(f.testy.statusBar.tooltip,/2 passed · 1 failed/);
 assert.equal(f.testy.snapshot().outcomes['/workspace/B.cs:b2'],'skipped');
 // Discovery without B forgets its restored outcomes; a result replaces a restored one.
 const group={id:'/workspace/A.cs',file:'/workspace/A.cs',project:'/workspace/Tests.csproj',framework:'net10.0',tests:[{id:'a1',name:'a1',line:1},{id:'a2',name:'a2',line:2}]};
 reloaded.lastOutcomes.retain(new Set([group.id]));await f.testy.tree.update([group]);
 assert.equal(f.testy.tree.passed,1);assert.equal(f.testy.tree.failed,1);
 reloaded.lastOutcomes.record(group.id,{id:'a2',outcome:'passed'});f.testy.tree.publishResult(group,{id:'a2',name:'a2',outcome:'passed',duration:0});
 assert.equal(f.testy.tree.passed,2);assert.equal(f.testy.tree.failed,0);assert.match(f.testy.statusBar.text,/2 passed/);
});

test('impact runs schedule files that failed before a reload first',async t=>{
 const state=await storage(t),first=engine(state);
 record(first,'third',{t1:'failed'});record(first,'first',{f1:'passed'});await first.save();
 const reloaded=await restored(state);
 const p=(/** @type {string} */ file)=>normalizePath(path.resolve('/workspace',file));
 /** @type {any[]} */ const projects=[{file:p('App/App.csproj'),sourceFiles:[p('App/A.cs')],references:[]},{file:p('Tests/Tests.csproj'),sourceFiles:[],references:[p('App/App.csproj')]}]; // partial Projects: only the fields selection reads
 const index=new ProjectIndex(projects);
 reloaded.groups=['first','second','third'].map(id=>/** @type {any} */ ({id,file:p(`Tests/${id}.cs`),project:p('Tests/Tests.csproj'),framework:'net10.0',tests:[]})); // partial TestFiles: no assembly
 reloaded.projects=projects;reloaded.index=index;
 for(const group of reloaded.groups){reloaded.coverage.replace([{groupId:group.id,dependencies:[p('App/A.cs')],coverage:[],reliable:true,timestamp:1,inputs:{}}],new Set(reloaded.groups.map(item=>item.id)));}
 const run=/** @type {any} */ ({changes:[p('App/A.cs')],signal:new AbortController().signal,config:{mode:'affected'},previousIndex:index}); // partial RunContext: only the fields selectRun reads here
 const selected=await selectRun(reloaded,run,/** @type {any} */ ({before:new Map()}) /* partial BuildResult */,/** @type {any} */ ({currentShapes:new Map([[p('App/A.cs'),'shape']]),sessions:{}})); // partial PreparedTests: only what selection reads
 assert.deepEqual(selected.selection.groups.map(group=>group.id),['third','first','second']);
});
