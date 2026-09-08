const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),{setTimeout:delay}=require('node:timers/promises');

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
  sourceFiles:[...new Set(definitions.map(node=>path.join(workspace,node.file)))]};
 const state={discoveries:[],runs:[],instruments:[],prepared:0,claims:0,active:0,peak:0,activeAssemblies:new Set(),
  primaryStarted:deferred(),secondaryStarted:deferred(),release:deferred(),fallback:deferred(),reports:new Map()};
 const control=new AbortController(),file=path.resolve('out/services/runner.js'),realRequire=createRequire(file),exports={};
 const mtp=realRequire('./mtp'),output=realRequire('./output'),processTools=realRequire('./process'),ownership=realRequire('./runOutputs');
 const nodesFor=assembly=>definitions.map(node=>({uid:config.stableIds?node.token:`${path.dirname(assembly)}:${node.token}`,'display-name':node.name,
  'location.file':path.join(workspace,node.file),'location.type':node.type??node.name,'location.method':node.method??'Run'}));
 const requestTests=async(options,operation,selected)=>{
  const secondary=options.assembly.includes(`${path.sep}lanes${path.sep}`);
  let nodes=nodesFor(options.assembly);
  if(operation==='discover'){
   state.discoveries.push({assembly:options.assembly,secondary});
   if(config.failDiscover?.(secondary,state.discoveries.length))throw new Error('controlled discovery failure');
   if(secondary&&config.secondaryNodes)nodes=config.secondaryNodes(nodes);
   return nodes;
  }
  const requested=selected??options.expectedTests;
  assert.ok(requested.every(node=>nodes.some(candidate=>candidate.uid===node.uid)),'only lane-native UIDs may reach MTP');
  const call={assembly:options.assembly,secondary,ids:requested.map(node=>node.uid),wrapper:options.wrapper};
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
  './process':{...processTools,runProcess:async(_command,args)=>{
   assert.equal(args[0],'instrument');state.instruments.push({assembly:args[1],session:args[3]});
   await fs.appendFile(args[1],args[3]);return{code:0,stdout:'',stderr:''};
  }},
  './output':{...output,removeOutput:async directory=>{
   for(const assembly of state.activeAssemblies)assert.equal(assembly.startsWith(directory+path.sep),false,'cleanup must await the owning run');
   return output.removeOutput(directory);
  }},
  './runOutputs':{...ownership,claimRunOutputs:async(...args)=>{state.claims++;await delay(5);return ownership.claimRunOutputs(...args);}},
  './coverageReader':{CoverageReader:class{async read(report,_cwd,hashes){return(state.reports.get(report)??[]).map(file=>({file,hash:hashes.get(file),lines:[{line:1,hits:1}]}));}async dispose(){}}},
  './runtimeObservation':{RuntimeObservation:class{static async start(){return{env:{},dependencies:async()=>({files:[],projects:[]})};}}}
 };
 vm.runInNewContext(await fs.readFile(file,'utf8'),{exports,process,require:name=>modules[name]??realRequire(name)});
 const emitted=[];
 const session=new exports.RunnerSession({dotnet:'dotnet',storage:path.join(root,'runs'),testArguments:[],signal:control.signal,
  coverageTool:config.coverage?'collector':undefined,assemblies:[project.assembly],onPrepared:()=>state.prepared++,
  onResult:(group,result)=>emitted.push({group,result}),output:message=>{if(message.includes('primary runner'))state.fallback.resolve();}});
 t.after(async()=>{state.release.resolve();await session.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,source,project,state,session,control,emitted,hashes:new Map(project.sourceFiles.map(file=>[file,'v1']))};
}

test('concurrent target discovery claims one lease and prepares each target once',async t=>{
 const f=await fixture(t),other={...f.project,file:path.join(path.dirname(f.project.file),'Other.csproj')};
 const [first,again]=await Promise.all([f.session.discover(f.project),f.session.discover(f.project),f.session.discover(other)]);
 assert.equal(first,again);assert.equal(f.state.claims,1);assert.equal(f.state.discoveries.length,2);assert.equal(f.state.prepared,2);
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
