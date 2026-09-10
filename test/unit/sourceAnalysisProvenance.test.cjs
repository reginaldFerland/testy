const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const analysis=require('../../out/services/analysis'),processes=require('../../out/services/process');
const {sourceAnalysisContext}=require('../../out/services/analysisContext');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const shape={signature:'A'.repeat(64),body:'B'.repeat(64),partialTypes:['N:C`0'],excludedTypes:[]};

async function fixture(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy analysis provenance ')));
 const files=['Aliases.cs','Body.cs'].map(name=>path.join(directory,name));
 const run=processes.runProcess,calls=[];let respond;
 processes.runProcess=async(command,args,options)=>{
  const bytes=await fs.readFile(args[1]),request=JSON.parse(bytes);calls.push({request,options,bytes});
  return{code:0,stdout:JSON.stringify(await respond(request,bytes,options)),stderr:''};
 };
 t.after(async()=>{processes.runProcess=run;await fs.rm(directory,{recursive:true,force:true});});
 const valid=(request,bytes)=>({version:1,requestHash:hash(bytes).toUpperCase(),aliases:request.excludedAliases,
  analyses:Object.fromEntries(request.files.map(file=>[file,shape])),sourceHashes:Object.fromEntries(request.files.map(file=>[file,'C'.repeat(64)]))});
 return{directory,files,calls,valid,respond:value=>{respond=value;},
  batch:(files_,aliases=[],update,options={})=>analysis.sourceAnalysisBatch('dotnet','analyzer.dll',files_,directory,{cwd:directory,...options},aliases,3,update,true)};
}

test('analysis provenance binds Unicode aliases to exact serialized request bytes without changing SourceShape',async t=>{
 const f=await fixture(t);f.respond((request,bytes)=>({...f.valid(request,bytes),aliases:['秘密'],
  analyses:Object.fromEntries(f.files.map(file=>[file,shape])),sourceHashes:Object.fromEntries(f.files.map(file=>[file,'C'.repeat(64)]))}));
 const result=await f.batch([f.files[0]],[],{sources:['global using 秘密 = System.Diagnostics.DebuggerHiddenAttribute; // <>& 😀'],allFiles:f.files});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].request.provenance,true);assert.equal(f.calls[0].request.concurrency,3);
 assert.deepEqual(result.aliases,['秘密']);assert.deepEqual([...result.analyses.values()],[shape,shape]);
 assert.deepEqual([...result.sourceHashes.values()],['c'.repeat(64),'c'.repeat(64)]);
 assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('provenance requires complete matching hashes and rejects otherwise valid legacy or wrong-request responses',async t=>{
 const f=await fixture(t);
 const changes=[value=>({...value,version:2}),value=>({...value,requestHash:'D'.repeat(64)}),
  value=>({...value,sourceHashes:undefined}),value=>({...value,sourceHashes:[]}),
  value=>({...value,sourceHashes:{[f.files[0]]:'C'.repeat(64)}}),
  value=>({...value,sourceHashes:{...value.sourceHashes,[f.files[1]]:null}}),
  value=>({...value,sourceHashes:{...value.sourceHashes,[f.files[1]]:'not a hash'}}),
  value=>({...value,aliases:['unexpected']})];
 for(const change of changes){f.respond((request,bytes)=>change(f.valid(request,bytes)));await assert.rejects(f.batch(f.files));}
 f.respond((request,bytes)=>{const value=f.valid(request,bytes);return{...value,analyses:{...value.analyses,[f.files[1]]:null},sourceHashes:{...value.sourceHashes,[f.files[1]]:null}};});
 const result=await f.batch(f.files);assert.deepEqual(result.analyses.get(f.files[0]),shape);assert.equal(result.analyses.get(f.files[1]),null);
 assert.equal(result.sourceHashes.has(f.files[1]),false);assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('empty provenance work avoids a helper and removal of the last alias still analyzes every affected file',async t=>{
 const f=await fixture(t);f.respond(f.valid);
 assert.equal((await f.batch([])).sourceHashes.size,0);
 assert.equal((await f.batch([],[],{sources:[],allFiles:f.files})).sourceHashes.size,0);assert.equal(f.calls.length,0);
 const result=await f.batch([],['Blind'],{sources:[],allFiles:f.files});
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].request.files,f.files);assert.deepEqual(f.calls[0].request.excludedAliases,[]);
 assert.equal(result.sourceHashes.size,2);assert.deepEqual(result.aliases,[]);
});

test('provenance cancellation and malformed responses clean temporary requests without publishing results',async t=>{
 const f=await fixture(t),abort=new AbortController();
 f.respond((request,bytes)=>{abort.abort();return f.valid(request,bytes);});
 await assert.rejects(f.batch(f.files,[],undefined,{signal:abort.signal}),{name:'AbortError'});
 assert.deepEqual(await fs.readdir(f.directory),[]);
 f.respond(()=>{throw new Error('failed before response');});await assert.rejects(f.batch(f.files),/failed before response/);
 assert.deepEqual(await fs.readdir(f.directory),[]);
});

async function toolFixture(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy analysis identity ')));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const host=path.join(directory,process.platform==='win32'?'dotnet.exe':'dotnet'),analyzer=path.join(directory,'analyzer','Testy.Analysis.dll');
 await fs.mkdir(path.join(directory,'host/fxr/10.0.0'),{recursive:true});await fs.mkdir(path.join(directory,'shared/Microsoft.NETCore.App/10.0.0'),{recursive:true});
 await fs.mkdir(path.dirname(analyzer));await fs.writeFile(host,Buffer.from('7f454c4601020304','hex'),{mode:0o755});await fs.writeFile(analyzer,'trusted syntax helper');
 await fs.writeFile(analyzer.replace('.dll','.runtimeconfig.json'),JSON.stringify({runtimeOptions:{framework:{name:'Microsoft.NETCore.App',version:'10.0.0'}}}));
 await fs.writeFile(analyzer.replace('.dll','.deps.json'),JSON.stringify({targets:{net10:{Roslyn:{runtime:{'lib/Microsoft.CodeAnalysis.CSharp.dll':{}}}}}}));
 const asset=path.join(path.dirname(analyzer),'Microsoft.CodeAnalysis.CSharp.dll');await fs.writeFile(asset,'Roslyn version A');
 // The host fixture models ordinary installed hosting independently of CI CLR overrides.
 const env=Object.fromEntries(Object.keys(process.env).filter(key=>/^(CORECLR_|COR_|COMPlus_|DOTNET_(STARTUP_HOOKS|ADDITIONAL_DEPS|SHARED_STORE|ROOT|MULTILEVEL_LOOKUP|ROLL_FORWARD|RUNTIME_ID)|LD_|DYLD_)/i.test(key)).map(key=>[key,undefined]));
 const context=(extra={})=>sourceAnalysisContext(host,analyzer,{cwd:directory,env:{...env,...extra}});
 return{directory,host,analyzer,asset,context,env};
}

test('fresh syntax context detects analyzer assets, native host, runtime inventories, and environment changes',async t=>{
 const f=await toolFixture(t);let previous=await f.context();assert.ok(previous);assert.equal(await f.context(),previous);
 for(const change of [()=>fs.writeFile(f.asset,'Roslyn version B'),()=>fs.appendFile(f.host,'host update'),
  ()=>fs.mkdir(path.join(f.directory,'shared/Microsoft.NETCore.App/11.0.0'))]){
  await change();const next=await f.context();assert.ok(next);assert.notEqual(next,previous);previous=next;
 }
 assert.notEqual(await f.context({TESTY_CONTEXT_TEST:'changed'}),previous);
 assert.ok(await f.context({MSBuildSDKsPath:'an unchanged MSBuild-only setting'}),'syntax analysis does not invoke an MSBuild SDK resolver');
});

test('custom host wrappers, injected CLR inputs and development probing decline reusable syntax context',async t=>{
 const f=await toolFixture(t);
 for(const env of [{DOTNET_STARTUP_HOOKS:'untracked.dll'},{CORECLR_PROFILER_PATH:'untracked.so'},{DOTNET_SHARED_STORE:'external'},
  {LD_PRELOAD:'untracked.so'},{LD_LIBRARY_PATH:'external'},{LD_AUDIT:'untracked.so'},
  {DYLD_INSERT_LIBRARIES:'untracked.dylib'},{DYLD_LIBRARY_PATH:'external'},{DYLD_FALLBACK_FRAMEWORK_PATH:'external'}])assert.equal(await f.context(env),undefined);
 const dev=f.analyzer.replace('.dll','.runtimeconfig.dev.json');await fs.writeFile(dev,'{}');assert.equal(await f.context(),undefined);await fs.unlink(dev);
 await fs.writeFile(f.host,'#!/bin/sh\nexec another-dotnet "$@"\n');assert.equal(await f.context(),undefined);
 const abort=new AbortController();abort.abort();await assert.rejects(sourceAnalysisContext(f.host,f.analyzer,{cwd:f.directory,signal:abort.signal}),{name:'AbortError'});
});
