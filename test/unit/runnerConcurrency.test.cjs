const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {createRequire}=require('node:module'),{setTimeout:delay}=require('node:timers/promises');
const {normalizePath}=require('../../out/core/paths');

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function until(promise,signal){
 signal?.throwIfAborted();let abort;
 try{return await Promise.race([promise,new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});})]);}
 finally{signal?.removeEventListener('abort',abort);}
}

async function fixture(t,config={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-runner-lanes-')));
 const source=path.join(root,'build'),workspace=path.join(root,'workspace');
 await fs.mkdir(source);await fs.mkdir(workspace);
 await fs.writeFile(path.join(source,'Tests.dll'),'assembly');await fs.writeFile(path.join(source,'asset'),'pristine');
 const definitions=config.definitions??[{token:'a',file:'A.cs',name:'A'},{token:'b',file:'B.cs',name:'B'}];
 const project={file:path.join(workspace,'Tests.csproj'),framework:'net10.0',assembly:path.join(source,'Tests.dll'),
  sourceFiles:[...new Set(definitions.map(node=>normalizePath(path.join(workspace,node.file))))]};
 const state={discoveries:[],runs:[],instruments:[],prepared:0,claims:0,active:0,peak:0,activeAssemblies:new Set(),
  primaryStarted:deferred(),secondaryStarted:deferred(),release:deferred(),fallback:deferred(),reports:new Map()};
 const control=new AbortController(),file=path.resolve('out/services/runner.js'),realRequire=createRequire(file),exports={};
 const mtp=realRequire('./mtp'),output=realRequire('./output'),processTools=realRequire('./process'),ownership=realRequire('./runOutputs'),cacheTools=realRequire('./preparedOutputCache');
 const nodesFor=(assembly,bytes)=>definitions.map(node=>({uid:(config.stableIds?node.token:`${path.dirname(assembly)}:${node.token}`)+(config.idsFromBytes?`:${bytes}`:''),'display-name':node.name,
  'location.file':path.join(workspace,node.file),'location.type':node.type??node.name,'location.method':node.method??'Run'}));
 const requestTests=async(options,operation,selected)=>{
  const secondary=options.assembly.includes(`${path.sep}lanes${path.sep}`);
  const bytes=await fs.readFile(options.assembly,'utf8');let nodes=nodesFor(options.assembly,bytes);
  if(operation==='discover'){
   state.discoveries.push({assembly:options.assembly,secondary,env:options.env});
   if(config.failDiscover?.(secondary,state.discoveries.length))throw new Error('controlled discovery failure');
   if(secondary&&config.secondaryNodes)nodes=config.secondaryNodes(nodes);
   if(config.mutateDiscovery)await fs.writeFile(path.join(path.dirname(options.assembly),'asset'),'discovery mutation');
   return nodes;
  }
  const requested=selected??options.expectedTests;
  assert.ok(requested.every(node=>nodes.some(candidate=>candidate.uid===node.uid)),'only lane-native UIDs may reach MTP');
  const call={assembly:options.assembly,secondary,ids:requested.map(node=>node.uid),wrapper:options.wrapper,bytes,env:options.env};
  state.runs.push(call);state.active++;state.peak=Math.max(state.peak,state.active);state.activeAssemblies.add(options.assembly);
  (secondary?state.secondaryStarted:state.primaryStarted).resolve();
  try{
   assert.equal(await fs.readFile(path.join(path.dirname(options.assembly),'asset'),'utf8'),'pristine','restore each reusable lane before executing it');
   await fs.writeFile(path.join(path.dirname(options.assembly),'asset'),requested[0].uid);
   if(config.holdAll||(!secondary&&config.holdPrimary&&state.runs.filter(item=>!item.secondary).length===1))await until(state.release.promise,options.signal);
   await delay(config.runDelay??5,undefined,{signal:options.signal});
   if(config.failRun?.(call,state.runs.length))throw new Error('controlled execution failure');
   assert.equal(await fs.readFile(path.join(path.dirname(options.assembly),'asset'),'utf8'),requested[0].uid,'another lane must not restore this run output');
   const results=requested.map(node=>({...node,'execution-state':'passed'}));
   if(options.wrapper){const report=options.wrapper.args.at(-1);state.reports.set(report,[...new Set(requested.map(node=>node['location.file']))]);}
   for(const node of results)options.onNode?.(node);
   return results;
  }finally{state.active--;state.activeAssemblies.delete(options.assembly);}
 };
 const modules={
  './mtp':{...mtp,requestTests},
  './process':{...processTools,runProcess:async(_command,args,options)=>{
   assert.equal(args[0],'instrument');state.instruments.push({assembly:args[1],session:args[3],env:options.env});
   await config.instrument?.(args,state,control.signal);
   await fs.appendFile(args[1],args[3]);return{code:0,stdout:'',stderr:''};
  }},
  './preparedOutputCache':{...cacheTools,preparationToolIdentity:async command=>command},
  './output':{...output,removeOutput:async directory=>{
   for(const assembly of state.activeAssemblies)assert.equal(assembly.startsWith(directory+path.sep),false,'cleanup must await the owning run');
   return output.removeOutput(directory);
  }},
  './runOutputs':{...ownership,claimRunOutputs:async(...args)=>{state.claims++;await delay(5);return ownership.claimRunOutputs(...args);}},
  './coverageReader':{CoverageReader:class{async read(report,_cwd,hashes){return(state.reports.get(report)??[]).map(normalizePath).map(file=>({file,hash:hashes.get(file),lines:[{line:1,hits:1}]}));}async dispose(){}}},
  './runtimeObservation':{RuntimeObservation:class{static async start(_directory,_assembly,_modules,_instrumented,env){return{env,dependencies:async()=>({files:[],projects:[]})};}}}
 };
 vm.runInNewContext(await fs.readFile(file,'utf8'),{exports,process,require:name=>modules[name]??realRequire(name)});
 const emitted=[],sessions=[],cache=config.cache?new cacheTools.PreparedOutputCache(path.join(root,'cache'),randomUUID()):undefined;
 const createSession=(overrides={})=>{const session=new exports.RunnerSession({dotnet:'dotnet',storage:path.join(root,'runs'),testArguments:[],signal:control.signal,
  coverageTool:config.coverage?'collector':undefined,managedCoverageTool:config.managedCoverageTool,env:config.env,assemblies:[project.assembly],onPrepared:()=>state.prepared++,
  deferCoverage:config.deferCoverage,preparedOutputCache:cache,onResult:(group,result)=>emitted.push({group,result}),
  output:message=>{if(message.includes('primary runner'))state.fallback.resolve();},...overrides});sessions.push(session);return session;};
 const session=createSession();
 t.after(async()=>{state.release.resolve();for(const runner of sessions)await runner.dispose().catch(error=>{if(!config.expectDisposeFailure)throw error;});await cache?.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,source,project,state,session,createSession,cache,control,emitted,hashes:new Map(project.sourceFiles.map(file=>[file,'v1']))};
}

test('concurrent target discovery claims one lease and prepares each target once',async t=>{
 const f=await fixture(t),other={...f.project,file:path.join(path.dirname(f.project.file),'Other.csproj')};
 const [first,again]=await Promise.all([f.session.discover(f.project),f.session.discover(f.project),f.session.discover(other)]);
 assert.equal(first,again);assert.equal(f.state.claims,1);assert.equal(f.state.discoveries.length,2);assert.equal(f.state.prepared,2);
});

test('managed collector ignores only controlled editor variables in cache identity and preserves discovery and test environments',async t=>{
 const firstEnv={SHLVL:'2',VSCODE_PID:'1001',TESTY_COLLECTOR_OPTION:'original'};
 const f=await fixture(t,{coverage:true,cache:true,managedCoverageTool:true,env:firstEnv});
 const groups=await f.session.discover(f.project);await f.session.run([groups[0]],f.hashes);await f.session.dispose();
 assert.equal(f.state.instruments.length,1);
 for(const key of ['SHLVL','VSCODE_PID'])assert.equal(f.state.instruments[0].env[key],undefined,'instrumentation receives the same controlled environment used by its fingerprint');
 assert.equal(f.state.instruments[0].env.TESTY_COLLECTOR_OPTION,'original');
 for(const call of [f.state.discoveries[0],f.state.runs[0]])for(const key of Object.keys(firstEnv))assert.equal(call.env[key],firstEnv[key]);
 const nextEnv={...firstEnv,SHLVL:'5',VSCODE_PID:'2002'},next=f.createSession({env:nextEnv});
 const fresh=await next.discover(f.project);await next.run([fresh[0]],f.hashes);await next.dispose();
 assert.equal(f.state.instruments.length,1,'the pinned collector reuses its artifact across editor/shell identity changes');
 for(const call of [f.state.discoveries[1],f.state.runs[1]])for(const key of Object.keys(nextEnv))assert.equal(call.env[key],nextEnv[key]);
 const changed=f.createSession({env:{...nextEnv,TESTY_COLLECTOR_OPTION:'changed'}});await changed.discover(f.project);
 assert.equal(f.state.instruments.length,2,'other managed-collector environment changes still invalidate');
 assert.equal(f.state.instruments[1].env.TESTY_COLLECTOR_OPTION,'changed');
});

test('custom collector retains every environment variable and invalidates on editor or arbitrary environment changes',async t=>{
 const initial={SHLVL:'2',VSCODE_PID:'1001',TESTY_COLLECTOR_OPTION:'original'};
 const f=await fixture(t,{coverage:true,cache:true,env:initial});
 await f.session.discover(f.project);await f.session.dispose();assert.equal(f.state.instruments[0].env,initial);
 let previous=initial;
 for(const update of [{SHLVL:'3'},{VSCODE_PID:'2002'},{TESTY_COLLECTOR_OPTION:'changed'}]){
  const env={...previous,...update},session=f.createSession({env}),before=f.state.instruments.length;
  const groups=await session.discover(f.project);await session.run([groups[0]],f.hashes);await session.dispose();
  assert.equal(f.state.instruments.length,before+1,'all custom collector inputs remain part of the fingerprint');
  assert.equal(f.state.instruments.at(-1).env,env,'custom instrumentation receives the untouched caller environment');
  assert.equal(f.state.discoveries.at(-1).env,env);assert.equal(f.state.runs.at(-1).env,env);previous=env;
 }
 const warm=f.createSession({env:previous});await warm.discover(f.project);assert.equal(f.state.instruments.length,4,'unchanged custom inputs still reuse');
});

test('deferred targets discover without instrumentation and only selected targets upgrade with fresh native IDs',async t=>{
 const f=await fixture(t,{coverage:true,deferCoverage:()=>true,idsFromBytes:true,mutateDiscovery:true});
 const other={...f.project,file:path.join(path.dirname(f.project.file),'Other.csproj')};
 const [groups]=await Promise.all([f.session.discover(f.project),f.session.discover(other)]);
 assert.equal(f.state.instruments.length,0);assert.equal(f.state.discoveries.length,2);
 const result=await f.session.run([groups[0]],f.hashes);
 assert.equal(f.state.instruments.length,1);assert.equal(f.state.discoveries.length,3);
 assert.ok(f.state.discoveries.slice(0,2).some(item=>item.assembly===f.state.runs[0].assembly));
 assert.equal(f.state.runs[0].assembly,f.state.discoveries[2].assembly);
 assert.notEqual(f.state.runs[0].ids[0],groups[0].tests[0].id,'rewritten binary IDs were refreshed before execution');
 assert.deepEqual(Array.from(result.results,item=>item.id),Array.from(groups[0].tests,item=>item.id),'public result identity is retained');
 assert.equal(result.trace.reliable,true);assert.ok(f.state.runs[0].wrapper);
 await f.session.run([groups[1]],f.hashes);assert.equal(f.state.instruments.length,1);assert.equal(f.state.discoveries.length,3);
});

test('deferred selection rejects an exclusion when instrumentation changes opaque native IDs',async t=>{
 const f=await fixture(t,{coverage:true,deferCoverage:()=>true,idsFromBytes:true,definitions:[{token:'a',file:'A.cs',name:'A'},{token:'b',file:'A.cs',name:'B'}]});
 const groups=await f.session.discover(f.project);
 await assert.rejects(f.session.run([{...groups[0],excludedTestIds:[groups[0].tests[1].id]}],f.hashes),/cannot honor an exclusion/);
 assert.equal(f.state.runs.length,0);
});

test('discovery-only cache entries upgrade on eager acquisition and remain reusable by later deferred runs',async t=>{
 const f=await fixture(t,{coverage:true,cache:true,deferCoverage:()=>true});
 const first=await f.session.discover(f.project);await f.session.dispose();
 const deferred=f.createSession();await deferred.discover(f.project);await deferred.dispose();
 assert.equal(f.state.instruments.length,0);assert.equal(f.state.discoveries.length,2);
 const eager=f.createSession({deferCoverage:undefined}),groups=await eager.discover(f.project);
 assert.equal(f.state.instruments.length,1);assert.equal(f.state.discoveries.length,3,'eager upgrade discovers only once');
 await eager.run([groups[0]],f.hashes);await eager.dispose();
 const warm=f.createSession(),again=await warm.discover(f.project);await warm.run([again[0]],f.hashes);await warm.dispose();
 assert.equal(f.state.instruments.length,1);assert.equal(f.state.discoveries.length,4,'instrumented cache hit requires only fresh discovery');
 assert.equal(new Set(f.state.discoveries.map(item=>item.assembly)).size,1);
 assert.deepEqual(Array.from(again[0].tests,item=>item.id),Array.from(first[0].tests,item=>item.id));
});

test('selected deferred cache entries retain their upgraded template and repair test mutations',async t=>{
 const f=await fixture(t,{coverage:true,cache:true,deferCoverage:()=>true}),groups=await f.session.discover(f.project);
 await f.session.run([groups[0]],f.hashes);await f.session.dispose();
 const next=f.createSession(),fresh=await next.discover(f.project);await next.run([fresh[1]],f.hashes);
 assert.equal(f.state.instruments.length,1);assert.equal(f.state.discoveries.length,3);
 assert.equal(f.state.runs[0].bytes,f.state.runs[1].bytes);assert.ok(f.state.runs.every(run=>run.wrapper));
});

test('failed deferred instrumentation executes a clean uninstrumented copy and discards the artifact',async t=>{
 const f=await fixture(t,{coverage:true,cache:true,deferCoverage:()=>true,instrument:async(args,state)=>{
  if(state.instruments.length===1){await fs.appendFile(args[1],'partial instrumentation');throw new Error('controlled instrumentation failure');}
 }}),groups=await f.session.discover(f.project);
 const result=await f.session.run([groups[0]],f.hashes);await f.session.dispose();
 assert.equal(result.coverageAvailable,false);assert.equal(f.state.runs[0].wrapper,undefined);assert.equal(f.state.runs[0].bytes,'assembly');
 const next=f.createSession({deferCoverage:undefined}),fresh=await next.discover(f.project);await next.run([fresh[0]],f.hashes);
 assert.equal(f.state.instruments.length,2);assert.ok(f.state.runs[1].wrapper);
});

test('cancelled deferred upgrade drains and removes its partially instrumented cache entry',async t=>{
 const entered=deferred(),finish=deferred();
 const f=await fixture(t,{coverage:true,cache:true,deferCoverage:()=>true,instrument:async(args,_state,signal)=>{
  await fs.appendFile(args[1],'partial instrumentation');entered.resolve();await until(finish.promise,signal);
 }}),groups=await f.session.discover(f.project);
 const run=f.session.run([groups[0]],f.hashes),rejected=assert.rejects(run,error=>error.name==='AbortError');
 await entered.promise;f.control.abort();await Promise.all([rejected,f.session.dispose()]);await f.cache.dispose();
 assert.equal(f.state.runs.length,0);assert.deepEqual(await fs.readdir(path.join(f.root,'cache','prepared')),[]);
});

test('failed shared preparation is removed so discovery can retry',async t=>{
 const f=await fixture(t,{failDiscover:(_secondary,count)=>count===1});
 const attempts=await Promise.allSettled([f.session.discover(f.project),f.session.discover(f.project)]);
 assert.ok(attempts.every(result=>result.status==='rejected'));assert.equal(f.state.discoveries.length,1);
 assert.equal((await f.session.discover(f.project)).length,2);assert.equal(f.state.prepared,1);assert.equal(f.state.claims,1);
});

test('complete files overlap in reusable isolated lanes with canonical IDs and separate coverage sessions',async t=>{
 const f=await fixture(t,{coverage:true,holdPrimary:true}),groups=await f.session.discover(f.project);
 const primary=f.session.run([groups[0]],f.hashes,0);await f.state.primaryStarted.promise;
 const secondary=await f.session.run([groups[1]],f.hashes,1);
 const reused=await f.session.run([groups[1]],f.hashes,1);
 f.state.release.resolve();const first=await primary;
 assert.equal(f.state.peak,2);assert.equal(f.state.discoveries.length,2);assert.equal(f.state.prepared,1);
 assert.equal(new Set(f.state.instruments.map(item=>item.session)).size,2);
 assert.equal(new Set(f.state.reports.keys()).size,3);assert.equal(f.state.runs[1].assembly,f.state.runs[2].assembly);
 assert.deepEqual(Array.from(secondary.results,result=>result.id),Array.from(groups[1].tests,test=>test.id));
 assert.deepEqual(Array.from(reused.results,result=>result.id),Array.from(groups[1].tests,test=>test.id));
 assert.equal(first.trace.groupId,groups[0].id);assert.equal(secondary.trace.groupId,groups[1].id);
 assert.equal(first.trace.reliable,true);assert.equal(secondary.trace.reliable,true);
 assert.deepEqual(Array.from(secondary.trace.coverage,file=>file.file),[groups[1].file]);
 assert.ok(f.emitted.every(({group,result})=>group.tests.some(test=>test.id===result.id)));
 assert.equal(await fs.readFile(path.join(f.source,'asset'),'utf8'),'pristine');
 const ids=groups.map(group=>group.tests.map(test=>test.id));
 await f.session.dispose();
 assert.deepEqual(await fs.readdir(path.join(f.root,'runs')),[]);
 assert.deepEqual(groups.map(group=>group.tests.map(test=>test.id)),ids,'public discovery must never be replaced with lane identities');
});

test('different targets use idle primary outputs instead of preparing redundant secondary lanes',async t=>{
 const f=await fixture(t),other={...f.project,file:path.join(path.dirname(f.project.file),'Other.csproj')};
 const [first,second]=await Promise.all([f.session.discover(f.project),f.session.discover(other)]);
 await Promise.all([f.session.run([first[0]],f.hashes,1),f.session.run([second[0]],f.hashes,2)]);
 assert.equal(f.state.discoveries.length,2);assert.ok(f.state.runs.every(run=>!run.secondary));
});

test('changing pool worker IDs reuses an idle secondary output for the same target',async t=>{
 const f=await fixture(t,{holdPrimary:true}),groups=await f.session.discover(f.project);
 const primary=f.session.run([groups[0]],f.hashes,1);await f.state.primaryStarted.promise;
 await f.session.run([groups[1]],f.hashes,2);await f.session.run([groups[1]],f.hashes,3);await f.session.run([groups[1]],f.hashes,4);
 f.state.release.resolve();await primary;
 assert.equal(f.state.discoveries.length,2);assert.equal(new Set(f.state.runs.slice(1).map(run=>run.assembly)).size,1);
});

test('exact native IDs allow colliding row metadata to execute safely in a secondary lane',async t=>{
 const f=await fixture(t,{holdPrimary:true,stableIds:true,definitions:[{token:'a',file:'A.cs',name:'A'},
  {token:'b1',file:'B.cs',name:'Duplicate'},{token:'b2',file:'B.cs',name:'Duplicate'}]}),groups=await f.session.discover(f.project);
 const primary=f.session.run([groups[0]],f.hashes);await f.state.primaryStarted.promise;
 const secondary=await f.session.run([groups[1]],f.hashes,1);f.state.release.resolve();await primary;
 assert.equal(f.state.peak,2);assert.equal(f.state.runs[1].secondary,true);
 assert.deepEqual(Array.from(secondary.results,node=>node.id),['b1','b2']);
});

for(const kind of ['missing','extra','ambiguous'])test(`${kind} secondary identities fall back to the canonical primary without executing a guessed selection`,async t=>{
 const definitions=[{token:'a',file:'A.cs',name:'A'},{token:'b',file:'B.cs',name:'B'}];
 if(kind==='ambiguous')definitions.push({token:'b2',file:'B.cs',name:'B'});
 const f=await fixture(t,{holdPrimary:true,definitions,secondaryNodes:nodes=>kind==='missing'?nodes.filter(node=>!node.uid.endsWith(':b')):
  kind==='extra'?[...nodes,{...nodes[1],uid:nodes[1].uid+'new','display-name':'Extra'}]:nodes});
 const groups=await f.session.discover(f.project),primary=f.session.run([groups[0]],f.hashes);
 await f.state.primaryStarted.promise;const second=f.session.run([groups[1]],f.hashes,1);
 await f.state.fallback.promise;assert.equal(f.state.runs.length,1);
 f.state.release.resolve();const [,result]=await Promise.all([primary,second]);
 assert.ok(f.state.runs.every(run=>!run.secondary));assert.equal(f.state.peak,1);
 assert.deepEqual(Array.from(result.results,node=>node.id),Array.from(groups[1].tests,test=>test.id));
});

test('partial files, exclusions, project batches and runtime fallback stay on the primary lane',async t=>{
 const f=await fixture(t,{holdPrimary:true,definitions:[{token:'a',file:'A.cs',name:'A'},{token:'b',file:'B.cs',name:'B'},{token:'b2',file:'B.cs',name:'B2'}]});
 const groups=await f.session.discover(f.project),[a,b]=groups,primary=f.session.run([a],f.hashes);
 await f.state.primaryStarted.promise;
 const partial=f.session.run([{...b,tests:[b.tests[0]]}],f.hashes,1);
 const excluded=f.session.run([{...b,excludedTestIds:[b.tests[1].id]}],f.hashes,2);
 const project=f.session.run(groups,f.hashes,3);
 const runtime=f.session.run([{...a,id:'runtime',file:undefined,runtimeOnly:true,tests:[{id:'unknown',name:'Unknown',line:1,node:{uid:'unknown'}}]}],f.hashes,4);
 assert.equal(f.state.discoveries.length,1);f.state.release.resolve();
 const results=await Promise.all([primary,partial,excluded,project,runtime]);
 assert.equal(results[1].results.length,1);assert.equal(results[2].results.length,1);assert.equal(results[3].results.length,3);
 assert.equal(results[4].results.length,3);assert.equal(f.state.peak,1);assert.equal(f.state.discoveries.length,1);
});

test('secondary discovery failure surfaces without falling back or deleting an active primary output',async t=>{
 const f=await fixture(t,{holdPrimary:true,failDiscover:secondary=>secondary}),groups=await f.session.discover(f.project);
 const primary=f.session.run([groups[0]],f.hashes);await f.state.primaryStarted.promise;
 await assert.rejects(f.session.run([groups[1]],f.hashes,1),/controlled discovery failure/);
 assert.equal(f.state.runs.length,1);f.state.release.resolve();await primary;
});

test('an execution failure drains already queued primary work without starting it',async t=>{
 const f=await fixture(t,{holdPrimary:true,failRun:(_call,count)=>count===1}),groups=await f.session.discover(f.project);
 const first=f.session.run([groups[0]],f.hashes);await f.state.primaryStarted.promise;
 const queued=f.session.run([groups[1]],f.hashes),outcomes=Promise.allSettled([first,queued]);
 f.state.release.resolve();assert.ok((await outcomes).every(result=>result.status==='rejected'&&/controlled execution failure/.test(result.reason.message)));
 assert.equal(f.state.runs.length,1,'queued primary work must stop before MTP starts');
 assert.equal((await f.session.run([groups[1]],f.hashes)).results.length,1,'a later explicit run may retry once the failed queue has drained');
});

test('shared cancellation stops active lanes and disposal waits before removing their output',async t=>{
 const f=await fixture(t,{holdAll:true}),groups=await f.session.discover(f.project);
 const primary=f.session.run([groups[0]],f.hashes);await f.state.primaryStarted.promise;
 const secondary=f.session.run([groups[1]],f.hashes,1);await f.state.secondaryStarted.promise;
 const outcomes=Promise.allSettled([primary,secondary]);f.control.abort();
 await f.session.dispose();assert.ok((await outcomes).every(result=>result.status==='rejected'&&result.reason.name==='AbortError'));
 assert.equal(f.state.active,0);assert.deepEqual(await fs.readdir(path.join(f.root,'runs')),[]);
 await assert.rejects(f.session.run([groups[0]],f.hashes),/disposed/);
});

test('disposal releases every cached owner even when one cleanup fails, and concurrent disposal shares the drain',async t=>{
 const f=await fixture(t,{expectDisposeFailure:true}),other={...f.project,file:path.join(path.dirname(f.project.file),'Other.csproj')};
 await Promise.all([f.session.discover(f.project),f.session.discover(other)]);
 const entered=deferred(),finish=deferred(),released=[];
 const preparations=[...f.session.prepared.values()];
 preparations[0].lease={release:async()=>{released.push('first');throw new Error('controlled lease cleanup failure');}};
 preparations[1].lease={release:async()=>{released.push('second');entered.resolve();await finish.promise;}};
 const disposal=f.session.dispose();assert.equal(f.session.dispose(),disposal);
 let completed=false;const rejected=assert.rejects(disposal,error=>error.name==='AggregateError'&&error.errors.some(error=>/controlled lease cleanup failure/.test(error.message))).then(()=>{completed=true;});
 await entered.promise;await delay(5);assert.equal(completed,false);finish.resolve();await rejected;
 assert.deepEqual(released.sort(),['first','second']);assert.deepEqual(await fs.readdir(path.join(f.root,'runs')),[]);
});
