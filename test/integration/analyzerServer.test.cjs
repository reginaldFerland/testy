// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {AnalyzerServers}=require('../../out/services/analyzerServer');
const {runProcess}=require('../../out/services/process');
const {normalizePath}=require('../../out/core/paths');

const analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');

async function fixture(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy analyzer server ')));
 const servers=new AnalyzerServers();
 t.after(async()=>{await servers.dispose();await fs.rm(directory,{recursive:true,force:true});});
 const oneShot=async request=>{
  const input=path.join(directory,'one-shot-request.json'),output=path.join(directory,'one-shot-response.json');
  await fs.writeFile(input,request);
  const result=await runProcess('dotnet',[analyzer,input,output],{cwd:directory});
  assert.equal(result.code,0,result.stderr);
  return fs.readFile(output,'utf8');
 };
 const serve=(request,options={})=>servers.request('dotnet',analyzer,request,{cwd:directory,...options});
 return{directory,servers,oneShot,serve};
}

test('the server answers every request kind exactly like a one-shot process, including provenance and relative paths',{timeout:120000},async t=>{
 const {directory,oneShot,serve}=await fixture(t);
 const sources=[
  'namespace N; public partial class C { public int Value()=>1; }',
  'namespace N { [ExternalBlind] public partial class C {} }',
  'using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute; [Blind] public class Hidden { public int Value()=>2; }',
  'public class Mapped {\n#line 200 "Virtual.cs"\npublic int Value()=>3;\n#line default\n}',
  '// 秘密 😀\npublic class Unicode { public string Value()=>"é"; }',
  'public class Invalid {'
 ];
 const files=sources.map((_,index)=>normalizePath(path.join(directory,`Source${index}.cs`)));
 await Promise.all(files.map((file,index)=>fs.writeFile(file,sources[index])));
 await fs.writeFile(files[4],Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(sources[4])]));
 const aliasSource='global using 秘密 = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute; // <>& 😀';
 const requests=[
  {files:[...files,path.join(directory,'Missing.cs')],excludedAliases:['ExternalBlind'],concurrency:2},
  {files,excludedAliases:[],concurrency:1,provenance:true},
  {files,excludedAliases:['秘密'],aliasSources:[aliasSource],allFiles:files,concurrency:3,provenance:true},
  {files:files.slice(0,2),excludedAliases:[],aliasSources:[aliasSource],allFiles:files},
  {aliasSources:[aliasSource,'#if X\nglobal using Y = System.Diagnostics.DebuggerHiddenAttribute;\n#endif']},
  {assembly:analyzer},
  {files:[path.basename(files[0])],excludedAliases:[]}
 ];
 for(const request of requests){
  const text=JSON.stringify(request),expected=await oneShot(text);
  // Relative paths mean the same thing to both: the one-shot process runs in `directory`.
  assert.equal(await serve(text),expected,text.slice(0,120));
 }
 const provenance=JSON.parse(await serve(JSON.stringify(requests[2])));
 assert.equal(provenance.version,1);assert.deepEqual(provenance.aliases,['秘密']);
});

test('every request reads files afresh, so a long-lived server never serves stale results',{timeout:60000},async t=>{
 const {directory,serve}=await fixture(t);
 const file=normalizePath(path.join(directory,'Changing.cs'));
 const analyze=async()=>JSON.parse(await serve(JSON.stringify({files:[file],excludedAliases:[],provenance:true})));
 await fs.writeFile(file,'public class C { public int Value()=>1; }');
 const first=await analyze();
 await fs.writeFile(file,'public class C { public int Value()=>2; }');
 const body=await analyze();
 assert.notEqual(body.sourceHashes[file],first.sourceHashes[file]);
 assert.notEqual(body.analyses[file].body,first.analyses[file].body);
 assert.equal(body.analyses[file].signature,first.analyses[file].signature);
 await fs.writeFile(file,'public class C { public long Value()=>2; }');
 assert.notEqual((await analyze()).analyses[file].signature,first.analyses[file].signature);
 await fs.writeFile(file,'public class C {');
 const invalid=await analyze();
 assert.equal(invalid.analyses[file],null);assert.ok(invalid.sourceHashes[file]);
 await fs.rm(file);
 const missing=await analyze();
 assert.equal(missing.analyses[file],null);assert.equal(missing.sourceHashes[file],null);
});

test('cancelling a large request stops it promptly and leaves the server correct for the next one',{timeout:120000},async t=>{
 const {directory,oneShot,serve,servers}=await fixture(t);
 const body='public class C%N% { '+Array.from({length:400},(_,index)=>`public int M${index}(int x) { return x + ${index}; }`).join(' ')+' }';
 const files=await Promise.all(Array.from({length:600},async(_,index)=>{
  const file=normalizePath(path.join(directory,`Large${index}.cs`));await fs.writeFile(file,body.replace('%N%',String(index)));return file;
 }));
 const small=normalizePath(path.join(directory,'Small.cs'));await fs.writeFile(small,'public class Small { public int Value()=>1; }');
 const request=JSON.stringify({files:[small],excludedAliases:[],provenance:true});
 const expected=await oneShot(request);
 assert.equal(await serve(request),expected);
 for(let round=0;round<3;round++){
  const abort=new AbortController(),started=Date.now();
  const large=serve(JSON.stringify({files,excludedAliases:[],concurrency:1}),{signal:abort.signal});
  setTimeout(()=>abort.abort(),50);
  await assert.rejects(large,{name:'AbortError'});
  assert.ok(Date.now()-started<1000,'the caller is released at once');
  // Later requests wait behind no stale work and get exact answers.
  assert.equal(await serve(request),expected);
 }
 assert.equal(servers.size,1,'the cancelled work never required a new server');
});

test('a cancel message interrupts the running request by id and the server keeps serving',{timeout:120000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy analyzer cancel ')));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const body='public class C%N% { '+Array.from({length:400},(_,index)=>`public int M${index}(int x) { return x + ${index}; }`).join(' ')+' }';
 const files=await Promise.all(Array.from({length:300},async(_,index)=>{
  const file=normalizePath(path.join(directory,`Large${index}.cs`));await fs.writeFile(file,body.replace('%N%',String(index)));return file;
 }));
 const child=spawn('dotnet',[analyzer,'--server'],{stdio:['pipe','pipe','ignore']});
 t.after(()=>{child.kill();});
 const lines=[],waiters=[];
 let buffer='';
 child.stdout.setEncoding('utf8');
 child.stdout.on('data',text=>{
  buffer+=text;
  for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){lines.push(buffer.slice(0,end));buffer=buffer.slice(end+1);}
  while(waiters.length&&lines.length)waiters.shift()(lines.shift());
 });
 const next=()=>lines.length?Promise.resolve(lines.shift()):new Promise(resolve=>waiters.push(resolve));
 assert.match(await next(),/^\{"ready":1,/);
 const send=(id,request)=>child.stdin.write(`{"id":${id},"cwd":${JSON.stringify(directory)},"request":${JSON.stringify(request)}}\n`);
 send(1,{files,excludedAliases:[],concurrency:1});
 let started=Date.now();
 const finished=await next();
 const full=Date.now()-started;
 assert.match(finished,/^\{"id":1,"result":/);
 send(2,{files,excludedAliases:[],concurrency:1});
 await new Promise(resolve=>setTimeout(resolve,50));
 started=Date.now();child.stdin.write('{"cancel":2}\n');
 assert.equal(await next(),'{"id":2,"error":"cancelled"}');
 assert.ok(Date.now()-started<Math.max(500,full/2),`cancelled in ${Date.now()-started} ms; the full request takes ${full} ms`);
 // An unknown or finished id is ignored, a bad line does not end the server, and the next request is correct.
 child.stdin.write('{"cancel":99}\nnot json\n');
 send(3,{aliasSources:['global using A = System.Diagnostics.DebuggerHiddenAttribute;']});
 assert.equal(await next(),'{"id":3,"result":["A"]}');
});

test('the server exits when its input closes and keeps TieredPGO on for long-lived work',{timeout:60000},async t=>{
 const runtime=JSON.parse(await fs.readFile(analyzer.replace(/\.dll$/,'.runtimeconfig.json'),'utf8'));
 assert.equal(runtime.runtimeOptions.configProperties['System.Runtime.TieredPGO'],true);
 const child=spawn('dotnet',[analyzer,'--server'],{stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.kill();});
 const ready=await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',data=>resolve(String(data)));});
 assert.match(ready,/^\{"ready":1,"roslyn":"5\.\d+\.\d+\.\d+ from [^"]+"\}\n$/);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve([code,signal])));
 child.stdin.end();
 assert.deepEqual(await exited,[0,null]);
});
