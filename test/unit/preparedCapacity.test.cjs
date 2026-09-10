const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {PreparedOutputCache}=require('../../out/services/preparedOutputCache');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');
const {PreparedOutput,copyOutput}=require('../../out/services/output');

async function fixture(t,limits={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-capacity-')),source=path.join(root,'build'),storage=path.join(root,'state');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'binary');await fs.writeFile(path.join(source,'asset'),'original');
 const caches=[],active=new Set(),created=[];
 const cache=()=>{const value=new PreparedOutputCache(storage,randomUUID(),{...limits,persist:true});caches.push(value);return value;};
 const create=async directory=>{
  const template=path.join(directory,'template');await copyOutput(source,template);
  const output=new PreparedOutput(template,path.join(directory,'assembly'));await output.initialize();
  const artifact={root:directory,output,session:randomUUID(),coverage:true,instrumented:[],reusable:true};created.push(artifact);return artifact;
 };
 const acquire=async(cache,slot)=>{const lease=await cache.acquire(source,'same-context',create,undefined,`target/${slot}`);assert.ok(lease);active.add(lease);return lease;};
 const release=async lease=>{await lease.release();active.delete(lease);};
 t.after(async()=>{await Promise.allSettled([...active].map(lease=>lease.release(false)));for(const cache of caches)await cache.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,source,storage,cache,created,acquire,release};
}

test('a growing 31-worker pool retains isolated preparations across warm runs and clean restart',async t=>{
 const f=await fixture(t),cache=f.cache(),primary=await f.acquire(cache,0);await f.release(primary);
 // Exercise growth after the persistent owner was claimed at the old default.
 await cache.ensureCapacity(31);
 const slots=Array.from({length:31},(_,i)=>i),first=await Promise.all(slots.map(slot=>f.acquire(cache,slot)));
 assert.equal(new Set(first.map(lease=>lease.artifact.output.directory)).size,31);
 assert.equal(new Set(first.map(lease=>lease.artifact.session)).size,31);
 const sessions=first.map(lease=>lease.artifact.session),directories=first.map(lease=>lease.artifact.output.directory);
 await Promise.all(first.map(async(lease,index)=>{await fs.writeFile(path.join(lease.artifact.output.directory,'asset'),`test ${index}`);await f.release(lease);}));
 assert.equal(f.created.length,31);
 // A later smaller request cannot revoke capacity while another operation uses it.
 await cache.ensureCapacity(4);
 const warm=await Promise.all(slots.map(slot=>f.acquire(cache,slot)));
 assert.ok(warm.every(lease=>lease.hit));assert.equal(f.created.length,31);
 for(const lease of warm)assert.equal(await fs.readFile(path.join(lease.artifact.output.directory,'asset'),'utf8'),'original');
 await Promise.all(warm.map(f.release));await cache.dispose();
 const owners=(await fs.readdir(path.join(f.storage,'prepared-v2'))).filter(name=>name.endsWith('.owner.json'));
 assert.equal(owners.length,1);
 const owner=JSON.parse(await fs.readFile(path.join(f.storage,'prepared-v2',owners[0]),'utf8'));
 assert.equal(owner.state,'parked');assert.equal(owner.retention.entries,31);
 for(const directory of directories)await assert.rejects(fs.stat(directory),{code:'ENOENT'},'only pristine templates survive shutdown');
 const restarted=f.cache();await restarted.ensureCapacity(31);
 const restored=await Promise.all(slots.map(slot=>f.acquire(restarted,slot)));
 assert.ok(restored.every(lease=>lease.hit));assert.deepEqual(restored.map(lease=>lease.artifact.session),sessions);
 assert.deepEqual(restored.map(lease=>lease.artifact.output.directory),directories);assert.equal(f.created.length,31);
 await Promise.all(restored.map(f.release));
});

test('expanding the entry allowance preserves byte eviction and validates capacity requests',async t=>{
 const f=await fixture(t,{maxBytes:20}),cache=f.cache();
 for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(cache.ensureCapacity(value),/Invalid/);
 await cache.ensureCapacity(31);
 const first=await f.acquire(cache,0);await f.release(first);
 await assert.rejects(fs.stat(first.artifact.root),{code:'ENOENT'});
 const retry=await f.acquire(cache,0);assert.equal(retry.hit,false);await f.release(retry);
 await cache.dispose();assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared-v2')),[]);
 await assert.rejects(cache.ensureCapacity(64),/disposed/);
});

test('storage entry expansion keeps ownership transitions and its original byte bound',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-storage-capacity-')),storage=path.join(root,'prepared');
 const owners=[];t.after(async()=>{for(const owner of owners)await owner.dispose();await fs.rm(root,{recursive:true,force:true});});
 const first=await claimPreparedStorage(storage,undefined,{maxEntries:1,maxBytes:64});owners.push(first);
 for(const value of [-1,NaN,1.5])assert.throws(()=>first.reserveEntries(value),/Invalid/);
 first.reserveEntries(31);first.reserveEntries(1);
 await first.park({marker:'retained'},{entries:31,bytes:31});
 const next=await claimPreparedStorage(storage,undefined,{maxEntries:31,maxBytes:64});owners.push(next);
 assert.equal(next.directory,first.directory);assert.equal(next.snapshot.marker,'retained');
 await first.dispose();assert.ok(await fs.stat(next.directory),'old owner cannot delete its successor');
 next.reserveEntries(64);await next.park({marker:'oversized'},{entries:32,bytes:65});
 assert.deepEqual(await fs.readdir(storage),[],'more entry capacity never raises the byte allowance');
 assert.throws(()=>next.reserveEntries(128),/closed/);
});
