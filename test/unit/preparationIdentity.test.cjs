const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const {normalizePath,contentHash}=require('../../out/core/paths');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function identityFixture(config={}){
 const file=path.resolve('out/services/preparationIdentity.js'),realRequire=createRequire(file),exports={};
 const resolved=new Map([['dotnet','C:\\tools\\dotnet.exe'],['collector','C:\\tools\\collector.exe'],['other-host','C:\\other\\dotnet.exe']]);
 const versions=new Map(),calls=[],hashes=[];
 vm.runInNewContext(await fs.readFile(file,'utf8'),{exports,__dirname:'C:\\repo\\out\\services',require:name=>name==='node:path'?path.win32:
  name==='./executable'?{resolveNodeExecutable:async(command,env,cwd,signal)=>{
   signal?.throwIfAborted();calls.push({command,env,cwd});await config.resolve?.(command);
   return resolved.get(command)??(path.win32.isAbsolute(command)?command:undefined);
  }}:name==='./preparedOutputCache'?{preparationToolIdentity:async(file,env,signal,cwd,identities)=>{
   signal?.throwIfAborted();assert.equal(path.win32.isAbsolute(file),true,'only explicitly resolved file paths reach asset hashing');
   hashes.push({file,env,cwd,identities});await config.hash?.(file);signal?.throwIfAborted();
   return `${file}:${versions.get(file)??'v1'}`;
  }}:realRequire(name)});
 const env={Path:'C:\\tools'},identities=new Map();
 const options={dotnet:'dotnet',coverageTool:'collector',analyzer:'analyzer\\Testy.Analysis.dll',cleanupDescendants:false};
 return{...exports,resolved,versions,calls,hashes,env,identities,options,
  read:overrides=>exports.windowsPreparationTools({...options,...overrides},env,'C:\\work',identities)};
}

test('Windows preparation assigns executable and asset roles without resolving analyzer DLLs as commands',async()=>{
 const f=await identityFixture(),tools=await f.read();
 assert.equal(tools.instrumentationLaunch,'node');assert.equal(tools.dotnetNode,'C:\\tools\\dotnet.exe:v1');
 assert.equal(tools.collector,'C:\\tools\\collector.exe:v1');assert.equal(tools.analyzerAsset,'C:\\work\\analyzer\\Testy.Analysis.dll:v1');
 assert.deepEqual(f.calls.map(call=>call.command),['dotnet','collector']);
 assert.ok(f.calls.every(call=>call.env===f.env&&call.cwd==='C:\\work'));
 assert.ok(f.hashes.every(call=>call.identities===f.identities));
 assert.equal(tools.ownerNode,undefined);assert.equal(tools.ownerAsset,undefined);
});

test('selected executable identities are fresh and logical command changes remain conservative context',async()=>{
 const f=await identityFixture(),first=await f.read();
 f.resolved.set('collector','C:\\project\\collector.com');const shadow=await f.read();
 assert.notEqual(shadow.collector,first.collector);assert.equal(shadow.collector,'C:\\project\\collector.com:v1');
 f.versions.set('C:\\project\\collector.com','v2');assert.notEqual((await f.read()).collector,shadow.collector);
 const alias=await f.read({coverageTool:'C:\\project\\collector.com'});
 assert.equal(alias.collector,(await f.read()).collector);assert.notEqual(alias.commands.collector,(await f.read()).commands.collector);
});

test('standalone Windows owned instrumentation requires an explicit existing collector and hashes its owner inputs',async()=>{
 const f=await identityFixture();
 for(const coverageTool of ['collector','./collector.exe','C:collector.exe','\\collector.exe','C:\\tools\\collector','C:\\tools\\collector.exe:stream',
  '\\\\?\\UNC\\server\\share\\sub\\..\\collector.exe','\\\\.\\UNC\\server\\share\\collector.exe']){
  await assert.rejects(f.read({cleanupDescendants:undefined,coverageTool}),/explicit path/);
 }
 const options={cleanupDescendants:true,coverageTool:'C:\\tools\\collector.exe',dotnetHost:'other-host'},first=await f.read(options);
 assert.equal(first.instrumentationLaunch,'windows-owner-explicit');assert.equal(first.ownerNode,'C:\\other\\dotnet.exe:v1');
 assert.equal(first.ownerAsset,'C:\\repo\\dist\\processhost\\Testy.ProcessHost.dll:v1');
 f.versions.set('C:\\repo\\dist\\processhost\\Testy.ProcessHost.dll','v2');assert.notEqual((await f.read(options)).ownerAsset,first.ownerAsset);
 f.versions.set('C:\\other\\dotnet.exe','v2');assert.notEqual((await f.read(options)).ownerNode,first.ownerNode);
 assert.ok(!f.calls.some(call=>call.command==='C:\\tools\\collector.exe'),'explicit owned command is checked as an exact asset, without Node fallback suffix search');
});

test('without coverage there is no owned-instrumentation gate or owner bundle read',async()=>{
 const f=await identityFixture(),tools=await f.read({coverageTool:undefined,cleanupDescendants:undefined});
 assert.equal(tools.instrumentationLaunch,'none');assert.equal(tools.collector,undefined);assert.equal(tools.ownerAsset,undefined);
 assert.deepEqual(f.calls.map(call=>call.command),['dotnet']);
});

test('failed Windows role resolution drains independently admitted asset reads before fallback', {timeout:5000},async t=>{
 const entered=deferred(),finish=deferred();t.after(()=>finish.resolve());
 const f=await identityFixture({hash:async file=>{if(file.endsWith('Testy.Analysis.dll')){entered.resolve();await finish.promise;}}});
 f.resolved.delete('collector');
 const pending=f.read(),rejected=assert.rejects(pending,/Cannot identify direct preparation executable/);let settled=false;
 void pending.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;await Promise.resolve();assert.equal(settled,false);
 finish.resolve();await rejected;
});

test('cancellation drains Windows identity readers and rejects rather than returning partial roles',{timeout:5000},async t=>{
 const entered=deferred(),finish=deferred();t.after(()=>finish.resolve());
 const f=await identityFixture({hash:async file=>{if(file.endsWith('Testy.Analysis.dll')){entered.resolve();await finish.promise;}}}),abort=new AbortController();
 const pending=f.read({signal:abort.signal}),rejected=assert.rejects(pending,{name:'AbortError'});let settled=false;
 void pending.then(()=>{settled=true;},()=>{settled=true;});await entered.promise;abort.abort();await Promise.resolve();assert.equal(settled,false);
 finish.resolve();await rejected;
});

async function runnerFixture(t,config={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-preparation-roles-'))),source=path.join(root,'build'),workspace=path.join(root,'workspace');
 await fs.mkdir(source);await fs.mkdir(workspace);await fs.writeFile(path.join(source,'Tests.dll'),'pristine');await fs.writeFile(path.join(source,'asset'),'pristine');
 const sourceFile=normalizePath(path.join(workspace,'Tests.cs'));
 const project={file:normalizePath(path.join(workspace,'Tests.csproj')),framework:'net10.0',assembly:path.join(source,'Tests.dll'),sourceFiles:[sourceFile]};
 const file=path.resolve('out/services/runner.js'),realRequire=createRequire(file),exports={},identity=await identityFixture();
 const mtp=realRequire('./mtp'),cacheTools=realRequire('./preparedOutputCache'),processTools=realRequire('./process');
 const platform=config.platform??'win32',fakeProcess=Object.create(process);Object.defineProperty(fakeProcess,'platform',{value:platform});Object.defineProperty(fakeProcess,'env',{value:{Path:'C:\\tools'}});
 const state={instruments:[],discoveries:[],runs:[],messages:[],legacy:[]};
 const modules={
  './preparationIdentity':platform==='win32'?identity:{windowsPreparationTools:()=>{throw new Error('POSIX must retain its existing identity path');}},
  './preparedOutputCache':{...cacheTools,preparationToolIdentity:async command=>{state.legacy.push(command);return command===undefined?undefined:`legacy:${command}`;}},
  './process':{...processTools,runProcess:async(command,args,options)=>{
   assert.equal(args[0],'instrument');state.instruments.push({command,session:args[3],cleanupDescendants:options.cleanupDescendants});
   await fs.appendFile(args[1],`:instrumented:${args[3]}`);return{code:0,stdout:'',stderr:''};
  }},
  './mtp':{...mtp,requestTests:async(options,operation,selected)=>{
   const asset=path.join(path.dirname(options.assembly),'asset');
   assert.equal(await fs.readFile(asset,'utf8'),'pristine','cached working output is repaired before every native operation');
   if(operation==='discover'){
    const uid=`fresh-${state.discoveries.length}`;state.discoveries.push({assembly:options.assembly,uid});await fs.writeFile(asset,'discovery mutation');
    return[{uid,'display-name':'Current test','location.file':sourceFile,'location.type':'Tests','location.method':'Run'}];
   }
   const nodes=selected??options.expectedTests;assert.deepEqual(Array.from(nodes,node=>node.uid),[state.discoveries.at(-1).uid]);
   state.runs.push({dotnet:options.dotnet,wrapper:options.wrapper,ids:nodes.map(node=>node.uid)});
   return nodes.map(node=>({...node,'execution-state':'passed'}));
  }},
  './coverageReader':{CoverageReader:class{async read(_report,_cwd,hashes){return[{file:sourceFile,hash:hashes.get(sourceFile),lines:[{line:1,hits:1}]}];}async dispose(){}}},
  './runtimeObservation':{RuntimeObservation:class{static async start(){return{dependencies:async()=>({files:[],projects:[]})};}}}
 };
 vm.runInNewContext(await fs.readFile(file,'utf8'),{exports,process:fakeProcess,require:name=>modules[name]??realRequire(name)});
 const cache=new cacheTools.PreparedOutputCache(path.join(root,'cache'),randomUUID()),sessions=[];
 const base={dotnet:'dotnet',coverageTool:config.collector??'collector',managedCoverageTool:true,storage:path.join(root,'runs'),testArguments:[],preparedOutputCache:cache,
  cleanupDescendants:config.owned?undefined:false,output:message=>state.messages.push(message),assemblies:[project.assembly]};
 const create=(overrides={})=>{const session=new exports.RunnerSession({...base,...overrides});sessions.push(session);return session;};
 t.after(async()=>{for(const session of sessions)await session.dispose();await cache.dispose();await fs.rm(root,{recursive:true,force:true});});
 const run=async overrides=>{const session=create(overrides),groups=await session.discover(project),result=await session.run(groups,new Map([[sourceFile,'v1']]));
  const artifact=[...session.prepared.values()][0];await session.dispose();return{groups,result,session:artifact.session,root:artifact.root};};
 return{root,sourceFile,project,identity,state,base,create,run,fakeProcess};
}

test('ordinary Windows direct preparation stays cached while fresh native IDs, coverage and discovery repair are preserved',async t=>{
 const f=await runnerFixture(t),first=await f.run(),second=await f.run();
 assert.equal(f.state.instruments.length,1);assert.equal(first.session,second.session);assert.equal(first.root,second.root);
 assert.equal(f.state.discoveries.length,2);assert.equal(f.state.runs.length,2);assert.notEqual(first.groups[0].tests[0].id,second.groups[0].tests[0].id);
 assert.equal(second.result.results[0].id,second.groups[0].tests[0].id);assert.equal(second.result.trace.reliable,true);
 assert.deepEqual(second.result.trace.coverage,first.result.trace.coverage);assert.equal(second.result.trace.coverage[0].hash,'v1');
 assert.ok(f.state.runs.every(run=>run.dotnet==='dotnet'&&run.wrapper.command==='collector'),'identity lookup never rewrites owned MTP/collector launch arguments');
 assert.ok(f.state.instruments.every(call=>call.cleanupDescendants===false));
});

test('Windows caller invalidates a template when the selected Node instrumenter changes',async t=>{
 const f=await runnerFixture(t),first=await f.run();f.identity.versions.set('C:\\tools\\collector.exe','v2');const changed=await f.run();
 assert.equal(f.state.instruments.length,2);assert.notEqual(changed.session,first.session);
 assert.equal((await f.run()).session,changed.session);assert.equal(f.state.instruments.length,2);
});

test('standalone owned bare collectors still execute but cannot publish reusable preparation',async t=>{
 const f=await runnerFixture(t,{owned:true}),first=await f.run(),second=await f.run();
 assert.equal(f.state.instruments.length,2);assert.notEqual(first.session,second.session);assert.equal(f.state.runs.length,2);
 assert.ok(f.state.messages.some(message=>message.includes('without an explicit path')));
 assert.ok(f.state.instruments.every(call=>call.command==='collector'&&call.cleanupDescendants===undefined));
});

test('explicit standalone owned collectors retain cache eligibility and invalidate owner bundle changes',async t=>{
 const f=await runnerFixture(t,{owned:true,collector:'C:\\tools\\collector.exe'}),first=await f.run(),second=await f.run();
 assert.equal(f.state.instruments.length,1);assert.equal(second.session,first.session);
 f.identity.versions.set('C:\\repo\\dist\\processhost\\Testy.ProcessHost.dll','v2');const changed=await f.run();
 assert.equal(f.state.instruments.length,2);assert.notEqual(changed.session,first.session);
});

test('POSIX preparation contexts retain the exact version-three key while Windows uses a new proof version',async t=>{
 const f=await runnerFixture(t,{platform:'linux'}),session=f.create({analyzer:'analyzer.dll'}),group={project:f.project.file,framework:f.project.framework,assembly:f.project.assembly};
 const context=await session.preparationContext(group),env={...f.fakeProcess.env,SHLVL:undefined,VSCODE_PID:undefined};
 const tools=contentHash(JSON.stringify({tools:['legacy:dotnet','legacy:collector','legacy:analyzer.dll'],
  env:Object.entries(env).sort(([left],[right])=>left.localeCompare(right)),arguments:[],assemblies:[f.project.assembly],
  runtime:process.version,platform:'linux',architecture:process.arch}));
 assert.equal(context,JSON.stringify({version:3,tools,project:group.project,framework:group.framework,assembly:group.assembly}));
 const windows=await runnerFixture(t),current=JSON.parse(await windows.create().preparationContext({project:windows.project.file,framework:windows.project.framework,assembly:windows.project.assembly}));
 assert.equal(current.version,4);assert.deepEqual(f.state.legacy,['dotnet','collector','analyzer.dll']);
});
