const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {PreparedOutputCache}=require('../../out/services/preparedOutputCache');
const {copyOutput,PreparedOutput}=require('../../out/services/output');

async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-persistent-output-'))),source=path.join(root,'build'),storage=path.join(root,'state');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'original module');await fs.writeFile(path.join(source,'asset'),'clean');
 const caches=[],leases=[],created=[];
 const cache=()=>{const result=new PreparedOutputCache(storage,randomUUID(),{persist:true});caches.push(result);return result;};
 const create=async directory=>{
  const output=new PreparedOutput(path.join(directory,'template'),path.join(directory,'assembly'));
  await copyOutput(source,output.template);await output.initialize();
  const artifact={root:directory,output,session:randomUUID(),coverage:true,instrumented:[path.join(output.directory,'Tests.dll')],reusable:true};
  created.push(artifact);return artifact;
 };
 const acquire=async(owner,context='context',signal)=>{const lease=await owner.acquire(source,context,create,signal,'target/primary');if(lease)leases.push(lease);return lease;};
 const record=async()=>{
  const directory=path.join(storage,'prepared-v2'),name=(await fs.readdir(directory)).find(name=>name.endsWith('.owner.json'));
  return{file:path.join(directory,name),value:JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))};
 };
 t.after(async()=>{await Promise.all(leases.map(lease=>lease.release()));await Promise.all(caches.map(cache=>cache.dispose()));await fs.rm(root,{recursive:true,force:true});});
 return{root,source,storage,cache,create,acquire,record,created};
}

test('clean cache handoff retains only templates and restores exact paths, session IDs and pristine assets',async t=>{
 const f=await fixture(t),first=f.cache(),lease=await f.acquire(first),artifact=lease.artifact;
 await fs.writeFile(path.join(artifact.output.directory,'asset'),'test mutation');await fs.writeFile(path.join(artifact.root,'coverage.xml'),'old coverage');
 await lease.release();await first.dispose();assert.deepEqual(await fs.readdir(artifact.root),['template']);
 const {value}=await f.record();assert.equal(value.state,'parked');assert.equal(value.retention.entries,1);
 assert.equal(JSON.stringify(value).includes('old coverage'),false);
 const next=await f.acquire(f.cache());assert.equal(next.hit,true);assert.equal(f.created.length,1);
 assert.equal(next.artifact.root,artifact.root);assert.equal(next.artifact.session,artifact.session);
 assert.deepEqual(next.artifact.instrumented,artifact.instrumented);
 assert.equal(await fs.readFile(path.join(next.artifact.output.directory,'asset'),'utf8'),'clean');
 await fs.writeFile(path.join(next.artifact.output.directory,'asset'),'second mutation');await next.release();
 assert.equal(await fs.readFile(path.join(next.artifact.output.directory,'asset'),'utf8'),'clean','adoption initializes the repair baseline');
});

test('active engines never adopt another engine’s collector session or mutable output',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first),second=f.cache(),b=await f.acquire(second);
 assert.notEqual(a.artifact.root,b.artifact.root);assert.notEqual(a.artifact.session,b.artifact.session);
 await a.release();await first.dispose();const third=f.cache(),c=await f.acquire(third);
 assert.equal(c.hit,true);assert.equal(c.artifact.root,a.artifact.root);assert.notEqual(c.artifact.root,b.artifact.root);
 await first.dispose();await fs.writeFile(path.join(c.artifact.output.directory,'asset'),'successor owns this');
 assert.equal(await fs.readFile(path.join(b.artifact.output.directory,'asset'),'utf8'),'clean');
});

test('changed output bytes and preparation contexts invalidate parked artifacts',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first);await a.release();await first.dispose();
 await fs.writeFile(path.join(f.source,'asset'),'rebuilt asset');const second=f.cache(),b=await f.acquire(second);
 assert.equal(b.hit,false);assert.equal(b.artifact.root,a.artifact.root);assert.notEqual(b.artifact.session,a.artifact.session);
 await b.release();await second.dispose();const c=await f.acquire(f.cache(),'different tools or environment');
 assert.equal(c.hit,false);assert.notEqual(c.artifact.session,b.artifact.session);
});

test('cancelled or failed artifact leases are discarded instead of parked',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first);await a.release(false);await first.dispose();
 assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared-v2')),[]);
 assert.equal((await f.acquire(f.cache())).hit,false);
});

test('corrupt metadata cannot redirect cache cleanup or execution outside its owned container',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first);await a.release();await first.dispose();
 const foreign=path.join(f.root,'foreign');await fs.mkdir(foreign);await fs.writeFile(path.join(foreign,'keep'),'untouched');
 const record=await f.record();record.value.snapshot.entries[0].directory='../../foreign';await fs.writeFile(record.file,JSON.stringify(record.value));
 const b=await f.acquire(f.cache());assert.equal(b.hit,false);
 assert.equal(await fs.readFile(path.join(foreign,'keep'),'utf8'),'untouched');
});

test('a corrupted or linked retained template is rejected before discovery or instrumentation',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first);await a.release();await first.dispose();
 const foreign=path.join(f.root,'foreign');await fs.rename(a.artifact.root,foreign);await fs.symlink(foreign,a.artifact.root,'dir');
 const next=f.cache(),b=await f.acquire(next);assert.equal(b.hit,false);
 assert.equal(await fs.readFile(path.join(foreign,'template','asset'),'utf8'),'clean');
 await b.release();await next.dispose();await fs.writeFile(path.join(b.artifact.output.template,'Tests.dll'),'corrupt module');
 assert.equal((await f.acquire(f.cache())).hit,false);
});

test('a failed preparation cleanup cannot leave untracked working output in a parked container',async t=>{
 const f=await fixture(t),first=f.cache(),a=await f.acquire(first);await a.release();
 const outputTools=require('../../out/services/output'),remove=outputTools.removeOutput;let orphan;
 outputTools.removeOutput=async directory=>{if(directory===orphan){outputTools.removeOutput=remove;throw new Error('controlled cleanup failure');}return remove(directory);};
 t.after(()=>{outputTools.removeOutput=remove;});
 await assert.rejects(first.acquire(f.source,'other',async directory=>{
  orphan=directory;await f.create(directory);await fs.writeFile(path.join(directory,'report.xml'),'private result');throw new Error('failed preparation');
 },undefined,'target/secondary'),/controlled cleanup failure/);
 assert.ok(await fs.stat(orphan));await first.dispose();
 await assert.rejects(fs.stat(orphan),{code:'ENOENT'});const {value}=await f.record();assert.equal(value.snapshot.entries.length,1);
 const reused=await f.acquire(f.cache());assert.equal(reused.hit,true);
});
