const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage');
const {contentHash}=require('../../out/core/paths'),{defaultCacheLimits}=require('../../out/services/cacheFormat');
// Saves between maintenance sweeps; production sweeps every 128, which only makes these tests slower.
const every=16;
/** @typedef {{id:string,file:string,hash:string,lines:number[]}} Source */
/** @type {(index:number,hash?:string,lines?:number[])=>Source} */
const source=(index,hash='v1',lines=[1,2])=>{const file=`/Source${index}.cs`;return{id:contentHash(`${file}\0${hash}`),file,hash,lines};};
/** @type {(groupId:string,sources:Source[],timestamp?:number)=>any} */
const trace=(groupId,sources,timestamp=1)=>({groupId,timestamp,reliable:true,stale:false,
 dependencies:sources.map(source=>source.file),inputs:Object.fromEntries(sources.map(source=>[source.file,source.hash])),
 sourceIds:sources.map(source=>source.id),coverage:sources.map(source=>({file:source.file,hash:source.hash,lines:[{line:1,hits:timestamp}]}))});
/** @param {Source[]} sources @param {any[]} [traces] @param {string[]} [removedTraces] */
const delta=(sources,traces=[],removedTraces=[])=>({sources,traces,removedSources:[],removedTraces});
/** @param {import('node:test').TestContext} t @param {Partial<import('../../out/services/cacheFormat').CacheLimits>} [limits] */
async function fixture(t,limits){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-cache-corruption-test-')),directory=path.join(root,'coverage-v3'),warnings=/** @type {string[]} */ ([]);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return{root,directory,warnings,cache:new CoverageCache(root,text=>warnings.push(text),{...defaultCacheLimits,maintenanceSaves:every,...limits}),
  sourceFile:(/** @type {Source} */ source)=>path.join(directory,'sources',`${source.id}.json`),traceFile:(/** @type {string} */ id)=>path.join(directory,'traces',`${contentHash(id)}.json`),
  /** @param {string} id @param {number} seconds */
  async age(id,seconds){const time=new Date(Date.now()-seconds*1000);await fs.utimes(path.join(directory,'traces',`${contentHash(id)}.json`),time,time);}};
}
/** @param {string} file */
const missing=file=>assert.rejects(fs.stat(file),{code:'ENOENT'});
const unreadableTrace=`${'a'.repeat(64)}.json`;

test('corrupt records are discarded at restore so pruning proceeds over the valid set',async t=>{
 const f=await fixture(t),a=source(0),b=source(1),orphan=source(2);
 await f.cache.save(delta([a,b,orphan],[trace('good',[a]),trace('uses-b',[b])]),t.signal);
 await fs.writeFile(f.sourceFile(b),'{broken');
 await fs.writeFile(path.join(f.directory,'traces',unreadableTrace),'{broken');
 const store=new CoverageStore();await f.cache.restore(store,t.signal);
 assert.deepEqual([...store.traces.keys()],['good']);
 assert.ok(f.warnings.some(text=>text.includes('corrupt')));
 // The corrupt source and the trace that depended on it are gone; geometry nothing uses is pruned.
 await missing(f.sourceFile(b));await missing(f.traceFile('uses-b'));await missing(path.join(f.directory,'traces',unreadableTrace));await missing(f.sourceFile(orphan));
 await fs.access(f.sourceFile(a));await fs.access(f.traceFile('good'));
 // The lost trace is learned again from the next save.
 await f.cache.save(delta([b],[trace('uses-b',[b])]),t.signal);
 const again=new CoverageStore();await f.cache.restore(again,t.signal);assert.deepEqual([...again.traces.keys()].sort(),['good','uses-b']);
});

test('corrupt records found by periodic maintenance no longer stop pruning',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1);
 await f.cache.save(delta([a],[trace('good',[a])]),t.signal);await f.cache.save(delta([orphan]),t.signal);
 await fs.writeFile(path.join(f.directory,'traces',unreadableTrace),'{broken');
 for(let index=0;index<every;index++)await f.cache.save(delta([],[trace('tick',[])]),t.signal);
 await missing(path.join(f.directory,'traces',unreadableTrace));await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));
 assert.ok(f.warnings.some(text=>text.includes('corrupt')));
});

test('a corrupt record that cannot be removed leaves pruning for a later pass',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1);
 await f.cache.save(delta([a],[trace('good',[a])]),t.signal);await f.cache.save(delta([orphan]),t.signal);
 const broken=path.join(f.directory,'traces',unreadableTrace);await fs.writeFile(broken,'{broken');
 const remove=fs.rm;fs.rm=async function(file,...args){if(String(file)===broken){throw Object.assign(new Error('controlled failure'),{code:'EPERM'});}return remove.call(this,file,...args);};
 try{await f.cache.restore(new CoverageStore(),t.signal);}finally{fs.rm=remove;}
 await fs.access(f.sourceFile(orphan));await fs.access(broken);
 await f.cache.restore(new CoverageStore(),t.signal);
 await missing(f.sourceFile(orphan));await missing(broken);
});

test('restore keeps the newest traces within its limit and discards the oldest with their geometry',async t=>{
 const f=await fixture(t,{maxTraces:2,maxBytes:1e9}),sources=[0,1,2,3].map(index=>source(index));
 await f.cache.save(delta(sources,sources.map((value,index)=>trace(`t${index}`,[value],index+1))),t.signal);
 for(let index=0;index<4;index++)await f.age(`t${index}`,(4-index)*100);
 const store=new CoverageStore();await f.cache.restore(store,t.signal);
 assert.deepEqual([...store.traces.keys()].sort(),['t2','t3']);
 assert.ok(f.warnings.some(text=>/oldest coverage cache traces/.test(text)));
 for(const index of [0,1]){await missing(f.traceFile(`t${index}`));await missing(f.sourceFile(sources[index]));}
 for(const index of [2,3]){await fs.access(f.traceFile(`t${index}`));await fs.access(f.sourceFile(sources[index]));}
});

test('maintenance bounds the cache that saves accumulate, evicting the least recently saved trace',async t=>{
 const f=await fixture(t,{maxTraces:3,maxBytes:1e9}),sources=[0,1,2,3,4].map(index=>source(index));
 await f.cache.restore(new CoverageStore(),t.signal);
 for(const [index,value] of sources.entries())await f.cache.save(delta([value],[trace(`t${index}`,[value],index+1)]),t.signal);
 // Saving t0 again makes it the most recent.
 await f.cache.save(delta([],[trace('t0',[sources[0]],9)]),t.signal);
 for(let index=0;index<every;index++)await f.cache.save(delta([],[trace('t0',[sources[0]],9)]),t.signal);
 const names=(await fs.readdir(path.join(f.directory,'traces'))).sort();
 assert.deepEqual(names,['t0','t3','t4'].map(id=>`${contentHash(id)}.json`).sort());
 for(const index of [1,2]){await missing(f.sourceFile(sources[index]));}
 for(const index of [0,3,4]){await fs.access(f.sourceFile(sources[index]));}
});

test('records are flushed to disk before they are published',async t=>{
 const f=await fixture(t),a=source(0),events=/** @type {string[]} */ ([]);
 const open=fs.open,rename=fs.rename;
 fs.open=async function(file,...args){const handle=await open.call(this,file,...args);
  if(String(file).endsWith('.tmp')){const sync=handle.sync;handle.sync=function(...a){events.push(`sync ${path.basename(path.dirname(String(file)))}`);return sync.apply(this,a);};}
  else if(args[0]==='r'){events.push('open directory');}
  return handle;};
 fs.rename=function(from,to){events.push(`rename ${path.basename(path.dirname(String(to)))}`);return rename.call(this,from,to);};
 try{await f.cache.save(delta([a],[trace('one',[a])]),t.signal);}finally{fs.open=open;fs.rename=rename;}
 for(const kind of ['sources','traces'])assert.ok(events.indexOf(`sync ${kind}`)>=0&&events.indexOf(`sync ${kind}`)<events.indexOf(`rename ${kind}`),`${kind} data is synced before it is renamed`);
 assert.ok(events.includes('open directory'));
 assert.ok(events.lastIndexOf('open directory')>events.indexOf('rename traces'),'the directory is synced after the final rename');
});

test('the writer epoch is replaced atomically without syncing, while records still sync before publication',async t=>{
 const f=await fixture(t),a=source(0),b=source(1),events=/** @type {string[]} */ ([]);
 const open=fs.open;
 fs.open=async function(file,...args){const handle=await open.call(this,file,...args);
  if(String(file).endsWith('.tmp')){const sync=handle.sync;handle.sync=function(...a){events.push(`sync ${path.basename(path.dirname(String(file)))}`);return sync.apply(this,a);};}
  else if(args[0]==='r'){events.push(`directory ${path.basename(String(file))}`);}
  return handle;};
 try{await f.cache.save(delta([a,b],[trace('one',[a]),trace('two',[b])]),t.signal);}finally{fs.open=open;}
 assert.ok(!events.includes('sync coverage-v3'),'the epoch is not synced');
 assert.ok(!events.includes('directory coverage-v3'),'the cache root holds only the epoch and is not synced');
 assert.equal(events.filter(event=>event==='sync sources').length,2);assert.equal(events.filter(event=>event==='sync traces').length,2);
 // The epoch is private; the test compares it with the persisted value.
 assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'epoch.json'),'utf8')),/** @type {any} */ (f.cache).epoch);
 const restored=new CoverageStore();await new CoverageCache(f.root,()=>undefined).restore(restored,t.signal);
 assert.deepEqual([...restored.traces.keys()].sort(),['one','two']);
});
