const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');
const {withLock}=require('../../out/services/lock');

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy prepared storage ')),storage=path.join(root,'prepared-v2');
 await fs.mkdir(storage);t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,storage};
}
const ownerFile=lease=>`${lease.directory}.owner.json`;
async function exists(file) {return fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});}
async function seed(storage,changes={}) {
 const identity=randomUUID(),directory=path.join(storage,identity);
 await fs.mkdir(directory);
 await fs.writeFile(directory+'.owner.json',JSON.stringify({version:1,identity,token:randomUUID(),pid:0,state:'parked',
  parkedAt:1,snapshot:{marker:identity},retention:{entries:1,bytes:1},...changes}));
 return directory;
}

test('clean parking transfers the same paths and snapshot once, and stale disposal cannot delete the successor',async t=>{
 const {storage}=await fixture(t),first=await claimPreparedStorage(storage);
 const template=path.join(first.directory,'template');await fs.mkdir(template);await fs.writeFile(path.join(template,'instrumented.dll'),'embedded session bytes');
 const snapshot={version:1,session:randomUUID(),entries:[{slot:'project/primary'}]};
 await first.park(snapshot,{entries:1,bytes:22});
 const next=await claimPreparedStorage(storage);
 assert.equal(next.directory,first.directory);assert.deepEqual(next.snapshot,snapshot);
 assert.equal(await fs.readFile(path.join(template,'instrumented.dll'),'utf8'),'embedded session bytes');
 const owner=JSON.parse(await fs.readFile(ownerFile(next),'utf8'));assert.equal(owner.state,'active');assert.equal(owner.pid,process.pid);
 await Promise.all([first.dispose(),first.park({stale:true},{entries:1,bytes:1})]);
 assert.deepEqual(JSON.parse(await fs.readFile(ownerFile(next),'utf8')),owner,'the previous lease has no authority over the adopted container');
 await next.dispose();await next.dispose();assert.deepEqual(await fs.readdir(storage),[]);
});

test('two concurrent claimants cannot share one instrumented session',async t=>{
 const {storage}=await fixture(t),first=await claimPreparedStorage(storage),session=randomUUID();
 await first.park({session},{entries:1,bytes:1});
 const leases=await Promise.all([claimPreparedStorage(storage),claimPreparedStorage(storage)]);
 assert.equal(new Set(leases.map(lease=>lease.directory)).size,2);
 assert.equal(leases.filter(lease=>lease.snapshot?.session===session).length,1);
 await Promise.all(leases.map(lease=>lease.dispose()));
});

test('every terminal mutation checks its exact owner token',async t=>{
 const {storage}=await fixture(t),lease=await claimPreparedStorage(storage);
 const successor={...JSON.parse(await fs.readFile(ownerFile(lease),'utf8')),token:randomUUID()};
 await fs.writeFile(ownerFile(lease),JSON.stringify(successor));
 await Promise.all([lease.park({stale:true},{entries:1,bytes:1}),lease.dispose()]);
 assert.ok(await exists(lease.directory));assert.deepEqual(JSON.parse(await fs.readFile(ownerFile(lease),'utf8')),successor);
});

test('dead active owners are discarded even with a previous snapshot, while live and unknown owners are preserved',async t=>{
 const {root,storage}=await fixture(t),ready=path.join(root,'ready'),live=await claimPreparedStorage(storage);
 const unknown=await seed(storage,{version:99}),broken=await seed(storage);
 await fs.writeFile(broken+'.owner.json','{partial');
 const script=`const fs=require('node:fs/promises');const {claimPreparedStorage}=require(${JSON.stringify(path.resolve('out/services/preparedStorage.js'))});(async()=>{const lease=await claimPreparedStorage(${JSON.stringify(storage)});await fs.writeFile(${JSON.stringify(ready)},lease.directory);setInterval(()=>{},1000);})();`;
 const child=spawn(process.execPath,['-e',script],{stdio:'ignore'});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let abandoned;for(let attempt=0;attempt<200;attempt++){try{abandoned=await fs.readFile(ready,'utf8');break;}catch{await delay(10);}}
 assert.ok(abandoned,'the child claimed its own active container');
 const record=JSON.parse(await fs.readFile(abandoned+'.owner.json','utf8'));
 await fs.writeFile(abandoned+'.owner.json',JSON.stringify({...record,snapshot:{stale:true},retention:{entries:1,bytes:1}}));
 const whileLive=await claimPreparedStorage(storage);assert.ok(await exists(abandoned));await whileLive.dispose();
 const stopped=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await stopped;
 const next=await claimPreparedStorage(storage);
 assert.equal(next.snapshot,undefined);assert.notEqual(next.directory,abandoned);assert.equal(await exists(abandoned),false);
 assert.ok(await exists(live.directory));assert.ok(await exists(unknown));assert.ok(await exists(broken));
 await Promise.all([live.dispose(),next.dispose()]);
});

test('malformed owned parked metadata is discarded without following root or owner symlinks',async t=>{
 const {root,storage}=await fixture(t),bad=await seed(storage,{retention:{entries:-1,bytes:1}}),missingSnapshot=await seed(storage,{snapshot:undefined});
 const external=path.join(root,'external');await fs.mkdir(external);await fs.writeFile(path.join(external,'asset'),'keep');
 const linked=await seed(storage);await fs.rmdir(linked);await fs.symlink(external,linked,process.platform==='win32'?'junction':'dir');
 const ownerLinked=await seed(storage),externalOwner=path.join(root,'external-owner');await fs.rename(ownerLinked+'.owner.json',externalOwner);
 await fs.symlink(externalOwner,ownerLinked+'.owner.json');
 const lease=await claimPreparedStorage(storage);
 assert.equal(lease.snapshot,undefined);assert.equal(await exists(bad),false);assert.equal(await exists(missingSnapshot),false);assert.equal(await exists(linked),false);
 assert.equal(await fs.readFile(path.join(external,'asset'),'utf8'),'keep');assert.ok(await exists(ownerLinked));assert.ok(await exists(externalOwner));
 await lease.dispose();
});

test('parked container entry limits apply globally and evict the oldest container without touching active owners',async t=>{
 const {storage}=await fixture(t),limits={maxEntries:3,maxBytes:100};
 const leases=await Promise.all(Array.from({length:4},()=>claimPreparedStorage(storage,undefined,limits)));
 await leases[0].park({name:'old'},{entries:2,bytes:2});
 const old=JSON.parse(await fs.readFile(ownerFile(leases[0]),'utf8'));await fs.writeFile(ownerFile(leases[0]),JSON.stringify({...old,parkedAt:1}));
 await leases[1].park({name:'middle'},{entries:1,bytes:2});await leases[2].park({name:'new'},{entries:1,bytes:2});
 assert.equal(await exists(leases[0].directory),false);assert.ok(await exists(leases[1].directory));assert.ok(await exists(leases[2].directory));
 assert.ok(await exists(leases[3].directory),'active containers are exempt from parked retention limits');
 await leases[3].dispose();
});

test('parked byte limits and disabled retention discard oversized containers',async t=>{
 const {storage}=await fixture(t),limits={maxEntries:10,maxBytes:3};
 const first=await claimPreparedStorage(storage,undefined,limits),second=await claimPreparedStorage(storage,undefined,limits);
 await first.park({name:'old'},{entries:1,bytes:2});
 const old=JSON.parse(await fs.readFile(ownerFile(first),'utf8'));await fs.writeFile(ownerFile(first),JSON.stringify({...old,parkedAt:1}));
 await second.park({name:'new'},{entries:1,bytes:2});assert.equal(await exists(first.directory),false);
 const next=await claimPreparedStorage(storage,undefined,limits);assert.equal(next.directory,second.directory);
 await next.park({tooLarge:true},{entries:1,bytes:4});assert.equal(await exists(next.directory),false);
 const disabled=await claimPreparedStorage(storage,undefined,{maxEntries:0,maxBytes:0});
 await disabled.park({unused:true},{entries:1,bytes:1});assert.deepEqual(await fs.readdir(storage),[]);
});

test('invalid retention and failed snapshot serialization leave disposal available',async t=>{
 const {storage}=await fixture(t);await assert.rejects(claimPreparedStorage(storage,undefined,{maxBytes:-1}),/Invalid/);
 const lease=await claimPreparedStorage(storage);
 await assert.rejects(lease.park({}, {entries:1,bytes:NaN}),/Invalid/);
 const cyclic={};cyclic.self=cyclic;await assert.rejects(lease.park(cyclic,{entries:1,bytes:1}),/circular/i);
 assert.equal(JSON.parse(await fs.readFile(ownerFile(lease),'utf8')).state,'active');
 await lease.dispose();assert.deepEqual(await fs.readdir(storage),[],'failed publication leaves no temporary metadata behind');
});

test('publication remains successful when temporary cleanup or later eviction fails',async t=>{
 const {storage}=await fixture(t),limits={maxEntries:1,maxBytes:10};
 const first=await claimPreparedStorage(storage,undefined,limits),second=await claimPreparedStorage(storage,undefined,limits);
 const originalRm=fs.rm;
 fs.rm=async(file,...args)=>{if(String(file).endsWith('.tmp'))throw new Error('temporary cleanup failed');return originalRm(file,...args);};
 try {await first.park({name:'old'},{entries:1,bytes:1});}finally{fs.rm=originalRm;}
 const old=JSON.parse(await fs.readFile(ownerFile(first),'utf8'));await fs.writeFile(ownerFile(first),JSON.stringify({...old,parkedAt:1}));
 const output=require('../../out/services/output'),remove=output.removeOutput;
 output.removeOutput=async directory=>{if(directory===first.directory)throw new Error('old eviction failed');return remove(directory);};
 try {await second.park({name:'new'},{entries:1,bytes:1});}finally{output.removeOutput=remove;}
 assert.equal(JSON.parse(await fs.readFile(ownerFile(second),'utf8')).state,'parked');
 const next=await claimPreparedStorage(storage,undefined,limits);
 assert.equal(next.directory,second.directory);assert.deepEqual(next.snapshot,{name:'new'});assert.equal(await exists(first.directory),false,'later claims retry deferred pruning');
 await Promise.all([first.dispose(),second.dispose()]);assert.ok(await exists(next.directory));await next.dispose();
});

test('oversized metadata is not loaded or published, and only recognized interrupted temporary files are reclaimed',async t=>{
 const {storage}=await fixture(t),oversized=await seed(storage);
 await fs.writeFile(oversized+'.owner.json',' '.repeat(4*1024*1024+1));
 const temporary=path.join(storage,`${randomUUID()}.${randomUUID()}.tmp`),unknown=path.join(storage,'unrecognized.tmp');
 await fs.writeFile(temporary,'partial');await fs.writeFile(unknown,'keep');
 const lease=await claimPreparedStorage(storage);
 assert.equal(lease.snapshot,undefined);assert.notEqual(lease.directory,oversized);assert.equal(await exists(temporary),false);
 assert.ok(await exists(unknown));assert.ok(await exists(oversized),'an unrecognizable owner is preserved');
 await assert.rejects(lease.park({large:'a'.repeat(4*1024*1024)},{entries:1,bytes:1}),/size limit/);
 assert.equal(JSON.parse(await fs.readFile(ownerFile(lease),'utf8')).state,'active');await lease.dispose();
});

test('cancelling a blocked claim cannot consume a parked container',async t=>{
 const {storage}=await fixture(t),first=await claimPreparedStorage(storage);await first.park({ready:true},{entries:1,bytes:1});
 let unlock,entered;const gate=new Promise(resolve=>unlock=resolve),ready=new Promise(resolve=>entered=resolve);
 const locked=withLock(`${storage}.lock`,undefined,async()=>{entered();await gate;});await ready;
 const abort=new AbortController(),claim=claimPreparedStorage(storage,abort.signal);abort.abort();
 try {await assert.rejects(claim,{name:'AbortError'});}finally{unlock();await locked;}
 const next=await claimPreparedStorage(storage);assert.equal(next.directory,first.directory);assert.deepEqual(next.snapshot,{ready:true});await next.dispose();
});
