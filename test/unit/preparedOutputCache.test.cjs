const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {PreparedOutputCache,outputManifest,preparationToolIdentity}=require('../../out/services/preparedOutputCache');
const {copyOutput,PreparedOutput}=require('../../out/services/output');
const outputTools=require('../../out/services/output');

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}

async function fixture(t,limits={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-prepared-cache-'))),source=path.join(root,'build'),storage=path.join(root,'storage');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'binary');await fs.writeFile(path.join(source,'asset'),'original');
 const cache=new PreparedOutputCache(storage,randomUUID(),limits),leases=[],created=[];
 const create=async directory=>{
  const template=path.join(directory,'template'),output=new PreparedOutput(template,path.join(directory,'assembly'));
  await copyOutput(source,template);await output.initialize();
  const artifact={root:directory,output,session:randomUUID(),coverage:true,instrumented:[],reusable:true};created.push(artifact);return artifact;
 };
 const acquire=async(context='context',prepare=create,signal,slot)=>{const lease=await cache.acquire(source,context,prepare,signal,slot);if(lease)leases.push(lease);return lease;};
 t.after(async()=>{for(const lease of leases)await lease.release();await cache.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,source,storage,cache,created,create,acquire};
}

test('cache reuses exclusively owned stable output and repairs mutations and transient reports',async t=>{
 const f=await fixture(t),first=await f.acquire();assert.equal(first.hit,false);
 const artifact=first.artifact;
 await fs.writeFile(path.join(artifact.output.directory,'asset'),'changed');await fs.writeFile(path.join(artifact.output.directory,'extra'),'result');
 await fs.writeFile(path.join(artifact.root,'coverage-1.xml'),'coverage');await fs.mkdir(path.join(artifact.root,'results-1'));
 await first.release();const second=await f.acquire();
 assert.equal(second.hit,true);assert.equal(second.artifact,artifact);assert.equal(f.created.length,1);
 assert.equal(await fs.readFile(path.join(artifact.output.directory,'asset'),'utf8'),'original');
 assert.deepEqual((await fs.readdir(artifact.root)).sort(),['assembly','template']);
 assert.deepEqual((await fs.readdir(artifact.output.directory)).sort(),['Tests.dll','asset']);
});

test('concurrent requests never share mutable outputs or instrumentation session IDs',async t=>{
 const f=await fixture(t),[first,second]=await Promise.all([f.acquire(),f.acquire()]);
 assert.notEqual(first.artifact.root,second.artifact.root);assert.notEqual(first.artifact.session,second.artifact.session);
 await first.release();const third=await f.acquire();assert.equal(third.hit,true);assert.equal(third.artifact,first.artifact);
 assert.notEqual(third.artifact,second.artifact);
});

test('exclusive upgrades retain the new template metadata, output repair baseline and cache byte accounting',async t=>{
 const f=await fixture(t,{maxEntries:16,maxBytes:128}),first=await f.acquire(),before=first.artifact;
 await fs.writeFile(path.join(before.output.template,'Tests.dll'),'instrumented');
 const output=new PreparedOutput(before.output.template,before.output.directory);await output.initialize();
 await first.update({...before,output,coveragePending:false});
 await fs.writeFile(path.join(output.directory,'Tests.dll'),'test mutation');await first.release();
 const next=await f.acquire();assert.equal(next.hit,true);assert.equal(next.artifact.output,output);
 assert.equal(await fs.readFile(path.join(output.directory,'Tests.dll'),'utf8'),'instrumented');
 await fs.writeFile(path.join(output.template,'Tests.dll'),'instrumented large output'.repeat(20));
 const larger=new PreparedOutput(output.template,output.directory);await larger.initialize();await next.update({...next.artifact,output:larger});
 await next.release();await assert.rejects(fs.stat(before.root),{code:'ENOENT'},'upgraded byte count enforces the retention bound');
});

test('release and disposal drain an in-flight upgrade, and later upgrades cannot touch a released lease',async t=>{
 const f=await fixture(t),first=await f.acquire(),entered=deferred(),finish=deferred(),hash=outputTools.fileHash;
 outputTools.fileHash=async(file,signal)=>{if(file===path.join(first.artifact.output.template,'Tests.dll')){entered.resolve();await finish.promise;}return hash(file,signal);};
 t.after(()=>{finish.resolve();outputTools.fileHash=hash;});
 const updating=first.update({...first.artifact,coveragePending:false});await entered.promise;
 let complete=false;const releasing=first.release(),disposing=f.cache.dispose().then(()=>{complete=true;});await delay(5);assert.equal(complete,false);
 await assert.rejects(first.update(first.artifact),/updating or releasing/);
 finish.resolve();await Promise.all([updating,releasing,disposing]);assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
});

test('an unverifiable upgraded template is discarded instead of retaining partially prepared output',async t=>{
 const f=await fixture(t),first=await f.acquire();await fs.rm(first.artifact.output.template,{recursive:true});
 await assert.rejects(first.update(first.artifact),{code:'ENOENT'});await first.release();
 await assert.rejects(fs.stat(first.artifact.root),{code:'ENOENT'});assert.equal((await f.acquire()).hit,false);
});

test('primary slots retain their exact path after invalidation and never reuse a secondary identity',async t=>{
 const f=await fixture(t),primary=await f.acquire('context',f.create,undefined,'target/primary');await primary.release();
 const secondary=await f.acquire('context',f.create,undefined,'target/secondary');await secondary.release();
 await fs.writeFile(path.join(f.source,'Tests.dll'),'rebuilt');
 const rebuilt=await f.acquire('context',f.create,undefined,'target/primary');
 assert.equal(rebuilt.hit,false);assert.equal(rebuilt.artifact.root,primary.artifact.root);assert.notEqual(rebuilt.artifact.session,primary.artifact.session);
 assert.notEqual(rebuilt.artifact.root,secondary.artifact.root);
 assert.equal(await f.acquire('context',f.create,undefined,'target/primary'),undefined,'an active output slot is exclusively owned');
 await rebuilt.release();const changed=await f.acquire('new tool/config',f.create,undefined,'target/primary');assert.equal(changed.artifact.root,primary.artifact.root);
});

test('complete manifest invalidates binaries, symbols, configs, assets, native modes and linked content',async t=>{
 const f=await fixture(t),linked=path.join(f.root,'linked');await fs.writeFile(linked,'linked-one');
 await fs.symlink(linked,path.join(f.source,'link'));
 for(const name of ['Tests.pdb','Tests.runtimeconfig.json','native'])await fs.writeFile(path.join(f.source,name),'first');
 let lease=await f.acquire();await lease.release();
 for(const name of ['Tests.dll','Tests.pdb','Tests.runtimeconfig.json','asset','native']){
  await fs.writeFile(path.join(f.source,name),'different');const next=await f.acquire();assert.equal(next.hit,false,name);await next.release();
 }
 const native=path.join(f.source,'native'),originalMode=(await fs.stat(native)).mode;
 // Windows exposes the writable bit, but does not implement POSIX execute bits.
 try{
  await fs.chmod(native,process.platform==='win32'?0o444:0o755);
  const changedMode=(await fs.stat(native)).mode;assert.notEqual(changedMode,originalMode,'fixture must make a real mode-only change');
  lease=await f.acquire();assert.equal(lease.hit,false,'a representable mode-only change invalidates preparation');
  assert.equal((await fs.stat(path.join(lease.artifact.output.directory,'native'))).mode,changedMode);
  await lease.release();
 }finally{await fs.chmod(native,originalMode);}
 lease=await f.acquire();assert.equal(lease.hit,true,'restoring the original mode can reuse the matching earlier preparation');
 assert.equal((await fs.stat(path.join(lease.artifact.output.directory,'native'))).mode,originalMode);await lease.release();
 await fs.writeFile(linked,'linked-two');lease=await f.acquire();assert.equal(lease.hit,false);await lease.release();
 lease=await f.acquire('new evaluated reference context');assert.equal(lease.hit,false);
 assert.equal(await fs.readFile(path.join(lease.artifact.output.directory,'link'),'utf8'),'linked-two');
 assert.equal((await fs.lstat(path.join(lease.artifact.output.directory,'link'))).isSymbolicLink(),false);
});

test('corrupt or missing templates become cache misses',async t=>{
 const f=await fixture(t),first=await f.acquire();await first.release();
 await fs.writeFile(path.join(first.artifact.output.template,'Tests.dll'),'corrupt');
 const second=await f.acquire();assert.equal(second.hit,false);assert.notEqual(second.artifact.root,first.artifact.root);
 await assert.rejects(fs.stat(first.artifact.root),{code:'ENOENT'});
 await second.release();await fs.rm(second.artifact.output.template,{recursive:true});
 assert.equal((await f.acquire()).hit,false);
});

test('LRU evicts idle entries under both entry and byte bounds, preserving active leases',async t=>{
 const f=await fixture(t,{maxEntries:1,maxBytes:1000}),first=await f.acquire('first');await first.release();
 const second=await f.acquire('second');await assert.rejects(fs.stat(first.artifact.root),{code:'ENOENT'});
 const third=await f.acquire('third');assert.ok(await fs.stat(second.artifact.root),'active second is retained');
 await third.release();await assert.rejects(fs.stat(third.artifact.root),{code:'ENOENT'});await second.release();
 assert.equal((await f.acquire('second')).hit,true);
 const bytes=await fixture(t,{maxEntries:100,maxBytes:1}),large=await bytes.acquire();await large.release();
 await assert.rejects(fs.stat(large.artifact.root),{code:'ENOENT'});assert.equal((await bytes.acquire()).hit,false);
});

test('failed eviction during admission still returns the new lease and does not strand disposal',async t=>{
 const f=await fixture(t,{maxEntries:1}),first=await f.acquire('first'),remove=outputTools.removeOutput;
 await first.release();let failed=false;
 outputTools.removeOutput=async directory=>{
  if(directory===first.artifact.root&&!failed){failed=true;throw new Error('controlled eviction failure');}
  return remove(directory);
 };
 t.after(()=>{outputTools.removeOutput=remove;});
 const second=await f.acquire('second');assert.equal(second.hit,false);assert.equal(failed,true);
 assert.ok(await fs.stat(first.artifact.root),'failed deletion remains tracked for a retry');
 await second.release();await f.cache.dispose();assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
});

test('failed unrelated eviction cannot remove a released artifact that another owner has reacquired',async t=>{
 const f=await fixture(t,{maxEntries:1}),first=await f.acquire('first'),remove=outputTools.removeOutput,entered=deferred(),finish=deferred();
 await first.release();let attempts=0;
 outputTools.removeOutput=async directory=>{
  if(directory===first.artifact.root&&++attempts<=2){
   if(attempts===2){entered.resolve();await finish.promise;}
   throw new Error('controlled eviction failure');
  }
  return remove(directory);
 };
 t.after(()=>{finish.resolve();outputTools.removeOutput=remove;});
 const second=await f.acquire('second'),releasing=second.release();await entered.promise;
 const active=await f.acquire('second');assert.equal(active.hit,true);assert.equal(active.artifact,second.artifact);
 await fs.writeFile(path.join(active.artifact.output.directory,'asset'),'active owner');finish.resolve();await releasing;
 assert.equal(await fs.readFile(path.join(active.artifact.output.directory,'asset'),'utf8'),'active owner');
 await active.release();await f.cache.dispose();assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
});

test('failed and partial preparations never enter the cache',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.acquire('context',async root=>{await fs.writeFile(path.join(root,'partial'),'incomplete');throw new Error('instrument failed');}),/instrument failed/);
 const partial=await f.acquire('context',async root=>({...await f.create(root),reusable:false}));await partial.release();
 await assert.rejects(fs.stat(partial.artifact.root),{code:'ENOENT'});
 const complete=await f.acquire();assert.equal(complete.hit,false);await complete.release(false);
 assert.equal((await f.acquire()).hit,false);
});

test('disposal waits for active owners, then removes its prepared tree and refuses later use',async t=>{
 const f=await fixture(t),lease=await f.acquire();let disposed=false;
 const disposal=f.cache.dispose().then(()=>{disposed=true;});await delay(5);assert.equal(disposed,false);assert.ok(await fs.stat(lease.artifact.root));
 await lease.release();await disposal;assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
 await assert.rejects(f.acquire(),/disposed/);
});

test('disposal also drains an eviction already removed from the in-memory inventory',async t=>{
 const f=await fixture(t,{maxEntries:0}),lease=await f.acquire(),entered=deferred(),finish=deferred(),remove=outputTools.removeOutput;
 outputTools.removeOutput=async directory=>{if(directory===lease.artifact.root){entered.resolve();await finish.promise;}return remove(directory);};
 t.after(()=>{finish.resolve();outputTools.removeOutput=remove;});
 const release=lease.release();await entered.promise;let disposed=false;
 const disposal=f.cache.dispose().then(()=>{disposed=true;});await delay(5);assert.equal(disposed,false);
 finish.resolve();await Promise.all([release,disposal]);assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
});

test('cancellation during preparation removes incomplete output before disposal completes',async t=>{
 const f=await fixture(t),control=new AbortController(),entered=deferred(),finish=deferred();
 const pending=f.acquire('context',async directory=>{
  const artifact=await f.create(directory);entered.resolve();await finish.promise;return artifact;
 },control.signal,'target/primary');
 const rejected=assert.rejects(pending,{name:'AbortError'});await entered.promise;control.abort();
 let disposed=false;const disposal=f.cache.dispose().then(()=>{disposed=true;});await delay(5);assert.equal(disposed,false);
 finish.resolve();await Promise.all([rejected,disposal]);assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);
});

test('unavailable cache storage falls back without executing the preparation callback',async t=>{
 const f=await fixture(t);await fs.writeFile(f.storage,'not a directory');
 assert.equal(await f.acquire(),undefined);assert.equal(f.created.length,0);
});

test('source changes during preparation prevent retaining a mismatched snapshot',async t=>{
 const f=await fixture(t),first=await f.acquire('context',async root=>{
  const result=await f.create(root);await fs.writeFile(path.join(f.source,'asset'),'new');return result;
 });await first.release();await assert.rejects(fs.stat(first.artifact.root),{code:'ENOENT'});
 assert.equal((await f.acquire()).hit,false);
});

test('tool identity follows PATH, executable bytes and .NET tool-store dependencies',async t=>{
 const f=await fixture(t),command=path.join(f.root,'collector');await fs.writeFile(command,'tool-v1',{mode:0o755});
 const store=path.join(f.root,'.store');await fs.mkdir(store);await fs.writeFile(path.join(store,'Collector.dll'),'v1');
 const env={PATH:f.root},first=await preparationToolIdentity('collector',env);
 assert.equal(await preparationToolIdentity(command,env),first);
 await fs.writeFile(command,'tool-v2');const second=await preparationToolIdentity(command,env);assert.notEqual(second,first);
 await fs.writeFile(path.join(store,'Collector.dll'),'v2');assert.notEqual(await preparationToolIdentity(command,env),second);
 await assert.rejects(preparationToolIdentity('absent',env),/Cannot identify/);
});

test('tool identity resolves relative commands and PATH against the actual project working directory',async t=>{
 const f=await fixture(t),project=path.join(f.root,'project'),bin=path.join(project,'bin'),shadow=path.join(project,'shadow');
 const name=process.platform==='win32'?'collector.exe':'collector';
 await fs.mkdir(bin,{recursive:true});await fs.mkdir(shadow);const command=path.join(bin,name);
 await fs.writeFile(command,'real executable',{mode:0o755});
 if(process.platform==='win32')await fs.mkdir(path.join(shadow,name));
 else await fs.writeFile(path.join(shadow,name),'not executable',{mode:0o644});
 const env={PATH:['shadow','bin'].join(path.delimiter),PATHEXT:'.EXE'},expected=await preparationToolIdentity(command,env);
 assert.equal(await preparationToolIdentity(`./bin/${name}`,env,undefined,project),expected);
 assert.equal(await preparationToolIdentity(path.join('.', 'bin',name),env,undefined,project),expected);
 assert.equal(await preparationToolIdentity('collector',env,undefined,project),expected);
});

test('one operation hashes the same resolved executable once across project directories and command aliases',async t=>{
 const f=await fixture(t),name=process.platform==='win32'?'collector.exe':'collector',command=path.join(f.root,name),alias=path.join(f.root,'alias');
 await fs.writeFile(command,'collector',{mode:0o755});await fs.symlink(command,alias);
 const left=path.join(f.root,'left'),right=path.join(f.root,'right');await fs.mkdir(left);await fs.mkdir(right);
 const hashes=[],hash=outputTools.fileHash;outputTools.fileHash=async(file,signal)=>{hashes.push(file);return hash(file,signal);};t.after(()=>{outputTools.fileHash=hash;});
 const identities=new Map(),env={PATH:f.root,PATHEXT:'.EXE'};
 const results=await Promise.all([
  preparationToolIdentity('collector',env,undefined,left,identities),preparationToolIdentity(`../${name}`,env,undefined,right,identities),
  preparationToolIdentity(path.join('..',name),env,undefined,right,identities),
  preparationToolIdentity(alias,env,undefined,left,identities)
 ]);
 assert.equal(new Set(results).size,1);assert.deepEqual(hashes,[command]);assert.equal(identities.size,1);
 await fs.writeFile(command,'new collector');assert.notEqual(await preparationToolIdentity(command,env,undefined,left,new Map()),results[0],'new operation revalidates bytes');
});

test('shared tool hashing preserves working-directory-specific relative PATH resolution',async t=>{
 const f=await fixture(t),identities=new Map(),results=[];
 for(const name of ['left','right']){
  const cwd=path.join(f.root,name);await fs.mkdir(path.join(cwd,'bin'),{recursive:true});
  await fs.writeFile(path.join(cwd,'bin','collector'),name,{mode:0o755});
  results.push(await preparationToolIdentity('collector',{PATH:'bin'},undefined,cwd,identities));
 }
 assert.notEqual(results[0],results[1]);assert.equal(identities.size,2);
});

test('custom managed tool identity includes its adjacent runtime and native dependency assets',async t=>{
 const f=await fixture(t),command=path.join(f.root,'collector');await fs.writeFile(command,'launcher',{mode:0o755});
 await fs.writeFile(path.join(f.root,'collector.deps.json'),JSON.stringify({targets:{net10:{Tool:{runtime:{'lib/net10/Dependency.dll':{}},native:{'runtimes/linux/native/libnative.so':{}}}}}}));
 await fs.writeFile(path.join(f.root,'Dependency.dll'),'managed-v1');await fs.writeFile(path.join(f.root,'libnative.so'),'native-v1');
 const first=await preparationToolIdentity(command,{});await fs.writeFile(path.join(f.root,'Dependency.dll'),'managed-v2');
 const second=await preparationToolIdentity(command,{});assert.notEqual(second,first);
 await fs.writeFile(path.join(f.root,'libnative.so'),'native-v2');assert.notEqual(await preparationToolIdentity(command,{}),second);
});

test('manifest hashes dereferenced content even with unchanged file size and rejects cycles',async t=>{
 const f=await fixture(t),first=await outputManifest(f.source);await fs.writeFile(path.join(f.source,'asset'),'mutated!');
 assert.notEqual((await outputManifest(f.source)).hash,first.hash);
 await fs.symlink(f.source,path.join(f.source,'cycle'));await assert.rejects(outputManifest(f.source),/cycle/);
});
