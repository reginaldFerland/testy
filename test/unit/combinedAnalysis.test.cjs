const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const analysis=require('../../out/services/analysis'),processes=require('../../out/services/process');

const shape={signature:'A'.repeat(64),body:'B'.repeat(64),partialTypes:['N:C`0'],excludedTypes:[]};
async function fixture(t) {
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy combined analysis ')));
 const files=['Aliases.cs','Body.cs'].map(name=>path.join(directory,name));
 const calls=[],run=processes.runProcess;let respond;
 processes.runProcess=async(command,args,options)=>{
  const request=JSON.parse(await fs.readFile(args[1],'utf8'));calls.push({command,args,options,request});
  const value=await respond(request,options);
  return typeof value==='string'?{code:0,stdout:value,stderr:''}:{code:0,stdout:JSON.stringify(value),stderr:''};
 };
 t.after(async()=>{processes.runProcess=run;await fs.rm(directory,{recursive:true,force:true});});
 return{directory,files,calls,respond:value=>{respond=value;},
  batch:(files_,aliases,update,options={})=>analysis.sourceAnalysisBatch('dotnet','analyzer.dll',files_,directory,{cwd:directory,...options},aliases,4,update)};
}

test('combined requests preserve the worker budget and return every source affected by changed aliases',async t=>{
 const f=await fixture(t);f.respond(()=>({aliases:['Blind'],analyses:Object.fromEntries(f.files.map(file=>[file,shape]))}));
 const result=await f.batch([f.files[0]],[],{sources:['global using Blind = ExcludeFromCodeCoverageAttribute;'],allFiles:f.files});
 assert.deepEqual(result.aliases,['Blind']);assert.deepEqual([...result.analyses.keys()],f.files);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].request.concurrency,4);assert.deepEqual(f.calls[0].request.files,[f.files[0]]);
 assert.deepEqual(f.calls[0].request.allFiles,f.files);assert.equal(f.calls[0].options.output,undefined);
 assert.deepEqual(await fs.readdir(f.directory),[]);
});

test('alias order and duplicates do not expand analysis when the resolved set is unchanged',async t=>{
 const f=await fixture(t);f.respond(()=>({aliases:['Two','One','One'],analyses:{[f.files[0]]:shape}}));
 const result=await f.batch([f.files[0]],['One','Two'],{sources:['changed comments'],allFiles:f.files});
 assert.deepEqual([...result.analyses.keys()],[f.files[0]]);assert.equal(f.calls.length,1);
});

test('removing the last alias analyzes all files with one ordinary request, and empty work launches none',async t=>{
 const f=await fixture(t);f.respond(request=>Object.fromEntries(request.files.map(file=>[file,shape])));
 const deleted=await f.batch([],['Blind'],{sources:[],allFiles:f.files});
 assert.deepEqual(deleted.aliases,[]);assert.deepEqual([...deleted.analyses.keys()],f.files);
 assert.deepEqual(f.calls[0].request.files,f.files);assert.equal(f.calls[0].request.aliasSources,undefined);
 assert.deepEqual(f.calls[0].request.excludedAliases,[]);
 await f.batch([],[],undefined);await f.batch([],[],{sources:[],allFiles:f.files});
 assert.equal(f.calls.length,1,'neither unchanged sources nor an empty alias inventory requires a process');
});

test('legitimate null records remain conservative without discarding healthy siblings',async t=>{
 const f=await fixture(t);f.respond(()=>({aliases:['Blind'],analyses:{[f.files[0]]:shape,[f.files[1]]:null}}));
 const result=await f.batch([],[],{sources:['an alias'],allFiles:f.files});
 assert.deepEqual(result.analyses.get(f.files[0]),shape);assert.equal(result.analyses.get(f.files[1]),null);
});

test('malformed and incomplete combined responses reject the whole unpublished transaction',async t=>{
 const f=await fixture(t),valid={aliases:['Blind'],analyses:Object.fromEntries(f.files.map(file=>[file,shape]))};
 const invalid=[null,[],{aliases:[1],analyses:valid.analyses},{aliases:['Blind'],analyses:[]},
  {aliases:['Blind'],analyses:{[f.files[0]]:shape}},
  {aliases:['Blind'],analyses:{[f.files[0]]:shape,unexpected:shape}},
  {aliases:['Blind'],analyses:{...valid.analyses,[f.files[1]]:{...shape,signature:'invalid'}}},'not json'];
 for(const response of invalid){f.respond(()=>response);await assert.rejects(f.batch([],[],{sources:['changed alias'],allFiles:f.files}));}
 assert.deepEqual(await fs.readdir(f.directory),[],'all failed requests release their temporary files');
});

test('process failure and cancellation clean up and never return a partial alias update',async t=>{
 const f=await fixture(t);f.respond(()=>{throw new Error('analyzer failed');});
 await assert.rejects(f.batch([],[],{sources:['alias'],allFiles:f.files}),/analyzer failed/);
 const abort=new AbortController();f.respond(()=>{abort.abort();return{aliases:['Blind'],analyses:Object.fromEntries(f.files.map(file=>[file,shape]))};});
 await assert.rejects(f.batch([],[],{sources:['alias'],allFiles:f.files},{signal:abort.signal}),{name:'AbortError'});
 const before=f.calls.length;
 await assert.rejects(f.batch([],[],undefined,{signal:abort.signal}),{name:'AbortError'});assert.equal(f.calls.length,before);
 assert.deepEqual(await fs.readdir(f.directory),[]);
});
