const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const threads=require('node:worker_threads');
const {CoverageCache}=require('../../out/services/cache');
const {CoverageStore}=require('../../out/core/coverage');
const {contentHash}=require('../../out/core/paths');
const workerFile=require.resolve('../../out/services/cacheWorker');
const source=(index,lines=[1,2])=>{const file=`/Source${index}.cs`,hash='v1';return{id:contentHash(`${file}\0${hash}`),file,hash,lines};};
const trace=(index,sources)=>({groupId:`group${index}`,timestamp:index+1,reliable:true,stale:false,
 dependencies:[sources[0].file],moduleProjects:['/Project.csproj'],inputs:{[sources[0].file]:'v1'},
 sourceIds:sources.map(source=>source.id),coverage:[{file:sources[0].file,hash:'v1',lines:[{line:1,hits:0.5}]}]});

async function fixture(t,sources,traces){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-parallel-cache-read-')),directory=path.join(root,'coverage-v2');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const [kind,records]of [['sources',sources],['traces',traces]]){
  await fs.mkdir(path.join(directory,kind),{recursive:true});
  for(const record of records)await fs.writeFile(path.join(directory,kind,`${kind==='sources'?record.id:contentHash(record.groupId)}.json`),JSON.stringify(record));
 }
 return{root,directory};
}

// Run the production worker against real files, pausing admitted reads inside
// that worker rather than replacing its scheduler or parser with test doubles.
function bootstrap(options={}){
 return `const fs=require('node:fs/promises'),path=require('node:path'),{parentPort}=require('node:worker_threads');
 const options=${JSON.stringify(options)},read=fs.readFile,list=fs.readdir,waiting=new Map();let released=!options.gate;
 parentPort.on('message',message=>{if(message.all){released=true;for(const done of waiting.values())done();waiting.clear();}
  else{waiting.get(message.release)?.();waiting.delete(message.release);}});
 fs.readdir=async function(directory,...args){const names=await list.call(this,directory,...args);return options.order?.[path.basename(directory)]??names;};
 fs.readFile=async function(file,...args){
  const key=path.relative(${JSON.stringify(options.directory??'')},String(file));parentPort.postMessage({event:'admitted',key});
  try{if(!released)await new Promise(done=>waiting.set(key,done));return await read.call(this,file,...args);}
  finally{parentPort.postMessage({event:'completed',key});}
 };
 require(${JSON.stringify(workerFile)});`;
}

function observe(worker,t){
 const events=[],waiters=new Set();let active=0,peak=0,resolve,reject,failed,snapshot;
 const result=new Promise((done,fail)=>{resolve=done;reject=fail;});void result.catch(()=>{});
 const fail=error=>{failed=error;reject(error);for(const waiter of waiters)waiter.reject(error);waiters.clear();};
 worker.on('error',fail);
 const message=message=>{
  if(message.event){events.push(message);active+=message.event==='admitted'?1:-1;peak=Math.max(peak,active);}
  else{snapshot=message;resolve(message);}
  for(const waiter of waiters)if(waiter.predicate()){waiters.delete(waiter);waiter.resolve();}
 };
 worker.on('message',message);worker.on('diagnostic',message);
 const exited=new Promise(done=>worker.once('exit',code=>{if(!snapshot)fail(new Error(`Worker exited before snapshot (${code})`));done(code);}));
 const abort=()=>{fail(t.signal.reason);void worker.terminate();};t.signal.addEventListener('abort',abort,{once:true});
 t.after(async()=>{t.signal.removeEventListener('abort',abort);await worker.terminate();});
 return{events,result,exited,get active(){return active;},get peak(){return peak;},
  wait(predicate){if(failed)return Promise.reject(failed);if(predicate())return Promise.resolve();return new Promise((resolve,reject)=>waiters.add({predicate,resolve,reject}));},
  release(key){worker.postMessage({release:key});},releaseAll(){worker.postMessage({all:true});}};
}

function expected(sources,traces,warnings=[]){
 const indices=new Map(sources.map((source,index)=>[source.id,index]));
 return{sources:sources.map(source=>({...source,lines:Float64Array.from([...new Set(source.lines)].sort((a,b)=>a-b))})),
  traces:traces.map(trace=>({...trace,sourceIds:Uint32Array.from(trace.sourceIds.map(id=>indices.get(id))),coverage:trace.coverage.map(file=>({
   file:file.file,hash:file.hash,values:Float64Array.from(file.lines.flatMap(line=>[line.line,line.hits]))}))})),warnings,complete:!warnings.length};
}

test('one four-read pool spans both cache tables and preserves exact inventory order despite reversed completion',{timeout:10000},async t=>{
 const sources=[source(0,[2**32+7,2,1,2]),source(1)],traces=Array.from({length:6},(_,index)=>trace(index,sources));
 const {directory}=await fixture(t,sources,traces);
 const order={sources:[...sources].reverse().map(source=>`${source.id}.json`),traces:[...traces].reverse().map(trace=>`${contentHash(trace.groupId)}.json`)};
 const worker=new threads.Worker(bootstrap({directory,order,gate:true}),{eval:true,workerData:directory}),probe=observe(worker,t);
 await probe.wait(()=>probe.events.filter(event=>event.event==='admitted').length===4);
 const initial=probe.events.filter(event=>event.event==='admitted');
 assert.equal(probe.active,4);assert.equal(initial.filter(event=>event.key.startsWith(`sources${path.sep}`)).length,2);
 assert.equal(initial.filter(event=>event.key.startsWith(`traces${path.sep}`)).length,2,'trace reads share spare slots with unfinished source reads');
 probe.release(initial[3].key);
 await probe.wait(()=>probe.events.filter(event=>event.event==='admitted').length===5);
 assert.equal(probe.events.find(event=>event.event==='completed').key,initial[3].key);
 probe.releaseAll();const snapshot=await probe.result;
 assert.equal(probe.active,0);assert.equal(probe.peak,4);assert.equal(probe.events.filter(event=>event.event==='admitted').length,8);
 assert.deepEqual(snapshot,expected([...sources].reverse(),[...traces].reverse()));
});

test('out-of-order corrupt and missing records retain warning order, valid records and incomplete-cache pruning protection',{timeout:10000},async t=>{
 const sources=[source(0),source(1)],traces=[trace(0,sources.slice(0,1))],{root,directory}=await fixture(t,sources,traces);
 const brokenSource=`${'a'.repeat(64)}.json`,missingSource=`${'b'.repeat(64)}.json`,brokenTrace=`${'c'.repeat(64)}.json`,invalidTrace=`${'d'.repeat(64)}.json`;
 await fs.writeFile(path.join(directory,'sources',brokenSource),'{broken');
 await fs.writeFile(path.join(directory,'traces',brokenTrace),'{broken');
 await fs.writeFile(path.join(directory,'traces',invalidTrace),JSON.stringify({...trace(1,sources),coverage:[{file:sources[0].file,hash:'v1',lines:[{line:999,hits:1}]}]}));
 await fs.writeFile(path.join(directory,'sources','ignored.tmp'),'{broken');
 const order={sources:[brokenSource,`${sources[0].id}.json`,missingSource,`${sources[1].id}.json`],traces:[brokenTrace,invalidTrace,`${contentHash(traces[0].groupId)}.json`]};
 const worker=new threads.Worker(bootstrap({directory,order,gate:true}),{eval:true,workerData:directory}),probe=observe(worker,t);
 await probe.wait(()=>probe.events.filter(event=>event.event==='admitted').length===4);
 probe.release(path.join('sources',missingSource));
 await probe.wait(()=>probe.events.some(event=>event.event==='admitted'&&event.key===path.join('traces',brokenTrace)));
 probe.release(path.join('traces',brokenTrace));
 await probe.wait(()=>probe.events.some(event=>event.event==='completed'&&event.key===path.join('traces',brokenTrace)));
 probe.releaseAll();
 const warnings=[brokenSource,missingSource,brokenTrace].map(name=>`Ignoring an unreadable coverage cache entry: ${name}`);
 warnings.push('Ignoring invalid coverage cache records; preserving source geometry until the cache is fully readable.');
 assert.deepEqual(await probe.result,expected(sources,traces,warnings));
 const restored=new CoverageStore(),messages=[];await new CoverageCache(root,text=>messages.push(text)).restore(restored,t.signal);
 assert.deepEqual([...restored.traces.keys()],['group0']);assert.ok(messages.length>=3);
 await fs.access(path.join(directory,'sources',`${sources[1].id}.json`));
 assert.equal(restored.summary(sources[0].file,new Map([[sources[0].file,'v1']])).stale,true);
});

test('missing tables are empty while unreadable tables mark the snapshot incomplete',{timeout:10000},async t=>{
 const {directory}=await fixture(t,[],[]);await fs.rm(path.join(directory,'sources'),{recursive:true});
 let worker=new threads.Worker(workerFile,{workerData:directory}),probe=observe(worker,t);
 assert.deepEqual(await probe.result,expected([],[]));
 await fs.rm(path.join(directory,'traces'),{recursive:true});await fs.writeFile(path.join(directory,'traces'),'not a directory');
 worker=new threads.Worker(workerFile,{workerData:directory});probe=observe(worker,t);
 const snapshot=await probe.result;assert.equal(snapshot.complete,false);assert.deepEqual(snapshot.sources,[]);assert.deepEqual(snapshot.traces,[]);
 assert.equal(snapshot.warnings.length,1);assert.match(snapshot.warnings[0],/^Unable to read the coverage cache: .*ENOTDIR/);
});

test('cancelling a restore with four admitted reads terminates the worker without publishing or holding the lock',{timeout:10000},async t=>{
 const sources=Array.from({length:8},(_,index)=>source(index)),traces=[trace(0,sources)],{root,directory}=await fixture(t,sources,traces);
 const store=new CoverageStore(),old={groupId:'live',dependencies:[],coverage:[],inputs:{},timestamp:1,reliable:true};
 store.replace([old],new Set(['live']));store.takeDelta();
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),Original=threads.Worker;
 let ready;const started=new Promise(resolve=>ready=resolve);
 threads.Worker=class extends Original{
  constructor(filename,options){assert.equal(filename,workerFile);super(bootstrap({directory,gate:true}),{...options,eval:true});ready(observe(this,t));}
  emit(event,value,...args){return super.emit(event==='message'&&value?.event?'diagnostic':event,value,...args);}
 };
 const cache=new CoverageCache(root,()=>{}),restoring=cache.restore(store,signal),rejected=assert.rejects(restoring,{name:'AbortError'});
 try{
  const probe=await started;await probe.wait(()=>probe.events.filter(event=>event.event==='admitted').length===4);
  assert.deepEqual([...store.traces.keys()],['live']);control.abort();await rejected;await probe.exited;
  assert.equal(probe.events.filter(event=>event.event==='admitted').length,4,'terminating the worker never admits queued records');
  assert.deepEqual([...store.traces.keys()],['live']);assert.deepEqual(store.takeDelta(),{sources:[],traces:[],removedSources:[],removedTraces:[]});
  await assert.rejects(fs.access(`${directory}.lock`),{code:'ENOENT'});
 }finally{control.abort();await Promise.allSettled([restoring,rejected]);threads.Worker=Original;}
 await cache.restore(store,t.signal);assert.deepEqual([...store.traces.keys()],['group0']);
 assert.equal(store.summary(sources[7].file,new Map([[sources[7].file,'v1']])).total,2);
});
