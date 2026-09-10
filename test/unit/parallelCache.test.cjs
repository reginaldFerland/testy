const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {setImmediate:turn}=require('node:timers/promises');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {CoverageCache}=require('../../out/services/cache');
const {CoverageStore}=require('../../out/core/coverage');
const {contentHash}=require('../../out/core/paths');
const execute=promisify(execFile);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const source=(index,lines=[1,2])=>{const file=`/Source${index}.cs`,hash='v1';return{id:contentHash(`${file}\0${hash}`),file,hash,lines};};
const delta=(sources,groupId='one',timestamp=1)=>({sources,removedSources:[],removedTraces:[],traces:[{
 groupId,timestamp,reliable:true,stale:false,dependencies:[sources[0].file],inputs:{[sources[0].file]:'v1'},
 sourceIds:[...new Set(sources.map(source=>source.id))],coverage:[{file:sources[0].file,hash:'v1',lines:[{line:sources[0].lines[0],hits:1}]}]
}]});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-parallel-cache-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return{root,cache:new CoverageCache(root,()=>{}),directory:path.join(root,'coverage-v2')};
}

test('independent geometry writes overlap within four slots, merge duplicate IDs and finish before traces publish',{timeout:10000},async t=>{
 const {cache,directory}=await fixture(t),sources=Array.from({length:12},(_,index)=>source(index));
 const updates=[source(0,[1,3]),source(0,[2,4]),...sources.slice(1),source(0,[1,2])],checkpoint=delta(updates);
 const open=fs.open,rename=fs.rename,gate=deferred(),active=new Set(),completed=new Set();
 let peak=0,started=0,published=0;
 t.signal.addEventListener('abort',()=>gate.resolve(),{once:true});
 fs.open=async function(file,...args){
  const handle=await open.call(this,file,...args);
  if(String(file).includes(`${path.sep}sources${path.sep}`)&&String(file).endsWith('.tmp')){
   const id=path.basename(String(file)).slice(0,64);
   assert.equal(active.has(id),false,'the same source ID never has competing writes');
   active.add(id);started++;peak=Math.max(peak,active.size);assert.ok(active.size<=4);
   const write=handle.writeFile.bind(handle),close=handle.close.bind(handle);
   handle.writeFile=async(...args)=>{if(started>=4)gate.resolve();await gate.promise;return write(...args);};
   handle.close=async()=>{try{return await close();}finally{active.delete(id);}};
  }
  return handle;
 };
 fs.rename=async function(from,to){
  if(String(to).includes(`${path.sep}traces${path.sep}`)){
   assert.equal(active.size,0,'all geometry file handles close before trace publication');
   assert.equal(completed.size,sources.length,'every referenced source is already published');
   for(const source of sources)assert.ok(JSON.parse(await fs.readFile(path.join(directory,'sources',`${source.id}.json`),'utf8')).lines.length);
   published++;
  }
  const result=await rename.call(this,from,to);
  if(String(to).includes(`${path.sep}sources${path.sep}`))completed.add(path.basename(String(to),'.json'));
  return result;
 };
 try{await cache.save(checkpoint,t.signal);}finally{gate.resolve();fs.open=open;fs.rename=rename;}
 assert.equal(peak,4);assert.equal(started,13,'duplicate geometry merges are ordered and redundant union writes are skipped');assert.equal(published,1);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'sources',`${sources[0].id}.json`),'utf8')).lines,[1,2,3,4]);
 assert.equal((await fs.readdir(path.join(directory,'sources'))).some(name=>name.endsWith('.tmp')),false);
 const restored=new CoverageStore();await cache.restore(restored);
 assert.equal(restored.traces.size,1);assert.equal(restored.summary(sources[0].file,new Map([[sources[0].file,'v1']])).total,4);
});

for(const failure of [false,true])test(`${failure?'failed':'cancelled'} geometry writes drain before unlocking, preserve the old trace and can retry`,{timeout:10000},async t=>{
 const {root,cache,directory}=await fixture(t),sources=Array.from({length:12},(_,index)=>source(index)),checkpoint=delta(sources,'one',2);
 await cache.save(delta([source(0,[1])]));
 const traceFile=path.join(directory,'traces',`${contentHash('one')}.json`),control=new AbortController();
 const signal=AbortSignal.any([control.signal,t.signal]);
 const open=fs.open,rm=fs.rm,rename=fs.rename,read=fs.readFile;
 const entered=deferred(),release=deferred(),fail=deferred(),failedCleanup=deferred();
 const workerSignals=[],started=new Set();let active=0,settled=false,traceWrites=0,competitorFinished=false;
 const error=new Error('controlled geometry write failure');
 t.signal.addEventListener('abort',()=>{fail.resolve();release.resolve();},{once:true});
 fs.readFile=async function(file,...args){
  if(String(file).includes(`${path.sep}sources${path.sep}`)&&args[0]?.signal)workerSignals.push(args[0].signal);
  return read.call(this,file,...args);
 };
 fs.open=async function(file,...args){
  const handle=await open.call(this,file,...args);
  if(String(file).includes(`${path.sep}sources${path.sep}`)&&String(file).endsWith('.tmp')){
   const id=path.basename(String(file)).slice(0,64),write=handle.writeFile.bind(handle);
   if(!sources.some(source=>source.id===id))return handle;
   handle.writeFile=async(...args)=>{
    await write(...args);active++;started.add(id);if(started.size===4)entered.resolve();
    try{if(failure&&id===sources[0].id){await fail.promise;throw error;}await release.promise;}
    finally{active--;}
   };
  }
  return handle;
 };
 fs.rm=async function(file,...args){
  const result=await rm.call(this,file,...args);
  if(String(file).includes(`${path.sep}sources${path.sep}${sources[0].id}.`)&&String(file).endsWith('.tmp'))failedCleanup.resolve();
  return result;
 };
 fs.rename=async function(from,to){if(String(to)===traceFile)traceWrites++;return rename.call(this,from,to);};
 const saving=cache.save(checkpoint,signal);void saving.then(()=>{settled=true;},()=>{settled=true;});
 const rejected=assert.rejects(saving,failure?value=>value===error:{name:'AbortError'});
 let competitor;
 try{
  await Promise.race([entered.promise,saving]);
  if(failure){fail.resolve();await failedCleanup.promise;}else control.abort();
  await turn();
  assert.equal(settled,false,'a failed/cancelled save still owns its in-flight sibling writes');
  assert.equal(active,failure?3:4);assert.ok(workerSignals.every(signal=>signal.aborted));
  await fs.access(path.join(root,'coverage-v2.lock'));
  assert.equal(JSON.parse(await fs.readFile(traceFile,'utf8')).timestamp,1);assert.equal(traceWrites,0);
  competitor=new CoverageCache(root,()=>{}).save(delta([source(99)],'competing')).then(()=>{competitorFinished=true;});
  await turn();assert.equal(competitorFinished,false,'another cache cannot publish while cancelled siblings still own the lock');
  release.resolve();await rejected;
  assert.equal(started.size,4,'failure never admits the queued source groups');
  await competitor;
 }finally{
  fail.resolve();release.resolve();await Promise.allSettled([saving,rejected,competitor]);
  fs.open=open;fs.rm=rm;fs.rename=rename;fs.readFile=read;
 }
 assert.equal(active,0);assert.equal(traceWrites,0);assert.equal(competitorFinished,true);
 assert.equal((await fs.readdir(path.join(directory,'sources'))).some(name=>name.endsWith('.tmp')),false);
 assert.equal(JSON.parse(await fs.readFile(traceFile,'utf8')).timestamp,1);
 await cache.save(checkpoint);
 const restored=new CoverageStore();await cache.restore(restored);
 assert.equal(restored.traces.size,2);assert.equal(restored.traces.get('one').timestamp,2);
 assert.deepEqual(restored.summary(sources[0].file,new Map([[sources[0].file,'v1']])).lines,[{line:1,hits:1},{line:2,hits:0}]);
});

test('an external cache writer invalidates the geometry memo after pruning and replacing a source',{timeout:10000},async t=>{
 const {root,cache,directory}=await fixture(t),first=delta([source(0)]);
 await cache.save(first);
 const input=path.join(root,'child.json');await fs.writeFile(input,JSON.stringify({root,next:delta([source(0,[3])],'child')}));
 const script=`const fs=require('node:fs/promises');const {CoverageCache}=require(process.argv[1]);const {CoverageStore}=require(process.argv[2]);(async()=>{const {root,next}=JSON.parse(await fs.readFile(process.argv[3],'utf8'));const cache=new CoverageCache(root,()=>{});await cache.save({sources:[],traces:[],removedSources:[],removedTraces:['one']});await cache.restore(new CoverageStore());await cache.save(next);})().catch(error=>{console.error(error);process.exitCode=1;});`;
 await execute(process.execPath,['-e',script,path.resolve('out/services/cache.js'),path.resolve('out/core/coverage.js'),input],{signal:t.signal});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'sources',`${first.sources[0].id}.json`),'utf8')).lines,[3]);
 await cache.save(first);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'sources',`${first.sources[0].id}.json`),'utf8')).lines,[1,2,3]);
 const restored=new CoverageStore();await cache.restore(restored);
 assert.deepEqual([...restored.traces.keys()].sort(),['child','one']);
});
