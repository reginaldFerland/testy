const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {TestEngine}=require('../../out/services/engine');
const {executeSelection,CoveragePublisher}=require('../../out/services/engine/execute');
const {SerialQueue}=require('../../out/core/concurrency');
const {evaluationToolContext}=require('../../out/services/projectEvaluationCache');
const {hashMemoTiming}=require('../../out/services/hashMemo');
const {normalizePath}=require('../../out/core/paths');

/** @param {import('node:test').TestContext} t */
async function workspace(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-commits-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=(/** @type {string} */ name)=>normalizePath(path.join(root,name));
 for(const name of ['A.cs','B.cs','Shared.cs'])await fs.writeFile(file(name),`class ${name.slice(0,-3)} {}`);
 /** @type {string[]} */ const outputs=[];
 const engine=new TestEngine({roots:[root],storage:path.join(root,'state'),tools:root,analyzer:'',configuration:/** @type {any} */ (()=>({})),events:{
  output:text=>outputs.push(text),phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},result(){}}});
 engine.sources.setFiles([file('A.cs'),file('B.cs'),file('Shared.cs')]);await engine.sources.refresh(engine.sources.files);
 /** @type {string[][]} */ const refreshed=[];const refresh=engine.sources.refresh.bind(engine.sources);
 engine.sources.refresh=async(files,signal)=>{refreshed.push([...files].sort());return refresh(files,signal);};
 /** @param {string} name @returns {import('../../out/core/model').TestFile} */
 const group=name=>({id:`file:${name}`,project:'/w/T.csproj',framework:'net10.0',assembly:'/w/T.dll',file:file(`${name}.cs`),tests:[{id:name,name,fullyQualifiedName:name,line:1,node:{uid:name}}]});
 return{root,file,engine,outputs,refreshed,group};
}

/** Runs each group after `before`, sequentially, with a trace depending on its own file and Shared.cs.
 * @param {Awaited<ReturnType<typeof workspace>>} f @param {import('../../out/core/model').TestFile[]} groups @param {(group: import('../../out/core/model').TestFile) => Promise<void>} [before] */
function execute(f,groups,before=async()=>{}){
 const engine=f.engine,hashes=engine.hashes;
 /** @type {any} Partial RunnerSession: only the members executeSelection calls. */
 const sessions={canRunParallel:()=>false,run:async(/** @type {import('../../out/core/model').TestFile[]} */ batch)=>{
  await before(batch[0]);
  const dependencies=[/** @type {string} */ (batch[0].file),f.file('Shared.cs')];
  return{results:[{id:batch[0].tests[0].id,name:'t',fullyQualifiedName:'t',outcome:'passed',duration:1}],coverageAvailable:true,executedGroups:batch,
   trace:{groupId:batch[0].id,dependencies,coverage:[],reliable:true,timestamp:Date.now(),inputs:Object.fromEntries(dependencies.map(file=>[file,hashes.get(file)]))}};
 }};
 engine.groups=groups;
 const controller=new AbortController();
 /** @type {any} Partial RunContext: only the fields executeSelection reads. */
 const run={controller,signal:controller.signal,config:{mode:'affected',configuration:'Debug'},configured:{coverage:true,configuration:'Debug'},manualOperation:true,changes:[],testLimit:1,topology:engine.topology};
 return executeSelection(engine,run,/** @type {any} */ ({before:new Map(hashes),revision:engine.sources.revision,obsoleteBuild:false}),
  /** @type {any} */ ({coverageTool:'collector',sessions,liveIds:new Set(groups.map(group=>group.id)),runtimeTreeChanged:false}),/** @type {any} */ ({selection:{groups}}));
}

test('commits reread only the dependencies no earlier commit of the run has checked',async t=>{
 const f=await workspace(t),a=f.group('A'),b=f.group('B');
 await execute(f,[a,b]);
 assert.deepEqual(f.refreshed,[[f.file('A.cs'),f.file('Shared.cs')],[f.file('B.cs')]],'Shared.cs is checked once per run, not once per commit');
 assert.equal(f.engine.coverage.traces.get(b.id)?.stale,false);
});

test('an input changed since the build is still detected before its first commit',async t=>{
 const f=await workspace(t),a=f.group('A'),b=f.group('B');
 await execute(f,[a,b],async group=>{if(group.id===b.id)await fs.writeFile(f.file('B.cs'),'class B { int changed; }');});
 assert.ok(f.engine.coverage.traces.has(a.id));
 assert.equal(f.engine.coverage.traces.has(b.id),false,'the run of the old B.cs is not committed');
});

test('baseline coverage publication is throttled, with a trailing and a final publication',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const queue=new SerialQueue(),signals=/** @type {(AbortSignal | undefined)[]} */ ([]),controller=new AbortController();
 const publisher=new CoveragePublisher(async(/** @type {AbortSignal | undefined} */ signal)=>{signals.push(signal);},controller.signal,250,queue);
 await publisher.publish();
 assert.equal(signals.length,1,'the first contribution is published at once');
 await publisher.publish();await publisher.publish();
 assert.equal(signals.length,1,'later contributions within the interval wait');
 t.mock.timers.tick(250);await queue.run(async()=>undefined);
 assert.equal(signals.length,2,'one trailing publication shows the latest contribution');
 assert.equal(signals[1],controller.signal);
 await publisher.publish();assert.equal(signals.length,2);
 await publisher.flush();
 assert.equal(signals.length,3,'a run ending early publishes what it committed');
 assert.equal(signals[2],undefined,'even after the run signal aborted');
 t.mock.timers.tick(1000);await queue.run(async()=>undefined);
 assert.equal(signals.length,3,'the flushed trailing publication does not run again');
 const every=new CoveragePublisher(async()=>{signals.push(undefined);},controller.signal,0,queue);
 await every.publish();await every.publish();
 assert.equal(signals.length,5,'other runs publish every contribution');
});

test('evaluation tool hashes are reused from the shared map until the host changes',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-tool-identities-')));
 const racy=hashMemoTiming.racyMs;hashMemoTiming.racyMs=-1;
 t.after(async()=>{hashMemoTiming.racyMs=racy;await fs.rm(root,{recursive:true,force:true});});
 const directory=path.join(root,'dotnet'),host=path.join(directory,process.platform==='win32'?'dotnet.exe':'dotnet'),analyzer=path.join(root,'Testy.Analysis.dll');
 await fs.mkdir(path.join(directory,'sdk'),{recursive:true});await fs.mkdir(path.join(directory,'host','fxr'),{recursive:true});
 // Native identity fixtures only: these bytes are never executed.
 await fs.writeFile(host,Buffer.from('7f454c460001','hex'),{mode:0o755});await fs.writeFile(analyzer,'analyzer');
 const read=fs.readFile,/** @type {string[]} */ reads=[];
 /** @type {any} */ (fs).readFile=async(/** @type {any} */ file,/** @type {any[]} */ ...args)=>{reads.push(String(file));return /** @type {any} */ (read)(file,...args);}; // deliberately wraps the overloaded fs.readFile
 t.after(()=>{/** @type {any} */ (fs).readFile=read;});
 const identities=new Map(),first=await evaluationToolContext(host,analyzer,[root],undefined,identities);
 assert.ok(first);const hashed=reads.length;assert.ok(hashed>=2);
 assert.deepEqual(await evaluationToolContext(host,analyzer,[root],undefined,identities),first);
 assert.equal(reads.length,hashed,'unchanged tools are not read again');
 await fs.writeFile(host,Buffer.from('7f454c46000102','hex'));
 const second=await evaluationToolContext(host,analyzer,[root],undefined,identities);
 assert.notEqual(second?.key,first.key,'a replaced host is hashed again');
});
