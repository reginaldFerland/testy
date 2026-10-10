const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const {PreparedOutputCache}=require('../../out/services/preparedOutputCache');
const {PreparedOutput,copyOutput}=require('../../out/services/output');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');

// The source is 14 bytes, so a retained preparation costs 28: its template plus its working copy.
const footprint=28;
const sha=(/** @type {string} */ value)=>createHash('sha256').update(value).digest('hex');
/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-retention-'))),source=path.join(root,'build'),storage=path.join(root,'state');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'binary');await fs.writeFile(path.join(source,'asset'),'original');
 /** @type {any[]} */ const caches=[]; // caches are tagged with their (private) identity below, so they are typed any
 /** @type {Set<import('../../out/services/preparedOutputCache').PreparedArtifactLease>} */ const leases=new Set();
 const cache=(/** @type {import('../../out/services/preparedOutputCache').PreparedOutputLimits} */ limits={})=>{const identity=randomUUID(),value=new PreparedOutputCache(storage,identity,limits);caches.push(value);return /** @type {any} */ (Object.assign(value,{identity}));}; // the class keeps `identity` private; the tests read it
 const create=async(/** @type {string} */ directory)=>{
  const template=path.join(directory,'template'),output=new PreparedOutput(template,path.join(directory,'assembly'));
  await copyOutput(source,template);await output.initialize();
  return{root:directory,output,session:randomUUID(),coverage:true,instrumented:[],reusable:true};
 };
 const acquire=async(/** @type {PreparedOutputCache} */ cache,/** @type {string} */ slot)=>{const lease=await cache.acquire(source,'context',create,undefined,slot);assert.ok(lease);leases.add(lease);return lease;};
 const release=async(/** @type {import('../../out/services/preparedOutputCache').PreparedArtifactLease} */ lease)=>{await lease.release();leases.delete(lease);};
 const record=async()=>{
  const directory=path.join(storage,'prepared-v2'),name=/** @type {string} */ ((await fs.readdir(directory)).find(name=>name.endsWith('.owner.json')));
  return{directory:path.join(directory,name.slice(0,-'.owner.json'.length)),value:JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))};
 };
 t.after(async()=>{await Promise.allSettled([...leases].map(lease=>lease.release(false)));for(const value of caches)await value.dispose();await fs.rm(root,{recursive:true,force:true});});
 return{root,storage,cache,acquire,release,record};
}

test('parked retention is counted in the same units as the in-memory byte budget',async t=>{
 const f=await fixture(t),first=f.cache({persist:true,maxBytes:footprint});
 await f.release(await f.acquire(first,'target/0'));await first.dispose();
 const {value}=await f.record();
 assert.equal(value.state,'parked');assert.equal(value.retention.bytes,value.snapshot.entries[0].template.bytes*2);
 assert.equal(value.retention.bytes,footprint,'what the budget retained in memory is what is published, so the same budget holds across restarts');
 const second=f.cache({persist:true,maxBytes:footprint}),lease=await f.acquire(second,'target/0');
 assert.equal(lease.hit,true);await f.release(lease);
});

test('a container parked under a larger limit is trimmed oldest entry first by a session with a smaller one',async t=>{
 const f=await fixture(t),first=f.cache({persist:true,maxEntries:4}),slots=[0,1,2,3].map(index=>`target/${index}`);
 for(const slot of slots)await f.release(await f.acquire(first,slot));
 await first.dispose();
 const parked=await f.record();assert.equal(parked.value.retention.entries,4);
 const second=f.cache({persist:true,maxEntries:2}),newest=await f.acquire(second,slots[3]);
 assert.equal(newest.hit,true,'the container survives the smaller limit');
 const before=await f.record();assert.equal(before.directory,parked.directory,'the same container is adopted');
 assert.deepEqual((await fs.readdir(parked.directory)).sort(),[sha(slots[2]),sha(slots[3])].sort(),'only the two most recently used preparations remain');
 const next=await f.acquire(second,slots[2]);assert.equal(next.hit,true);
 await f.release(newest);await f.release(next);
 const older=await f.acquire(second,slots[0]);assert.equal(older.hit,false,'the oldest preparation was the one dropped');
 await f.release(older);
});

test('active leases that exceed the byte budget do not evict every idle preparation',async t=>{
 const f=await fixture(t),cache=f.cache({maxEntries:16,maxBytes:footprint*2-6});
 const slot=(/** @type {string} */ target,/** @type {number} */ lane)=>JSON.stringify([target,lane]),exists=(/** @type {string} */ file)=>fs.stat(file).then(()=>true,()=>false);
 const first=await f.acquire(cache,slot('a',0)),second=await f.acquire(cache,slot('b',0));
 // The two active leases alone exceed the budget.
 const lane0=await f.acquire(cache,slot('c',0));await f.release(lane0);
 assert.ok(await exists(lane0.artifact.root),'the newest idle preparation of a target survives');
 const lane1=await f.acquire(cache,slot('c',1));await f.release(lane1);
 assert.ok(await exists(lane1.artifact.root));assert.equal(await exists(lane0.artifact.root),false,'only one preparation per target is spared');
 const again=await f.acquire(cache,slot('c',1));assert.equal(again.hit,true);await f.release(again);
 // Once the pressure is gone the byte budget binds idle preparations again.
 await f.release(first);await f.release(second);
 const retained=(await fs.readdir(path.join(f.storage,'prepared',cache.identity))).length;
 assert.equal(retained,1,'two preparations do not fit the budget');
});

test('storage shrinks an oversized parked container through its owner’s hook and removes it whole when nothing fits',async t=>{
 const storage=path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-shrink-'))),'prepared');
 t.after(()=>fs.rm(path.dirname(storage),{recursive:true,force:true}));
 const exists=(/** @type {string} */ file)=>fs.lstat(file).then(()=>true,()=>false),names=[randomUUID(),randomUUID(),randomUUID()];
 // Snapshots list their entries oldest first; the hook keeps the newest that fit the target.
 const shrink=(/** @type {unknown} */ opaque,/** @type {import('../../out/services/preparedStorage').Retention} */ target)=>{
  const snapshot=/** @type {{names: string[]}} */ (opaque); // the hook receives the opaque payload this test parked
  const kept=snapshot.names.slice(Math.max(0,snapshot.names.length-target.entries));
  return kept.length?{snapshot:{names:kept},retention:{entries:kept.length,bytes:kept.length},removed:snapshot.names.slice(0,snapshot.names.length-kept.length)}:undefined;
 };
 const limits={maxEntries:2,maxBytes:100,shrink};
 const first=await claimPreparedStorage(storage,undefined,limits);
 for(const name of names)await fs.mkdir(path.join(first.directory,name));
 await first.park({names},{entries:3,bytes:3});
 assert.deepEqual((await fs.readdir(first.directory)).sort(),names.slice(1).sort(),'the oldest entry is dropped at publication');
 const next=await claimPreparedStorage(storage,undefined,limits);
 assert.equal(next.directory,first.directory);assert.deepEqual(next.snapshot,{names:names.slice(1)});
 await next.park({names:names.slice(1)},{entries:2,bytes:2});
 // A smaller limit than any entry set the hook can keep removes the container.
 const strict=await claimPreparedStorage(storage,undefined,{...limits,maxBytes:0,shrink:()=>undefined});
 assert.notEqual(strict.directory,first.directory);assert.equal(await exists(first.directory),false);
 await strict.dispose();
});
