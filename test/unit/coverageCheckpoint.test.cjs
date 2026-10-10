const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage');
const {SourceTracker}=require('../../out/services/sources');
const {contentHash}=require('../../out/core/paths'),{defaultCacheLimits}=require('../../out/services/cacheFormat');
/** @typedef {{id:string,file:string,hash:string,lines:number[]}} Source */
/** @type {(index:number,hash?:string)=>Source} */
const source=(index,hash='v1')=>{const file=`/workspace/src/Source${index}.cs`;return{id:contentHash(`${file}\0${hash}`),file,hash,lines:[1,2]};};
/** @type {(groupId:string,sources:Source[],identity?:string)=>import('../../out/core/coverage').StoredTrace} */
const trace=(groupId,sources,identity)=>({groupId,timestamp:1,reliable:true,stale:false,...identity?{identity}:{},
 dependencies:sources.map(source=>source.file),inputs:Object.fromEntries(sources.map(source=>[source.file,source.hash])),
 sourceIds:sources.map(source=>source.id),coverage:sources.map(source=>({file:source.file,hash:source.hash,lines:[{line:1,hits:1}]}))});
/** @param {Source[]} sources @param {import('../../out/core/coverage').StoredTrace[]} traces @param {any} [checkpoint] */
const delta=(sources,traces,checkpoint)=>({sources,traces,removedSources:[],removedTraces:[],...checkpoint===undefined?{}:{checkpoint}});

/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-checkpoint-test-')),directory=path.join(root,'coverage-v3');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 /** @type {string[]} */ const output=[];
 return{root,directory,output,cache:new CoverageCache(root,text=>output.push(text))};
}

test('traces and the checkpoint saved under the current identity are restored as saved; any other identity restores history only',async t=>{
 const f=await fixture(t),a=source(0),b=source(1);
 const checkpoint={identity:'id-1',completed:['one','two'],versions:new Map([[a.file,'v1'],[b.file,'v1']]),shapes:new Map([[a.file,'shape-a']])};
 await f.cache.save(delta([a,b],[trace('one',[a],'id-1'),trace('two',[b],'id-0')],checkpoint),t.signal);
 const trusted=new CoverageStore(),restored=await new CoverageCache(f.root,()=>{}).restore(trusted,t.signal,'id-1');
 assert.deepEqual(restored.checkpoint,checkpoint);
 assert.equal(trusted.traces.get('one')?.reliable,true);assert.equal(trusted.traces.get('one')?.stale,false);
 assert.equal(trusted.traces.get('two')?.reliable,false,'a trace learned under another identity never narrows a selection');
 for(const identity of ['id-2',undefined]){
  const store=new CoverageStore(),other=await new CoverageCache(f.root,()=>{}).restore(store,t.signal,identity);
  assert.equal(other.checkpoint,undefined);
  assert.deepEqual([...store.traces.values()].map(trace=>[trace.reliable,trace.stale]),[[false,true],[false,true]]);
 }
 // Deleting the checkpoint withdraws the trust.
 await f.cache.save(delta([],[],null),t.signal);
 const after=new CoverageStore();assert.equal((await new CoverageCache(f.root,()=>{}).restore(after,t.signal,'id-1')).checkpoint,undefined);
 assert.equal(after.traces.get('one')?.reliable,false);
});

test('paths and versions are stored once in the table; records name them by position and carry the format',async t=>{
 const f=await fixture(t),shared=source(0),traces=Array.from({length:20},(_,index)=>trace(`group${index}`,[shared,source(index+1)]));
 await f.cache.save(delta([shared,...traces.map((_,index)=>source(index+1))],traces),t.signal);
 for(const name of await fs.readdir(path.join(f.directory,'traces'))){
  const text=await fs.readFile(path.join(f.directory,'traces',name),'utf8');
  assert.ok(!text.includes('/workspace/'),'a trace holds no path');assert.equal(JSON.parse(text).format,3);
 }
 const [generation]=(await fs.readdir(path.join(f.directory,'tables'))).filter(name=>name!=='current.json');
 const segments=await fs.readdir(path.join(f.directory,'tables',/** @type {string} */ (generation)));
 const entries=(await Promise.all(segments.map(async name=>JSON.parse(await fs.readFile(path.join(f.directory,'tables',/** @type {string} */ (generation),name),'utf8')).entries))).flat();
 assert.equal(entries.filter(entry=>entry===shared.file).length,1,'the shared path is stored once');
 const store=new CoverageStore();await new CoverageCache(f.root,()=>{}).restore(store,t.signal);
 assert.deepEqual(store.traces.get('group3')?.inputs,traces[3]?.inputs);assert.deepEqual(store.traces.get('group3')?.dependencies,traces[3]?.dependencies);
 assert.equal(store.traces.get('group3')?.dependencies[0],store.traces.get('group4')?.dependencies[0],'restored paths share one string');
});

test('records of another format are left alone, and earlier formats\' directories are removed once this one is established',async t=>{
 const f=await fixture(t),a=source(0);
 await f.cache.save(delta([a],[trace('one',[a])]),t.signal);
 const foreign=path.join(f.directory,'traces',`${contentHash('future')}.json`);
 await fs.writeFile(foreign,JSON.stringify({format:4,groupId:'future'}));
 const legacy=path.join(f.root,'coverage-v2');await fs.mkdir(path.join(legacy,'traces'),{recursive:true});await fs.writeFile(path.join(legacy,'traces','x.json'),'{}');
 const store=new CoverageStore(),output=/** @type {string[]} */ ([]);await new CoverageCache(f.root,text=>output.push(text)).restore(store,t.signal);
 assert.deepEqual([...store.traces.keys()],['one']);
 await fs.access(foreign);assert.ok(output.some(text=>text.includes('another format')));
 await assert.rejects(fs.access(legacy),{code:'ENOENT'});await assert.rejects(fs.access(`${legacy}.lock`),{code:'ENOENT'});
});

test('a table that is mostly garbage is compacted into a new generation at restore, keeping every trace',async t=>{
 // Production compacts tables of more than 4096 entries; a lower threshold keeps the same shape small.
 const f=await fixture(t),many=Array.from({length:200},(_,index)=>source(index)),kept=source(9999),limits={...defaultCacheLimits,compactEntries:256};
 await f.cache.save(delta(many,[trace('wide',many)]),t.signal);
 await f.cache.save({...delta([kept],[trace('wide',[kept]),trace('other',[kept],'id')],{identity:'id',completed:['other'],versions:new Map([[kept.file,'v1']]),shapes:new Map([[kept.file,null]])})},t.signal);
 const before=(await fs.readdir(path.join(f.directory,'tables'))).filter(name=>name!=='current.json');
 const store=new CoverageStore(),cache=new CoverageCache(f.root,text=>f.output.push(text),limits),restored=await cache.restore(store,t.signal,'id');
 const after=(await fs.readdir(path.join(f.directory,'tables'))).filter(name=>name!=='current.json');
 assert.equal(after.length,1);assert.notDeepEqual(after,before);assert.ok(f.output.some(text=>text.includes('Compacted')));
 assert.deepEqual([...store.traces.keys()].sort(),['other','wide']);assert.deepEqual(restored.checkpoint?.completed,['other']);
 // Saves extend the new generation, and a later restore reads both.
 await cache.save(delta([source(1)],[trace('third',[source(1)])]),t.signal);
 const again=new CoverageStore();await new CoverageCache(f.root,()=>{}).restore(again,t.signal,'id');
 assert.deepEqual([...again.traces.keys()].sort(),['other','third','wide']);assert.equal(again.traces.get('other')?.reliable,true);
});

test('a failed write of an earlier trace publishes no later one, while concurrent writes still rename in order',async t=>{
 const f=await fixture(t),sources=[0,1,2,3].map(index=>source(index));
 /** @type {any} */ const cache=f.cache; // private: stage
 const stage=cache.stage,renamed=/** @type {string[]} */ ([]),rename=fs.rename;
 cache.stage=async function(/** @type {string} */ kind,/** @type {string} */ id,/** @type {any[]} */ ...rest){
  if(kind==='traces'&&id===contentHash('t1'))throw new Error('controlled stage failure');return stage.call(this,kind,id,...rest);};
 fs.rename=async function(from,to){if(String(to).includes(`${path.sep}traces${path.sep}`))renamed.push(path.basename(String(to)));return rename.call(this,from,to);};
 try{await assert.rejects(f.cache.save(delta(sources,sources.map((value,index)=>trace(`t${index}`,[value]))),t.signal),/controlled stage failure/);}
 finally{fs.rename=rename;cache.stage=stage;}
 assert.deepEqual(renamed,[`${contentHash('t0')}.json`]);
 assert.deepEqual((await fs.readdir(path.join(f.directory,'traces'))).sort(),[`${contentHash('t0')}.json`],'no temporary file is left behind');
});

test('restored traces are checked against the first versions applied, including inputs that no longer exist',()=>{
 const a=source(0),b=source(1),store=new CoverageStore();
 store.restorePacked([a,b],[trace('one',[a],'id'),trace('two',[b],'id')],false,()=>true);
 assert.equal(store.traces.get('one')?.stale,false);
 // b was deleted while the editor was closed: it is absent from the new map, not changed in it.
 store.applyHashes(new Map([[a.file,'v1']]));
 assert.equal(store.traces.get('one')?.stale,false);assert.equal(store.traces.get('two')?.stale,true);
 assert.equal(store.traces.get('two')?.reliable,true,'staleness is shown; the change itself selects the file again');
});

test('applyHashes checks only the files its source reports changed, and compares the maps when that is unknown',()=>{
 const a=source(0),b=source(1),store=new CoverageStore();
 store.replace([trace('one',[a]),trace('two',[b])],new Set(['one','two']));
 const initial=new Map([[a.file,'v1'],[b.file,'v1']]);store.applyHashes(initial);
 /** @type {ReadonlyMap<string,string>[]} */ const asked=[];
 store.applyHashes(new Map([[a.file,'v2'],[b.file,'v2']]),since=>{asked.push(since);return [a.file];});
 assert.equal(asked[0],initial);
 assert.equal(store.traces.get('one')?.stale,true);assert.equal(store.traces.get('two')?.stale,false,'unreported files are not looked up');
 store.applyHashes(new Map([[a.file,'v2'],[b.file,'v3']]),()=>undefined);
 assert.equal(store.traces.get('two')?.stale,true);
});

test('the source tracker reports the files changed since any recent map it published',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-tracker-changes-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const [a,b,c]=['A.cs','B.cs','C.cs'].map(name=>path.join(root,name));
 for(const file of [a,b,c])await fs.writeFile(/** @type {string} */ (file),`class ${path.basename(/** @type {string} */ (file),'.cs')} {}`);
 const tracker=new SourceTracker(),empty=tracker.hashes;tracker.setFiles([/** @type {string} */ (a),/** @type {string} */ (b),/** @type {string} */ (c)]);
 await tracker.refresh(tracker.files);const first=tracker.hashes;
 assert.deepEqual([...(tracker.changedSince(empty)??[])].sort(),[a,b,c].sort());assert.deepEqual(tracker.changedSince(first),[]);
 await fs.writeFile(/** @type {string} */ (b),'class B { int x; }');tracker.mark([/** @type {string} */ (b)]);await tracker.refresh([]);
 tracker.setFiles([/** @type {string} */ (a),/** @type {string} */ (b)]);
 assert.deepEqual([...(tracker.changedSince(first)??[])].sort(),[b,c].sort(),'edits and removals since the map');
 assert.equal(tracker.changedSince(new Map()),undefined,'a map it never published is unknown');
});
