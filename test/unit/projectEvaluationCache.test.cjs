const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {ProjectEvaluationCache,evaluationInputs,evaluationToolContext}=require('../../out/services/projectEvaluationCache');

async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-evaluation-cache-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sdk=path.join(root,'sdks','10.0.100'),directory=path.join(root,'app');await fs.mkdir(sdk,{recursive:true});await fs.mkdir(directory);
 const file=path.join(directory,'App.csproj'),source=path.join(directory,'Code.cs'),imported=path.join(root,'settings.props');
 await fs.writeFile(file,'<Project/>');await fs.writeFile(source,'class Code {}');await fs.writeFile(imported,'<Project/>');
 const graph=[{file,sourceFiles:[source],framework:'net10.0',assembly:path.join(directory,'bin','App.dll'),references:[],isTestProject:true,runner:'mtp'}];
 const inputs=[{reusable:true,files:[file,imported],queries:[{kind:'files',path:directory,pattern:'*.cs',recursive:false,values:[source]}],excludedDirectories:[path.join(directory,'bin'),path.join(directory,'obj')],sdkDirectory:sdk}];
 evaluationInputs.set(graph,inputs);const cache=new ProjectEvaluationCache();await cache.put(new Map([[file,graph]]),'context');
 return{root,sdk,directory,file,source,imported,graph,inputs,cache,get:context=>cache.get([file],context??'context')};
}

test('validated evaluations reuse graph objects across source-content edits and generated outputs',async t=>{
 const f=await fixture(t);assert.equal((await f.get()).get(f.file),f.graph);
 await fs.writeFile(f.source,'class Changed {}');await fs.mkdir(path.join(f.directory,'bin'));await fs.writeFile(path.join(f.directory,'bin','Generated.cs'),'generated');
 assert.equal((await f.get()).get(f.file),f.graph,'build still receives fresh source bytes; evaluation depends on compile inventory');
});

test('evaluation reuse invalidates same-length import edits even if timestamps are restored',async t=>{
 const f=await fixture(t),stat=await fs.stat(f.imported);await fs.writeFile(f.imported,'<Changed/>');await fs.utimes(f.imported,stat.atime,stat.mtime);
 assert.equal((await f.get()).size,0);
});

test('evaluation reuse checks glob additions and deletions without watcher events',async t=>{
 const f=await fixture(t),added=path.join(f.directory,'New.cs');await fs.writeFile(added,'class New {}');assert.equal((await f.get()).size,0);
 await fs.rm(added);assert.equal((await f.get()).size,1);await fs.rm(f.source);assert.equal((await f.get()).size,0);
});

test('evaluation reuse checks previously absent imports and ancestor SDK configuration',async t=>{
 const f=await fixture(t),optional=path.join(f.root,'optional.props');
 f.inputs[0].queries.push({kind:'file',path:optional,pattern:null,recursive:false,values:['false']});
 await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,1);
 await fs.writeFile(optional,'<Project/>');assert.equal((await f.get()).size,0);await fs.rm(optional);
 await fs.writeFile(path.join(f.root,'global.json'),'{}');assert.equal((await f.get()).size,0);
});

test('evaluation reuse checks linked directory globs and new SDK installations',async t=>{
 const f=await fixture(t),linked=path.join(f.root,'linked');await fs.mkdir(linked);
 f.inputs[0].queries.push({kind:'files',path:linked,pattern:'*.cs',recursive:true,values:[]});
 await f.cache.put(new Map([[f.file,f.graph]]),'context');await fs.mkdir(path.join(linked,'nested'));await fs.writeFile(path.join(linked,'nested','Linked.cs'),'class Linked {}');
 assert.equal((await f.get()).size,0);await fs.rm(linked,{recursive:true});await fs.mkdir(linked);assert.equal((await f.get()).size,1);
 await fs.mkdir(path.join(path.dirname(f.sdk),'10.0.200'));assert.equal((await f.get()).size,0);
});

test('configuration changes, unsupported evaluation, missing metadata and retired roots cannot reuse',async t=>{
 const f=await fixture(t);assert.equal((await f.get('Release')).size,0);
 f.cache.retain([]);assert.equal((await f.get()).size,0);
 f.inputs[0].reusable=false;await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,0);
 evaluationInputs.delete(f.graph);await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,0);
});

test('cancelled evaluation validation propagates cancellation and does not publish entries',async t=>{
 const f=await fixture(t),abort=new AbortController();abort.abort();
 await assert.rejects(f.cache.get([f.file],'context',abort.signal),{name:'AbortError'});
 await assert.rejects(f.cache.put(new Map([[f.file,f.graph]]),'context',abort.signal),{name:'AbortError'});
});

test('an evaluation is not anchored to bytes changed after they were evaluated',async t=>{
 const f=await fixture(t),crypto=require('node:crypto');
 f.inputs[0].hashes={[f.imported]:crypto.createHash('sha256').update(await fs.readFile(f.imported)).digest('hex')};
 await fs.writeFile(f.imported,'<Project><PropertyGroup><Changed>true</Changed></PropertyGroup></Project>');
 await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,0);
});

test('SDK output import globs observe new matching imports while ordinary outputs remain reusable',async t=>{
 const f=await fixture(t),obj=path.join(f.directory,'obj');await fs.mkdir(obj);
 f.inputs[0].queries.push({kind:'imports',path:obj,pattern:'App.csproj.*.props',recursive:false,values:[]});
 await f.cache.put(new Map([[f.file,f.graph]]),'context');await fs.writeFile(path.join(obj,'build.cache'),'output');assert.equal((await f.get()).size,1);
 await fs.writeFile(path.join(obj,'App.csproj.new.props'),'<Project/>');assert.equal((await f.get()).size,0);
});

test('symbolic directory changes cannot reuse canonical source ownership from an earlier target',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),a=path.join(f.root,'a'),b=path.join(f.root,'b'),link=path.join(f.root,'link');
 await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'Same.cs'),'class Same {}');await fs.writeFile(path.join(b,'Same.cs'),'class Same {}');await fs.symlink(a,link);
 f.inputs[0].queries.push({kind:'files',path:link,pattern:'*.cs',recursive:false,values:[path.join(link,'Same.cs')]});
 await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,1);
 await fs.rm(link);await fs.symlink(b,link);assert.equal((await f.get()).size,0);
});

test('evaluation tool identity validates native host layout, executable bytes and analyzer bytes',async t=>{
 const f=await fixture(t),installation=path.join(f.root,'dotnet-installation'),host=path.join(installation,process.platform==='win32'?'dotnet.exe':'dotnet'),analyzer=path.join(f.root,'analyzer.dll');
 await fs.mkdir(path.join(installation,'host','fxr'),{recursive:true});await fs.mkdir(path.join(installation,'sdk'));await fs.writeFile(host,Buffer.from('7f454c460001','hex'),{mode:0o755});await fs.writeFile(analyzer,'analyzer');
 const first=await evaluationToolContext(host,analyzer,[f.directory]);assert.ok(first);assert.equal(first.root,await fs.realpath(installation));
 const previous=process.env.MsBuildCacheFileExistence;process.env.MsBuildCacheFileExistence='1';
 try{assert.equal(await evaluationToolContext(host,analyzer,[f.directory]),undefined,'process-global MSBuild existence caching bypasses per-project provenance');}
 finally{if(previous===undefined)delete process.env.MsBuildCacheFileExistence;else process.env.MsBuildCacheFileExistence=previous;}
 await fs.writeFile(host,Buffer.from('7f454c460002','hex'));assert.notEqual((await evaluationToolContext(host,analyzer,[f.directory])).key,first.key);
 const beforeAnalyzer=await evaluationToolContext(host,analyzer,[f.directory]);await fs.writeFile(analyzer,'changed');assert.notEqual((await evaluationToolContext(host,analyzer,[f.directory])).key,beforeAnalyzer.key);
 await fs.writeFile(host,'#!/bin/sh\necho wrapper\n');assert.equal(await evaluationToolContext(host,analyzer,[f.directory]),undefined);
});

test('captured SDK resolver binaries and adjacent dependencies invalidate same-path replacements',async t=>{
 const f=await fixture(t),crypto=require('node:crypto'),resolver=path.join(f.sdk,'Microsoft.Build.NuGetSdkResolver.dll'),dependency=path.join(f.sdk,'NuGet.Commands.dll');
 await fs.writeFile(resolver,'resolver-v1');await fs.writeFile(dependency,'dependency-v1');f.inputs[0].files.push(resolver,dependency);
 const hashes=async()=>Object.fromEntries(await Promise.all([resolver,dependency].map(async file=>[file,crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
 f.inputs[0].hashes=await hashes();await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,1);
 const time=await fs.stat(resolver);await fs.writeFile(resolver,'resolver-v2');await fs.utimes(resolver,time.atime,time.mtime);assert.equal((await f.get()).size,0);
 await f.cache.put(new Map([[f.file,f.graph]]),'context');assert.equal((await f.get()).size,0,'changed bytes cannot be attached to the graph evaluated before replacement');
 f.inputs[0].hashes=await hashes();await f.cache.put(new Map([[f.file,f.graph]]),'context');await fs.writeFile(dependency,'dependency-v2');assert.equal((await f.get()).size,0);
});
