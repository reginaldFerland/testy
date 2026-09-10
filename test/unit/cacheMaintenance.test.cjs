const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage');
const reader=require('../../out/services/cacheReader'),{contentHash}=require('../../out/core/paths');
const execute=promisify(execFile);
const source=(index,hash='v1',lines=[1,2])=>{const file=`/Source${index}.cs`;return{id:contentHash(`${file}\0${hash}`),file,hash,lines};};
const trace=(groupId,sources,timestamp=1)=>({groupId,timestamp,reliable:true,stale:false,
 dependencies:sources.map(source=>source.file),inputs:Object.fromEntries(sources.map(source=>[source.file,source.hash])),
 sourceIds:sources.map(source=>source.id),coverage:sources.map(source=>({file:source.file,hash:source.hash,lines:[{line:1,hits:timestamp}]}))});
const delta=(sources,traces=[],removedTraces=[])=>({sources,traces,removedSources:[],removedTraces});
async function fixture(t,restore=true){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-cache-maintenance-test-')),directory=path.join(root,'coverage-v2'),warnings=[];
 const cache=new CoverageCache(root,text=>warnings.push(text));let reads=0;
 const read=reader.readCache;reader.readCache=async function(...args){reads++;return read.apply(this,args);};
 t.after(async()=>{reader.readCache=read;await fs.rm(root,{recursive:true,force:true});});
 if(restore)await cache.restore(new CoverageStore(),t.signal);
 const initialReads=reads,checkpoint=delta([], [trace('tick',[])]);
 return{root,directory,cache,warnings,get reads(){return reads-initialReads;},
  async fill(count=128){for(let index=0;index<count;index++)await cache.save(checkpoint,t.signal);},
  sourceFile:source=>path.join(directory,'sources',`${source.id}.json`),traceFile:id=>path.join(directory,'traces',`${contentHash(id)}.json`),
  async clean(){await assert.rejects(fs.stat(directory+'.lock'),{code:'ENOENT'});
   for(const kind of ['sources','traces'])assert.ok((await fs.readdir(path.join(directory,kind))).every(name=>name.endsWith('.json')));
  }};
}
const missing=file=>assert.rejects(fs.stat(file),{code:'ENOENT'});

test('a complete empty restore skips sweeps for additions and fresh equal membership arrays',async t=>{
 const f=await fixture(t),sources=[source(0),source(1),source(2)];
 for(let index=0;index<256;index++)await f.cache.save(delta(sources,[trace(`file${index}`,sources)]),t.signal);
 for(let index=0;index<128;index++)await f.cache.save(delta(sources,[trace(`file${index}`,sources,2)]),t.signal);
 assert.equal(f.reads,0,'additions and unchanged memberships do not create orphaned geometry');
 assert.equal((await fs.readdir(path.join(f.directory,'traces'))).length,256);
 assert.equal((await fs.readdir(path.join(f.directory,'sources'))).length,3);
 await f.cache.restore(new CoverageStore(),t.signal);assert.equal(f.reads,1,'explicit restore always validates the complete cache');
 await f.fill(128);assert.equal(f.reads,1);await f.clean();
});

test('direct saves remain conservative until their first completed 128-save sweep',async t=>{
 const f=await fixture(t,false),sources=[source(0)],checkpoint=delta(sources,[trace('one',sources)]);
 for(let index=0;index<127;index++)await f.cache.save(checkpoint,t.signal);
 assert.equal(f.reads,0);await f.cache.save(checkpoint,t.signal);assert.equal(f.reads,1);
 for(let index=0;index<256;index++)await f.cache.save(delta(sources,[trace('one',sources,index+2)]),t.signal);
 assert.equal(f.reads,1);await f.clean();
});

test('changed memberships reclaim old geometry even when retryDelta loses removedSources',async t=>{
 const f=await fixture(t),a=source(0),b=source(0,'v2'),store=new CoverageStore();
 const raw=source=>({groupId:'one',timestamp:1,reliable:true,dependencies:[source.file],inputs:{[source.file]:source.hash},
  coverage:[{file:source.file,hash:source.hash,lines:source.lines.map(line=>({line,hits:1}))}]});
 store.replace([raw(a)],new Set(['one']));await f.cache.save(store.takeDelta(),t.signal);
 store.replace([raw(b)],new Set(['one']));const failed=store.takeDelta();assert.ok(failed.removedSources.includes(a.id));
 const aborted=new AbortController();aborted.abort();await assert.rejects(f.cache.save(failed,aborted.signal),{name:'AbortError'});
 store.retryDelta(failed);const retried=store.takeDelta();assert.deepEqual(retried.removedSources,[]);
 await f.cache.save(retried,t.signal);await fs.access(f.sourceFile(a));await f.fill(126);
 assert.equal(f.reads,1);await missing(f.sourceFile(a));await fs.access(f.sourceFile(b));
 assert.equal(JSON.parse(await fs.readFile(f.traceFile('one'),'utf8')).coverage[0].hash,'v2');await f.clean();
});

test('trace removals prune only geometry without any remaining cache owner',async t=>{
 const f=await fixture(t),a=source(0);
 await f.cache.save(delta([a],[trace('one',[a]),trace('two',[a])]),t.signal);
 await f.cache.save(delta([],[],['one']),t.signal);await f.fill(126);
 assert.equal(f.reads,1);await fs.access(f.sourceFile(a));await missing(f.traceFile('one'));
 await f.cache.save(delta([],[],['two']),t.signal);await f.fill(127);
 assert.equal(f.reads,2);await missing(f.sourceFile(a));await f.clean();
});

test('source-only and mixed unreferenced additions stay dirty while live geometry unions survive',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1),b=source(2),extra=source(3);
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);
 await f.cache.save(delta([orphan]),t.signal);await f.fill(126);
 assert.equal(f.reads,1);await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));
 await f.cache.save(delta([source(0,'v1',[1,2,3])]),t.signal);await f.fill(127);
 assert.equal(f.reads,1,'expanding an already-live source does not create an orphan');
 assert.deepEqual(JSON.parse(await fs.readFile(f.sourceFile(a),'utf8')).lines,[1,2,3]);
 await f.cache.save(delta([b,extra],[trace('two',[b])]),t.signal);await f.fill(127);
 assert.equal(f.reads,2);await missing(f.sourceFile(extra));await fs.access(f.sourceFile(a));await fs.access(f.sourceFile(b));await f.clean();
});

test('duplicate trace publications in one delta detect the displaced source membership',async t=>{
 const f=await fixture(t),a=source(0),b=source(1);
 await f.cache.save(delta([a,b],[trace('one',[a]),trace('one',[b],2)]),t.signal);await f.fill(127);
 assert.equal(f.reads,1);await missing(f.sourceFile(a));await fs.access(f.sourceFile(b));
 assert.deepEqual(JSON.parse(await fs.readFile(f.traceFile('one'),'utf8')),trace('one',[b],2));await f.clean();
});

test('a failed external writer invalidates clean membership knowledge before the next sweep',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1),checkpoint=delta([a],[trace('one',[a])]);
 await f.cache.save(checkpoint,t.signal);
 const input=path.join(f.root,'external.json');await fs.writeFile(input,JSON.stringify({root:f.root,checkpoint:delta([orphan],[trace('failed',[orphan])])}));
 const script=`const fs=require('node:fs/promises');const {CoverageCache}=require(process.argv[1]);(async()=>{const {root,checkpoint}=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const cache=new CoverageCache(root,()=>{}),write=cache.write;cache.write=async function(kind,...args){if(kind==='traces')throw new Error('expected publication failure');return write.call(this,kind,...args);};try{await cache.save(checkpoint);throw new Error('unexpected success');}catch(error){if(error.message!=='expected publication failure')throw error;}})().catch(error=>{console.error(error);process.exitCode=1;});`;
 await execute(process.execPath,['-e',script,path.resolve('out/services/cache.js'),input],{signal:t.signal});
 await fs.access(f.sourceFile(orphan));await f.cache.save(checkpoint,t.signal);await f.fill(126);
 assert.equal(f.reads,1);await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));await f.clean();
});

for(const cancelled of [false,true])test(`${cancelled?'cancelled':'failed'} partial trace publication cannot establish a clean cache`,async t=>{
 const f=await fixture(t),a=source(0),b=source(1),orphan=source(2);
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),rename=fs.rename,error=new Error('controlled publication failure');
 fs.rename=async function(from,to){if(String(to)===f.traceFile('failed')){if(cancelled){control.abort();throw control.signal.reason;}throw error;}return rename.call(this,from,to);};
 try{await assert.rejects(f.cache.save(delta([b,orphan],[trace('published',[b]),trace('failed',[orphan])]),signal),cancelled?{name:'AbortError'}:value=>value===error);}
 finally{fs.rename=rename;}
 await fs.access(f.traceFile('one'));await fs.access(f.traceFile('published'));await missing(f.traceFile('failed'));
 await fs.access(f.sourceFile(orphan));await f.clean();await f.fill(127);
 assert.equal(f.reads,1);await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));await fs.access(f.sourceFile(b));await f.clean();
});

test('an interrupted prune retains dirty state and retries the remaining orphaned geometry',async t=>{
 const f=await fixture(t),a=source(0),orphans=[source(1),source(2)];
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);await f.cache.save(delta(orphans),t.signal);await f.fill(125);
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),remove=fs.rm;let deleted=0;
 fs.rm=async function(file,...args){const result=await remove.call(this,file,...args);
  if(orphans.some(source=>String(file)===f.sourceFile(source))){deleted++;control.abort();}return result;
 };
 try{await assert.rejects(f.cache.save(delta([], [trace('tick',[])]),signal),{name:'AbortError'});}finally{fs.rm=remove;}
 assert.equal(deleted,1);assert.equal(f.reads,1);await f.clean();await f.fill(128);
 assert.equal(f.reads,2);for(const orphan of orphans)await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));await f.clean();
});

test('an unreadable prune directory cannot be mistaken for a complete cleanup',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1);
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);await f.cache.save(delta([orphan]),t.signal);await f.fill(125);
 const list=fs.readdir;let denied=0;
 fs.readdir=async function(directory,...args){if(String(directory)===path.join(f.directory,'sources')){denied++;throw Object.assign(new Error('controlled unreadable source directory'),{code:'EACCES'});}return list.call(this,directory,...args);};
 try{await f.fill(1);}finally{fs.readdir=list;}
 assert.equal(denied,1);assert.equal(f.reads,1);await fs.access(f.sourceFile(orphan));await f.fill(128);
 assert.equal(f.reads,2);await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));await f.clean();
});

test('an incomplete snapshot protects orphaned geometry and remains dirty after repair',async t=>{
 const f=await fixture(t),a=source(0),orphan=source(1);
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);await f.cache.save(delta([orphan]),t.signal);
 const broken=path.join(f.directory,'traces',`${'a'.repeat(64)}.json`);await fs.writeFile(broken,'{broken');await f.fill(126);
 assert.equal(f.reads,1);assert.ok(f.warnings.some(text=>text.includes('unreadable')));await fs.access(f.sourceFile(orphan));
 await fs.rm(broken);await f.fill(128);
 assert.equal(f.reads,2);await missing(f.sourceFile(orphan));await fs.access(f.sourceFile(a));await f.clean();
});
