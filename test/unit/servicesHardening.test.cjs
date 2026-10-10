const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {stableEnvironment,environmentIdentity}=require('../../out/core/environment');
const {isTestTarget}=require('../../out/core/model');
const {executeSelection}=require('../../out/services/engine/execute');
const {walkTree,Semaphore}=require('../../out/core/concurrency');
const {currentProcessStamp,isProcessAlive}=require('../../out/services/processStamp');
const {withLock,lockTiming}=require('../../out/services/lock');
const {claimRunOutputs,reclaimRunOutputs}=require('../../out/services/runOutputs');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');
const {findProjects,unsupportedTestReason,buildWaves}=require('../../out/services/projects');
const {PreparedOutputCache}=require('../../out/services/preparedOutputCache');
const outputTools=require('../../out/services/output');
const {requestTests,mtpTiming}=require('../../out/services/mtp');
const {TestEngine}=require('../../out/services/engine');

/** @param {import('node:test').TestContext} t @param {string} name */
async function temporary(t,name){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`testy-${name}-`)));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
const staleStamp=async()=>({...await currentProcessStamp(),boot:1});

test('launch-specific variables do not change environment identities',()=>{
 const base={PATH:'/bin',DOTNET_ROOT:'/dotnet',MSBuildSDKsPath:'/sdks'};
 const first=environmentIdentity({...base,VSCODE_PID:'1',VSCODE_IPC_HOOK:'/a',SHLVL:'2',ELECTRON_RUN_AS_NODE:'1',TERM_SESSION_ID:'x',_:'/bin/code'});
 const second=environmentIdentity({...base,VSCODE_PID:'2',SHLVL:'3',OLDPWD:'/tmp'});
 assert.deepEqual(first,second);
 assert.notDeepEqual(environmentIdentity({...base,DOTNET_ROOT:'/other'}),first,'variables MSBuild can read still matter');
 const stable=stableEnvironment({...base,VSCODE_PID:'1'});
 assert.equal(stable.VSCODE_PID,undefined);assert.equal(stable.PATH,'/bin');
});

test('process stamps distinguish a live owner from a reused PID',async()=>{
 const stamp=await currentProcessStamp();
 assert.equal(await isProcessAlive(process.pid,stamp),true);
 assert.equal(await isProcessAlive(process.pid,await staleStamp()),false,'a marker from another boot is dead even if the PID is alive');
 assert.equal(await isProcessAlive(process.pid),true,'legacy markers fall back to the PID');
 if(stamp.start!==undefined){assert.equal(await isProcessAlive(process.pid,{...stamp,start:'0'}),false,'a different start time is a different process');}
});

test('locks held by a reused PID or by an unverifiable holder with a stopped heartbeat are recovered',async t=>{
 const root=await temporary(t,'lock'),lock=path.join(root,'state.lock');
 await fs.mkdir(lock);await fs.writeFile(path.join(lock,`${process.pid}-${randomUUID()}`),JSON.stringify(await staleStamp()));
 assert.equal(await withLock(lock,undefined,async()=>'reused PID recovered'),'reused PID recovered');
 await fs.mkdir(lock);const owner=path.join(lock,`${process.pid}-${randomUUID()}`);
 // Without a start time a reused PID looks identical to the holder, so only the heartbeat can say it is gone.
 const {start:_start,...unverifiable}=await currentProcessStamp();
 await fs.writeFile(owner,JSON.stringify(unverifiable));
 const old=new Date(Date.now()-lockTiming.staleMs-1000);await fs.utimes(owner,old,old);
 assert.equal(await withLock(lock,undefined,async()=>'stale heartbeat recovered'),'stale heartbeat recovered');
});

test('a held lock keeps its heartbeat fresh and blocks contenders until released',async t=>{
 const root=await temporary(t,'lock-held'),lock=path.join(root,'state.lock');
 const original={...lockTiming};lockTiming.heartbeatMs=20;lockTiming.staleMs=150;
 t.after(()=>Object.assign(lockTiming,original));
 let release;const held=new Promise(resolve=>release=resolve);
 /** @type {string[]} */ const order=[];
 const holder=withLock(lock,undefined,async()=>{order.push('holder');await held;order.push('holder done');});
 await delay(30);
 const contender=withLock(lock,undefined,async()=>{order.push('contender');});
 await delay(400);
 assert.deepEqual(order,['holder'],'a refreshed heartbeat is never treated as stale');
 /** @type {() => void} */ (/** @type {unknown} */ (release))(); // assigned by the promise executor above
 await Promise.all([holder,contender]);
 assert.deepEqual(order,['holder','holder done','contender']);
});

test('run outputs owned by a reused PID are reclaimed; live owners are kept',async t=>{
 const root=await temporary(t,'run-outputs'),storage=path.join(root,'runs');
 const live=await claimRunOutputs(storage);
 const dead=randomUUID();await fs.mkdir(path.join(storage,dead));
 await fs.writeFile(path.join(storage,`${dead}.owner.json`),JSON.stringify({identity:dead,pid:process.pid,process:await staleStamp()}));
 await reclaimRunOutputs(storage);
 const names=await fs.readdir(storage);
 assert.ok(!names.includes(dead),'stale output removed');assert.ok(names.includes(path.basename(live.directory)),'live output kept');
 await live.dispose();
});

test('an active prepared-storage owner from another boot is discarded',async t=>{
 const root=await temporary(t,'prepared-storage'),storage=path.join(root,'prepared');
 const identity=randomUUID();await fs.mkdir(path.join(storage,identity),{recursive:true});
 await fs.writeFile(path.join(storage,`${identity}.owner.json`),JSON.stringify({version:1,identity,token:randomUUID(),pid:process.pid,process:await staleStamp(),state:'active'}));
 const lease=await claimPreparedStorage(storage);
 assert.notEqual(path.basename(lease.directory),identity);
 assert.ok(!(await fs.readdir(storage)).includes(identity),'crashed owner output was removed');
 await lease.dispose();
});

test('project discovery skips unreadable directories but not unreadable roots',{skip:process.platform==='win32'||process.getuid?.()===0},async t=>{
 const root=await temporary(t,'find-projects');
 await fs.mkdir(path.join(root,'App'));await fs.writeFile(path.join(root,'App','App.csproj'),'<Project/>');
 const locked=path.join(root,'pgdata');await fs.mkdir(locked);await fs.chmod(locked,0);
 t.after(()=>fs.chmod(locked,0o700).catch(()=>undefined));
 /** @type {string[]} */ const skipped=[];
 const projects=await findProjects([root],undefined,undefined,4,directory=>skipped.push(directory));
 assert.deepEqual(projects.map(file=>path.basename(file)),['App.csproj']);assert.deepEqual(skipped,[locked]);
 await assert.rejects(findProjects([locked]),{code:'EACCES'});
});

test('unsupported test projects are reasons, not failures, and are never test targets',()=>{
 // A partial Project: isTestTarget and unsupportedTestReason read only these fields.
 const base=/** @type {import('../../out/core/model').Project} */ (/** @type {unknown} */ ({file:'/w/Legacy.csproj',framework:'net8.0',isTestProject:true}));
 assert.match(/** @type {string} */ (unsupportedTestReason({...base,isMtp:true})),/net8\.0.*\.NET 10/);
 assert.match(/** @type {string} */ (unsupportedTestReason({...base,framework:'net10.0',isMtp:false})),/VSTest/);
 assert.equal(unsupportedTestReason({...base,framework:'net10.0',isMtp:true}),undefined);
 assert.equal(unsupportedTestReason({...base,isTestProject:false}),undefined);
 assert.equal(isTestTarget({...base,unsupported:'old'}),false);
 assert.equal(isTestTarget({...base,framework:'net10.0'}),true);
 assert.equal(isTestTarget({...base,framework:'net10.0',entryPoint:false}),false);
});

test('build waves scale with roots and still order output and binary conflicts',()=>{
 /** @param {string} name @param {Partial<import('../../out/core/model').Project>} [extra] @returns {import('../../out/core/model').Project} */
 const project=(name,extra={})=>({file:`/w/${name}/${name}.csproj`,framework:'net10.0',assembly:`/w/${name}/bin/${name}.dll`,isTestProject:true,runner:'mtp',
  sourceFiles:[],references:[],entryPoint:true,outputDirectories:[`/w/${name}/bin`,`/w/${name}/obj`],...extra});
 const roots=Array.from({length:600},(_,index)=>project(`P${index}`));
 const started=performance.now(),waves=buildWaves(roots,roots);
 assert.equal(waves.length,1);assert.ok(performance.now()-started<20_000,'independent roots plan quickly');
 const shared=project('Shared',{outputDirectories:['/w/out']}),a=project('A',{outputDirectories:['/w/out/a']}),consumer=project('C',{binaryReferences:['/w/Shared/bin/Shared.dll']});
 const ordered=buildWaves([shared,a,consumer],[shared,a,consumer]);
 assert.deepEqual(ordered.map(wave=>wave.map(item=>path.basename(item.file))),[['Shared.csproj'],['A.csproj','C.csproj']]);
});

test('tree walks propagate the first failure after draining admitted visits',async()=>{
 let active=0,peak=0;
 const visit=async(/** @type {number} */ depth)=>{active++;peak=Math.max(peak,active);await delay(1);active--;if(depth===3){throw new Error('visit failure');}return depth<3?[depth+1,depth+1]:[];};
 await assert.rejects(walkTree([0],visit,new Semaphore(2)),/visit failure/);
 assert.equal(active,0);assert.ok(peak<=2);
});

test('a stale cache slot that cannot be removed falls back to an uncached preparation',async t=>{
 const root=await temporary(t,'prepared-slot'),source=path.join(root,'build');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'binary');
 /** @type {string[]} */ const messages=[];
 const cache=new PreparedOutputCache(path.join(root,'storage'),randomUUID(),{log:message=>messages.push(message)});
 const create=async(/** @type {string} */ directory)=>{
  const template=path.join(directory,'template'),output=new outputTools.PreparedOutput(template,path.join(directory,'assembly'));
  await outputTools.copyOutput(source,template);await output.initialize();
  return{root:directory,output,session:randomUUID(),coverage:true,instrumented:[],reusable:true};
 };
 const first=await cache.acquire(source,'first',create,undefined,'slot');await /** @type {NonNullable<typeof first>} */ (first).release();
 const remove=outputTools.removeOutput;
 outputTools.removeOutput=async directory=>{if(directory===/** @type {NonNullable<typeof first>} */ (first).artifact.root){throw Object.assign(new Error('EBUSY: locked'),{code:'EBUSY'});}return remove(directory);};
 t.after(()=>{outputTools.removeOutput=remove;});
 assert.equal(await cache.acquire(source,'second',create,undefined,'slot'),undefined,'callers prepare outside the cache instead of failing');
 assert.ok(messages.some(message=>/could not be removed/.test(message)));
 outputTools.removeOutput=remove;await cache.dispose();
});

const peer=path.resolve('test/fixtures/mtp-edge-peer.cjs');
test('a host that does not exit after its results is stopped and its results are kept',async t=>{
 const original={...mtpTiming};mtpTiming.exitGraceMs=200;t.after(()=>Object.assign(mtpTiming,original));
 /** @type {string[]} */ const output=[];
 const nodes=await requestTests({dotnet:process.execPath,assembly:peer,cwd:process.cwd(),timeoutMs:20000,output:text=>output.push(text),
  env:{TESTY_LINGER:'1',TESTY_UPDATES:JSON.stringify([{uid:'row','execution-state':'passed'}])}},'run');
 assert.deepEqual(nodes.map(node=>node.uid),['row']);
 assert.ok(output.some(text=>/did not exit/.test(text)));
});

test('a second connection to the test port discards the run',async()=>{
 await assert.rejects(requestTests({dotnet:process.execPath,assembly:peer,cwd:process.cwd(),timeoutMs:10000,
  env:{TESTY_EXTRA_CONNECTION:'1',TESTY_UPDATES:JSON.stringify([{uid:'row','execution-state':'passed'}])}},'run'),/Another local process connected/);
});

test('shared SDK checks are not cancelled by the first caller',{skip:process.platform==='win32'},async t=>{
 const root=await temporary(t,'sdk-check'),dotnet=path.join(root,'dotnet');
 await fs.writeFile(dotnet,'#!/bin/sh\nsleep 0.3\necho 10.0.100\n');await fs.chmod(dotnet,0o755);
 const engine=new TestEngine({roots:[root],storage:path.join(root,'state'),tools:root,analyzer:'',events:/** @type {any} */ ({output(){}}),configuration:/** @type {any} */ (()=>({}))}); // partial mocks: these tests never reach the other events or settings
 const first=new AbortController(),options={cwd:root,signal:first.signal};
 const cancelled=engine.sdk.ensure(dotnet,options,'context'),shared=engine.sdk.ensure(dotnet,{cwd:root,signal:new AbortController().signal},'context');
 first.abort();
 await assert.rejects(cancelled,{name:'AbortError'});await shared;
 assert.ok(/** @type {any} */ (engine.sdk).contexts.has(`${dotnet}\0context`));
});

test('a failed test batch reports its tests as errored while other batches continue',async t=>{
 const root=await temporary(t,'batch-failure');
 /** @type {{group: string, id: string, outcome: string}[]} */ const events=[];
 /** @type {string[]} */ const outputs=[];
 const engine=new TestEngine({roots:[root],storage:path.join(root,'state'),tools:root,analyzer:'',configuration:/** @type {any} */ (()=>({})),events:{
  output:text=>outputs.push(text),phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},
  result:(group,result)=>events.push({group:group.id,id:result.id,outcome:result.outcome})}});
 /** @param {string} name @param {string[]} tests @returns {import('../../out/core/model').TestFile} */
 const group=(name,tests)=>({id:`file:${name}`,project:'/w/T.csproj',framework:'net10.0',assembly:'/w/T.dll',file:`/w/${name}.cs`,
  tests:tests.map(id=>({id,name:id,fullyQualifiedName:id,line:1,node:{uid:id}}))});
 const broken=group('Broken',['b1','b2']),healthy=group('Healthy',['h1']);
 engine.groups=[broken,healthy];
 /** @type {any} Partial RunnerSession: only the members executeSelection calls. */
 const sessions={canRunParallel:()=>false,run:async(/** @type {import('../../out/core/model').TestFile[]} */ groups)=>{
  if(groups[0].id===broken.id){engine.resultObservers.forEach(observe=>observe(broken,/** @type {any} */ ({id:'b1',outcome:'failed'})));throw new Error('group fixture failed');}
  return{results:[{id:'h1',name:'h1',fullyQualifiedName:'h1',outcome:'passed',duration:1}],coverageAvailable:false,executedGroups:groups,
   trace:{groupId:healthy.id,dependencies:[],coverage:[],reliable:false,timestamp:Date.now(),inputs:{}}};
 }};
 const controller=new AbortController();
 /** @type {any} Partial RunContext: only the fields executeSelection reads. */
 const run={controller,signal:controller.signal,config:{mode:'affected'},configured:{coverage:true},manualOperation:false,changes:[],testLimit:2,topology:engine.topology};
 const tested=await executeSelection(engine,run,/** @type {any} */ ({before:new Map(),revision:engine.sources.revision,obsoleteBuild:false}),
  /** @type {any} */ ({coverageTool:'collector',sessions,liveIds:new Set([broken.id,healthy.id]),runtimeTreeChanged:false}),/** @type {any} */ ({selection:{groups:[broken,healthy]}}));
 assert.equal(tested.failedBatches,1);
 assert.deepEqual(tested.results.map(result=>[result.id,result.outcome]).sort(),[['b2','errored'],['h1','passed']]);
 assert.deepEqual(events,[{group:broken.id,id:'b2',outcome:'errored'}],'only tests without an earlier result are filled in');
 assert.ok(outputs.some(text=>/Test batch failed for Broken\.cs: group fixture failed/.test(text)));
 assert.equal(controller.signal.aborted,false);
 assert.equal(engine.coverage.traces.get(broken.id)?.reliable,false,'the failed file keeps a conservative trace');
});
