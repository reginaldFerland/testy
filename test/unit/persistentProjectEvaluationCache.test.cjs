const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {ProjectEvaluationCache,evaluationInputs}=require('../../out/services/projectEvaluationCache');
const {readEvaluationSnapshot}=require('../../out/services/projectEvaluationStorage');
const {normalizePath}=require('../../out/core/paths');
const hash=value=>createHash('sha256').update(value).digest('hex');
const fileName='project-evaluations-v1.json';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

async function fixture(t,{count=1,limits}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-persistent-evaluation-'))),storage=path.join(root,'state');
 const directory=path.join(root,'app'),sdk=path.join(root,'sdks','10.0.100'),manifests=path.join(root,'sdk-manifests');
 await fs.mkdir(path.join(directory,'obj'),{recursive:true});await fs.mkdir(sdk,{recursive:true});await fs.mkdir(manifests);
 const files=Array.from({length:count},(_,index)=>path.join(directory,`P${index}.csproj`)),source=path.join(directory,'Code.cs'),imported=path.join(root,'settings.props');
 for(const file of files)await fs.writeFile(file,'<Project/>');await fs.writeFile(source,'class Code {}');await fs.writeFile(imported,'<Project/>');
 const resolver=path.join(sdk,'Microsoft.Build.NuGetSdkResolver.dll'),dependency=path.join(sdk,'NuGet.Commands.dll');
 await fs.writeFile(resolver,'resolver-v1');await fs.writeFile(dependency,'dependency-v1');
 const graph=files.map((file,index)=>({file,framework:'net10.0',assembly:path.join(directory,'bin',`P${index}.dll`),assemblyName:`P${index}`,isTestProject:true,isMtp:true,runner:'mtp',
  sourceFiles:[source],analysisFiles:[source],references:files.slice(index+1,index+2),binaryReferences:[],outputDirectories:[path.join(directory,'bin')],inputs:[imported],entryPoint:true,
  properties:{Configuration:'Debug'},contextId:`context-${index}`,contextReferences:index+1<count?[`context-${index+1}`]:[]}));
 const captured=[...files,imported,resolver,dependency],inputs=[{reusable:true,files:captured,hashes:Object.fromEntries(await Promise.all(captured.map(async file=>[file,hash(await fs.readFile(file))]))),
  queries:[{kind:'files',path:directory,pattern:'*.cs',recursive:false,values:[source]},
   {kind:'imports',path:path.join(directory,'obj'),pattern:'P0.csproj.*.props',recursive:false,values:[]},
   {kind:'files',path:manifests,pattern:'*',recursive:true,values:[]}],
  excludedDirectories:[path.join(directory,'bin'),path.join(directory,'obj')],sdkDirectory:sdk,reason:null}];
 evaluationInputs.set(graph,inputs);
 const instances=[],fresh=options=>{const cache=new ProjectEvaluationCache(storage,options??limits);instances.push(cache);return cache;};
 const cache=fresh();await cache.put(new Map(files.map(file=>[file,graph])),'context',t.signal);
 t.after(async()=>{for(const instance of instances)await instance.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,storage,directory,sdk,manifests,source,imported,resolver,dependency,files,file:files[0],graph,inputs,cache,fresh,
  snapshot:path.join(storage,fileName),get:(instance=fresh(),context='context',signal=t.signal)=>instance.get(files,context,signal)};
}

test('fresh cache instances validate complete persisted graphs and preserve metadata without restoring results',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.snapshot,'utf8');await f.cache.dispose();assert.equal(await fs.readFile(f.snapshot,'utf8'),before);
 const resumed=f.fresh(),loaded=(await f.get(resumed)).get(f.file);assert.deepEqual(loaded,f.graph);assert.notEqual(loaded,f.graph);
 assert.deepEqual(evaluationInputs.get(loaded),f.inputs);assert.equal((await f.get(resumed,'changed-tool-or-env-context')).size,0);
 await fs.writeFile(f.source,'class Changed {}');await fs.mkdir(path.join(f.directory,'bin'));await fs.writeFile(path.join(f.directory,'bin','Generated.cs'),'generated');
 assert.deepEqual((await f.get()).get(f.file),f.graph,'source contents are refreshed by Build; compile inventory is still unchanged');
 assert.equal(await fs.readFile(f.snapshot,'utf8'),before,'validated reads do not rewrite the shared candidate snapshot');
});

test('shared persisted tables roundtrip more than nine graph nodes and entry roots',async t=>{
 const f=await fixture(t,{count:14}),snapshot=JSON.parse(await fs.readFile(f.snapshot,'utf8'));
 assert.equal(snapshot.data.entries.length,14);assert.equal(snapshot.data.projects.length,14);assert.equal(snapshot.data.inputs.length,1,'shared SDK/input metadata is serialized once');
 const graphs=await f.get();assert.equal(graphs.size,14);for(const graph of graphs.values())assert.deepEqual(graph,f.graph);
});

test('normalized graph identities retain provenance from native path spellings',async t=>{
 const f=await fixture(t),file=normalizePath(f.file),graph=f.graph.map(project=>({...project,file}));evaluationInputs.set(graph,f.inputs);
 await f.cache.put(new Map([[file,graph]]),'native-paths',t.signal);
 const restored=await f.fresh().get([file],'native-paths',t.signal);assert.deepEqual(restored.get(file),graph);
 assert.equal((await readEvaluationSnapshot(f.storage)).entries.get(file).projectInputs[file],f.file);
});

test('linked project input spellings persist their original identity and invalidate when retargeted',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),alias=path.join(f.root,'Alias.csproj'),other=path.join(f.root,'Other.csproj');await fs.symlink(f.file,alias);
 const input={...f.inputs[0],files:f.inputs[0].files.map(file=>file===f.file?alias:file),hashes:{...f.inputs[0].hashes}};
 delete input.hashes[f.file];input.hashes[alias]=f.inputs[0].hashes[f.file];evaluationInputs.set(f.graph,[input]);
 await f.cache.put(new Map([[f.file,f.graph]]),'context',t.signal);assert.deepEqual((await f.get()).get(f.file),f.graph);
 assert.equal((await readEvaluationSnapshot(f.storage)).entries.get(f.file).projectInputs[f.file],alias);
 await fs.writeFile(other,'<Project/>');await fs.rm(alias);await fs.symlink(other,alias);assert.equal((await f.get()).size,0,'same bytes at a different canonical project are not equivalent provenance');
});

test('restarted validation detects source inventories, absent generated imports, configuration, SDK and resolver changes',async t=>{
 const f=await fixture(t),added=path.join(f.directory,'Added.cs'),generated=path.join(f.directory,'obj','P0.csproj.extra.props'),pin=path.join(f.root,'global.json');
 const originalSource=await fs.readFile(f.source),resolver=await fs.readFile(f.resolver),dependency=await fs.readFile(f.dependency),imported=await fs.readFile(f.imported);
 const time=await fs.stat(f.imported),manifest=path.join(f.manifests,'first.json'),nextSdk=path.join(path.dirname(f.sdk),'10.0.200');
 for(const [name,change,restore]of [
  ['source addition',()=>fs.writeFile(added,'class Added {}'),()=>fs.rm(added)],
  ['source deletion',()=>fs.rm(f.source),()=>fs.writeFile(f.source,originalSource)],
  ['new generated import',()=>fs.writeFile(generated,'<Project/>'),()=>fs.rm(generated)],
  ['same-time import contents',async()=>{await fs.writeFile(f.imported,'<Changed/>');await fs.utimes(f.imported,time.atime,time.mtime);},()=>fs.writeFile(f.imported,imported)],
  ['ancestor SDK pin',()=>fs.writeFile(pin,'{}'),()=>fs.rm(pin)],
  ['first workload manifest',()=>fs.writeFile(manifest,'{}'),()=>fs.rm(manifest)],
  ['new SDK installation',()=>fs.mkdir(nextSdk),()=>fs.rm(nextSdk,{recursive:true})],
  ['resolver replacement',()=>fs.writeFile(f.resolver,'resolver-v2'),()=>fs.writeFile(f.resolver,resolver)],
  ['resolver dependency replacement',()=>fs.writeFile(f.dependency,'dependency-v2'),()=>fs.writeFile(f.dependency,dependency)]
 ]){await change();assert.equal((await f.get()).size,0,name);await restore();assert.equal((await f.get()).size,1,`${name} restored exact evaluated inputs`);}
});

test('a saved graph is not reanchored to import bytes changed after the original evaluation',async t=>{
 const f=await fixture(t);await fs.writeFile(f.imported,'<Project><PropertyGroup><Changed>true</Changed></PropertyGroup></Project>');
 assert.equal((await f.get()).size,0);await f.cache.put(new Map([[f.file,f.graph]]),'context',t.signal);
 assert.equal((await f.get()).size,0);assert.equal(JSON.parse(await fs.readFile(f.snapshot,'utf8')).data.entries.length,0);
});

test('disk eligibility requires complete original captured hashes while legacy in-memory callers still work',async t=>{
 const f=await fixture(t);
 for(const inputs of [undefined,[{...f.inputs[0],reusable:false}],[{...f.inputs[0],hashes:undefined}],[{...f.inputs[0],hashes:{[f.file]:f.inputs[0].hashes[f.file]}}]]){
  if(inputs)evaluationInputs.set(f.graph,inputs);else evaluationInputs.delete(f.graph);
  await f.cache.put(new Map([[f.file,f.graph]]),'context',t.signal);
  assert.equal((await f.get()).size,0,'unsupported or incompletely captured entries never survive a new instance');
 }
 evaluationInputs.set(f.graph,[{...f.inputs[0],hashes:undefined}]);const memory=new ProjectEvaluationCache();
 await memory.put(new Map([[f.file,f.graph]]),'legacy',t.signal);assert.equal((await memory.get([f.file],'legacy',t.signal)).get(f.file),f.graph);
});

test('corrupt and unsupported schemas are retryable misses, including valid-checksum malformed graphs and queries',async t=>{
 const f=await fixture(t),original=await fs.readFile(f.snapshot,'utf8'),cache=f.fresh();
 const corruptions=[
  value=>{value.version=999;},value=>{value.epoch='invalid';},value=>{value.data.entries[0].graph=[999];},
  value=>{value.data.projects[0].sourceFiles=['../escape.cs'];},value=>{value.data.projects[0].runner='vstest';},
  value=>{value.data.projects[0].contexts=[null];},value=>{value.data.inputs[0].queries[0].pattern='*.c?';},
  value=>{value.data.projects[0].contexts=[{...value.data.projects[0],file:path.join(f.root,'Uncaptured.csproj')}];},
  value=>{delete value.data.inputs[0].hashes[f.file];},value=>{value.data.inputs[0].hashes[f.file]='bad';},
  value=>{value.data.inputs[0].queries[0].values=[false];},value=>{value.data.projects[0].unknownBehavior='unsupported';},
  value=>{value.data.entries.push(value.data.entries[0]);},value=>{value.data.entries[0].file=path.join(f.directory,'Absent.csproj');}
 ];
 await fs.writeFile(f.snapshot,'{truncated');assert.equal((await f.get(cache)).size,0);
 for(const corrupt of corruptions){const value=JSON.parse(original);corrupt(value);value.checksum=hash(JSON.stringify(value.data));await fs.writeFile(f.snapshot,JSON.stringify(value));assert.equal((await f.get(cache)).size,0);}
 const altered=JSON.parse(original);altered.data.projects[0].assembly=path.join(f.directory,'Unexpected.dll');
 await fs.writeFile(f.snapshot,JSON.stringify(altered));assert.equal((await f.get(cache)).size,0,'checksum covers graph contents as well as the stored validation stamp');
 await fs.writeFile(f.snapshot,original);assert.deepEqual((await f.get(cache)).get(f.file),f.graph,'a later corrected snapshot is retried');
});

test('oversize and linked snapshot files miss without following their targets',async t=>{
 const f=await fixture(t),original=await fs.readFile(f.snapshot);await fs.truncate(f.snapshot,32*1024*1024+1);
 assert.equal((await f.get()).size,0);await fs.writeFile(f.snapshot,original);
 if(process.platform!=='win32'){
  const outside=path.join(f.root,'outside.json');await fs.writeFile(outside,original);await fs.rm(f.snapshot);await fs.symlink(outside,f.snapshot);
  assert.equal((await f.get()).size,0);await f.cache.dispose();assert.deepEqual(await fs.readFile(outside),original);await fs.rm(f.snapshot);await fs.writeFile(f.snapshot,original);
 }
 assert.equal((await f.get()).size,1);
});

test('cancelled and unreadable lazy loads publish no candidates and can retry on the same instance',async t=>{
 const f=await fixture(t),cache=f.fresh(),open=fs.open,abort=new AbortController();let reads=0;
 fs.open=async function(file,...args){const handle=await open.call(this,file,...args);if(String(file)===f.snapshot){const read=handle.read.bind(handle);handle.read=async(...args)=>{reads++;const result=await read(...args);abort.abort();return result;};}return handle;};
 try{await assert.rejects(f.get(cache,'context',abort.signal),{name:'AbortError'});}finally{fs.open=open;}
 assert.ok(reads);assert.equal(cache.entries.size,0);assert.deepEqual((await f.get(cache)).get(f.file),f.graph);
 const retry=f.fresh();fs.open=async function(file,...args){if(String(file)===f.snapshot)throw Object.assign(new Error('controlled unreadable cache'),{code:'EACCES'});return open.call(this,file,...args);};
 try{assert.equal((await f.get(retry)).size,0);}finally{fs.open=open;}
 assert.equal((await f.get(retry)).size,1);
});

test('persisted entry and byte limits retain recent admissible roots without discarding in-memory evaluations',async t=>{
 const f=await fixture(t,{count:3,limits:{maxEntries:2}}),snapshot=JSON.parse(await fs.readFile(f.snapshot,'utf8'));
 assert.equal(snapshot.data.entries.length,2);assert.deepEqual(snapshot.data.entries.map(entry=>entry.file),f.files.slice(1));
 assert.equal((await f.get(f.cache)).size,3,'persistence limits do not narrow the evaluated build graph');assert.equal((await f.get()).size,2);
 const small=f.fresh({maxBytes:512});await small.put(new Map([[f.file,f.graph]]),'context',t.signal);
 assert.ok((await fs.stat(f.snapshot)).size<=512);assert.equal((await f.get()).size,0,'oversize roots simply miss the disk cache');
});

test('retain before lazy loading and clean disposal cannot resurrect removed entry roots',async t=>{
 const f=await fixture(t,{count:2}),cache=f.fresh();cache.retain([f.files[1]]);
 const result=await f.get(cache);assert.deepEqual([...result.keys()],[f.files[1]]);await cache.dispose();
 assert.deepEqual([...((await readEvaluationSnapshot(f.storage)).entries.keys())],[f.files[1]]);
 const untouched=path.join(f.root,'untouched'),empty=new ProjectEvaluationCache(untouched);await empty.dispose();await assert.rejects(fs.stat(untouched),{code:'ENOENT'});
});

test('failed and cancelled snapshot publication leaves the prior complete epoch readable and removes own temporaries',async t=>{
 const f=await fixture(t),original=await fs.readFile(f.snapshot,'utf8'),write=fs.writeFile,rename=fs.rename,abort=new AbortController();
 const graph=f.graph.map(project=>({...project,assemblyName:'Updated'}));evaluationInputs.set(graph,f.inputs);
 fs.writeFile=async function(file,...args){const result=await write.call(this,file,...args);if(String(file).startsWith(f.snapshot+'.')&&String(file).endsWith('.tmp'))abort.abort();return result;};
 try{await assert.rejects(f.cache.put(new Map([[f.file,graph]]),'context',abort.signal),{name:'AbortError'});}finally{fs.writeFile=write;}
 assert.equal(await fs.readFile(f.snapshot,'utf8'),original);assert.ok((await fs.readdir(f.storage)).every(file=>!file.endsWith('.tmp')));
 fs.rename=async function(from,to){if(String(to)===f.snapshot)throw Object.assign(new Error('controlled rename failure'),{code:'EACCES'});return rename.call(this,from,to);};
 try{await f.cache.put(new Map([[f.file,graph]]),'context',t.signal);}finally{fs.rename=rename;}
 assert.equal(await fs.readFile(f.snapshot,'utf8'),original);await f.cache.dispose();
 assert.notEqual(JSON.parse(await fs.readFile(f.snapshot,'utf8')).epoch,JSON.parse(original).epoch);assert.deepEqual((await f.get()).get(f.file),graph);
});

test('concurrent snapshot writers publish complete epochs and older candidates still require current input validation',async t=>{
 const f=await fixture(t),a=f.fresh(),b=f.fresh();await Promise.all([f.get(a),f.get(b)]);
 await Promise.all([a.put(new Map([[f.file,f.graph]]),'first',t.signal),b.put(new Map([[f.file,f.graph]]),'second',t.signal)]);
 const saved=await fs.readFile(f.snapshot,'utf8'),snapshot=await readEvaluationSnapshot(f.storage);assert.equal(snapshot.entries.size,1);assert.ok(['first','second'].includes(snapshot.entries.get(f.file).context));
 assert.equal((await f.get(f.fresh(),snapshot.entries.get(f.file).context)).size,1);await assert.rejects(fs.stat(f.snapshot+'.lock'),{code:'ENOENT'});
 // A second window can republish a previously admitted candidate, but it must
 // never bind that graph to newly read import bytes on restart.
 await fs.writeFile(f.imported,'<Project><PropertyGroup><New>true</New></PropertyGroup></Project>');
 a.retain([]);await a.dispose();assert.equal((await f.get()).size,0);
 // Rewrite the exact earlier valid snapshot to model an old concurrent writer.
 await fs.writeFile(f.snapshot,saved);
 assert.equal((await f.get(f.fresh(),snapshot.entries.get(f.file).context)).size,0,'saved epochs and stamps cannot validate changed import bytes');
 assert.equal((await b.get([f.file],'second',t.signal)).size,0);
});

test('retirement during validation cannot return a removed graph',async t=>{
 const f=await fixture(t),read=fs.readFile,entered=deferred(),resume=deferred();let gated=false;
 fs.readFile=async function(file,...args){const bytes=await read.call(this,file,...args);if(String(file)===f.imported&&!gated){gated=true;entered.resolve();await resume.promise;}return bytes;};
 try{
  const pending=f.get(f.cache);await entered.promise;f.cache.retain([]);resume.resolve();assert.equal((await pending).size,0);
 }finally{resume.resolve();fs.readFile=read;}
 await f.cache.dispose();assert.equal((await f.get()).size,0);
});

test('a slower earlier admission cannot replace or persist a newer graph for the same root',async t=>{
 const f=await fixture(t),read=fs.readFile,entered=deferred(),resume=deferred();let gated=false;
 const earlier=f.graph.map(project=>({...project,assemblyName:'Earlier'})),later=f.graph.map(project=>({...project,assemblyName:'Later'}));evaluationInputs.set(earlier,f.inputs);evaluationInputs.set(later,f.inputs);
 fs.readFile=async function(file,...args){const bytes=await read.call(this,file,...args);if(String(file)===f.imported&&!gated){gated=true;entered.resolve();await resume.promise;}return bytes;};
 try{
  const pending=f.cache.put(new Map([[f.file,earlier]]),'context',t.signal);await entered.promise;
  await f.cache.put(new Map([[f.file,later]]),'context',t.signal);resume.resolve();await pending;
 }finally{resume.resolve();fs.readFile=read;}
 assert.deepEqual((await f.get(f.cache)).get(f.file),later);assert.deepEqual((await f.get()).get(f.file),later);
 assert.equal(f.cache.replacements.size,0,'completed admissions retain no unbounded per-file tombstones');
});

test('one cancelled lazy reader cannot discard a parallel successful load',async t=>{
 const f=await fixture(t),cache=f.fresh(),open=fs.open,entered=deferred(),resume=deferred(),abort=new AbortController();let gated=false;
 fs.open=async function(file,...args){const handle=await open.call(this,file,...args);
  if(String(file)===f.snapshot&&!gated){gated=true;const read=handle.read.bind(handle);let waited=false;handle.read=async(...args)=>{const result=await read(...args);if(!waited){waited=true;entered.resolve();await resume.promise;}return result;};}return handle;
 };
 try{
  const pending=f.get(cache,'context',abort.signal);void pending.catch(()=>undefined);await entered.promise;
  assert.deepEqual((await f.get(cache)).get(f.file),f.graph);abort.abort();resume.resolve();await assert.rejects(pending,{name:'AbortError'});
 }finally{resume.resolve();fs.open=open;}
 assert.deepEqual((await f.get(cache)).get(f.file),f.graph);
});

test('completed root validations are filtered if retired or superseded while another root is pending',async t=>{
 for(const mutation of ['retire','replace']){
  const f=await fixture(t,{count:2}),secondImport=path.join(f.root,'second.props');await fs.writeFile(secondImport,'<Project/>');
  const first=[{...f.graph[0],references:[],contextReferences:[]}],second=[{...f.graph[1],references:[],contextReferences:[]}];
  const inputFor=(file,imported)=>[{...f.inputs[0],files:[file,imported],hashes:{[file]:hash('<Project/>'),[imported]:hash('<Project/>')}}];
  const firstInputs=inputFor(f.files[0],f.imported);evaluationInputs.set(first,firstInputs);evaluationInputs.set(second,inputFor(f.files[1],secondImport));
  await f.cache.put(new Map([[f.files[0],first],[f.files[1],second]]),'context',t.signal);
  const read=fs.readFile,list=fs.readdir,entered=deferred(),firstInventory=deferred(),resume=deferred();let gated=false;
  fs.readFile=async function(file,...args){const bytes=await read.call(this,file,...args);if(String(file)===secondImport&&!gated){gated=true;entered.resolve();await resume.promise;}return bytes;};
  fs.readdir=async function(directory,...args){const result=await list.call(this,directory,...args);if(String(directory)===path.dirname(f.sdk))firstInventory.resolve();return result;};
  let newer;
  try{
   const pending=f.get(f.cache);void pending.catch(()=>undefined);
   await Promise.race([Promise.all([entered.promise,firstInventory.promise]),pending.then(()=>{throw new Error('validation completed before its controlled sibling barrier');})]);
   // SDK inventory is the first root's final I/O; drain its completion
   // microtasks so it has entered the result before the second root finishes.
   await new Promise(resolve=>setImmediate(resolve));
   if(mutation==='retire')f.cache.retain([f.files[1]]);
   else{
    newer=first.map(project=>({...project,assemblyName:'Newer'}));evaluationInputs.set(newer,firstInputs);
    await f.cache.put(new Map([[f.files[0],newer]]),'context',t.signal);
   }
   resume.resolve();assert.deepEqual([...(await pending).keys()],[f.files[1]],mutation);
  }finally{resume.resolve();fs.readFile=read;fs.readdir=list;}
  const next=await f.cache.get([f.files[0]],'context',t.signal);
  if(mutation==='retire')assert.equal(next.size,0);else assert.deepEqual(next.get(f.files[0]),newer);
 }
});

test('cancellation after an atomic snapshot rename still reaches the admission caller',async t=>{
 const f=await fixture(t),before=JSON.parse(await fs.readFile(f.snapshot,'utf8')),rename=fs.rename,abort=new AbortController();
 const graph=f.graph.map(project=>({...project,assemblyName:'Committed'}));evaluationInputs.set(graph,f.inputs);
 fs.rename=async function(from,to){const result=await rename.call(this,from,to);if(String(to)===f.snapshot)abort.abort();return result;};
 try{await assert.rejects(f.cache.put(new Map([[f.file,graph]]),'context',abort.signal),{name:'AbortError'});}
 finally{fs.rename=rename;}
 const after=JSON.parse(await fs.readFile(f.snapshot,'utf8'));assert.notEqual(after.epoch,before.epoch,'a complete durable candidate may remain after the commit boundary');
 assert.deepEqual((await f.get()).get(f.file),graph,'the committed candidate still requires normal validation on a new instance');
 assert.ok((await fs.readdir(f.storage)).every(file=>!file.endsWith('.tmp')));
});
