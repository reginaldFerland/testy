const test=require('node:test'),assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {CoverageStore}=require('../../out/core/coverage');

const line=(line,hits)=>({line,hits});
const coverage=(file,hash,lines)=>({file,hash,lines});
const trace=(groupId,files,extra={})=>({groupId,dependencies:files.map(file=>file.file),coverage:files,reliable:true,timestamp:1,...extra});
const emptyDelta={sources:[],traces:[],removedSources:[],removedTraces:[]};
const clone=value=>structuredClone(value);
const byFile=values=>[...values].sort((a,b)=>a.file.localeCompare(b.file));
const ids=values=>[...values].sort();

// A disk-checkpoint model uses only public deltas. Every query below scans its
// plain records rather than sharing CoverageStore's ownership/staleness indexes.
class Checkpoint {
 sources=new Map();traces=new Map();
 apply(delta){
  for(const id of delta.removedTraces)this.traces.delete(id);
  for(const id of delta.removedSources)this.sources.delete(id);
  for(const source of delta.sources)this.sources.set(source.id,clone(source));
  for(const value of delta.traces)this.traces.set(value.groupId,clone(value));
 }
 dependencies(files,module=false){
  return ids([...this.traces.values()].filter(trace=>(module?trace.moduleProjects??[]:trace.dependencies).some(file=>files.includes(file))).map(trace=>trace.groupId));
 }
 summaries(hashes){
  const files=new Map();
  for(const source of this.sources.values()){
   const owners=[...this.traces.values()].filter(trace=>trace.sourceIds.includes(source.id));
   if(owners.length){const versions=files.get(source.file)??[];versions.push({source,owners});files.set(source.file,versions);}
  }
  return byFile([...files].map(([file,versions])=>{
   const current=versions.find(version=>version.source.hash===hashes.get(file)),displayed=current??versions.at(-1),hits=new Map(),owners=new Set();
   let stale=!current;
   for(const version of versions)for(const owner of version.owners){
    owners.add(owner.groupId);stale||=!!owner.stale;
    const contribution=owner.coverage.filter(value=>value.file===file&&value.hash===version.source.hash).at(-1);
    if(contribution){stale||=version!==current;if(version===displayed)for(const value of contribution.lines)hits.set(value.line,Math.max(hits.get(value.line)??0,value.hits));}
   }
   const lines=displayed.source.lines.map(line=>({line,hits:hits.get(line)??0}));
   return{file,lines,stale,total:lines.length,covered:lines.filter(line=>line.hits>0).length,groupIds:ids(owners)};
  }));
 }
 check(store,hashes,summaries){
  assert.deepEqual(ids(store.traces.keys()),ids(this.traces.keys()));
  for(const [id,value]of this.traces)assert.deepEqual(store.traces.get(id),value,`public delta preserves trace ${id}`);
  const dependencies=ids(new Set([...this.traces.values()].flatMap(trace=>trace.dependencies)));
  const modules=ids(new Set([...this.traces.values()].flatMap(trace=>trace.moduleProjects??[])));
  for(const file of [...dependencies,'/not-owned.cs'])assert.deepEqual(ids(store.dependentGroups([file,file])),this.dependencies([file]));
  for(const project of [...modules,'/not-owned.csproj'])assert.deepEqual(ids(store.dependentProjects([project,project])),this.dependencies([project],true));
  assert.deepEqual(ids(store.dependentGroups(dependencies)),this.dependencies(dependencies));
  assert.deepEqual(ids(store.dependentProjects(modules)),this.dependencies(modules,true));
  assert.deepEqual(byFile(summaries),this.summaries(hashes));
 }
}

test('same-owner replacements update hits, dependencies and module ownership without losing shared source geometry',()=>{
 const store=new CoverageStore(),file='/Shared.cs',hashes=new Map([[file,'v1']]),live=new Set(['one','two']);
 store.replace([
  trace('one',[coverage(file,'v1',[line(1,5),line(2,0)])],{dependencies:[file,'/old-input'],moduleProjects:['/Old.csproj']}),
  trace('two',[coverage(file,'v1',[line(1,2),line(3,0)])],{moduleProjects:['/Shared.csproj']})
 ],live);
 const original=store.summarize(hashes),saved=JSON.stringify(original),checkpoint=new Checkpoint();checkpoint.apply(store.takeDelta());
 for(let replacement=0;replacement<8;replacement++){
  const dependency=`/input-${replacement%2}`,module=`/Module${replacement%2}.csproj`;
  store.replace([trace('one',[
   coverage(file,'v1',[line(1,replacement%3),line(4,0)]),coverage(file,'v1',[line(2,0)])
  ],{dependencies:[file,dependency,dependency],moduleProjects:[module,module],timestamp:replacement+2})],live);
  const actual=store.summarize(hashes);checkpoint.apply(store.takeDelta());checkpoint.check(store,hashes,actual);
  assert.deepEqual(actual[0].groupIds,['one','two'],'duplicate source reports create one ownership membership');
  assert.deepEqual(actual[0].lines,[line(1,Math.max(2,replacement%3)),line(2,0),line(3,0),line(4,0)]);
  assert.deepEqual(ids(store.dependentGroups(['/old-input'])),[]);assert.deepEqual(ids(store.dependentProjects(['/Old.csproj'])),[]);
  store.markStale(new Set(['one']));assert.equal(store.summary(file,hashes).stale,true);
  store.markStale(new Set(['one']),false);assert.equal(store.summary(file,hashes).stale,false,'a duplicated membership cannot leave a stale owner behind');
  checkpoint.apply(store.takeDelta());
 }
 store.replace([],new Set(['two']));const remaining=store.summarize(hashes);checkpoint.apply(store.takeDelta());checkpoint.check(store,hashes,remaining);
 assert.deepEqual(remaining[0].groupIds,['two']);assert.deepEqual(remaining[0].lines,[line(1,2),line(2,0),line(3,0),line(4,0)]);
 assert.equal(JSON.stringify(original),saved);
});

test('stale reversal, invalidation and historical ownership preserve checkpoint deltas and unrelated versions',()=>{
 const store=new CoverageStore(),file='/Versions.cs',hashes=new Map([[file,'v2']]),live=new Set(['current','old-zero','old-hit']);
 store.replace([
  trace('current',[coverage(file,'v2',[line(1,3),line(2,0)])],{dependencies:[],inputs:{}}),
  trace('old-zero',[coverage(file,'v1',[line(5,0)])],{dependencies:[],inputs:{}})
 ],live);
 const initial=store.summary(file,hashes);store.takeDelta();assert.equal(initial.stale,false);
 store.markStale(new Set(['old-zero']));assert.equal(store.summary(file,hashes).stale,true);
 store.markStale(new Set(['old-zero']),false);assert.equal(store.summary(file,hashes).stale,false);
 assert.deepEqual(store.takeDelta(),emptyDelta,'an unpersisted stale transition and its reversal cancel the delta');
 store.invalidate(new Set(['old-zero']),false);assert.equal(store.traces.get('old-zero').reliable,false);assert.equal(store.summary(file,hashes).stale,false);
 assert.deepEqual(store.takeDelta().traces.map(trace=>[trace.groupId,trace.reliable,trace.stale]),[['old-zero',false,false]]);
 store.markStale(new Set(['current']));const saved=store.takeDelta();store.markStale(new Set(['current']),false);store.retryDelta(saved);
 const retried=store.takeDelta();assert.equal(retried.traces.length,1);assert.equal(retried.traces[0].stale,false,'retry emits the current trace, not the stale saved object');
 store.replace([trace('old-hit',[coverage(file,'v1',[line(5,1)])],{dependencies:[],inputs:{}})],live);
 const olderHit=store.summary(file,hashes);assert.equal(olderHit.stale,true);assert.equal(olderHit.lines,initial.lines);
 store.markHistorical(new Set(['old-zero']));store.markStale(new Set(['old-zero']),false);
 assert.equal(store.traces.get('old-zero').historical,true);assert.equal(store.traces.get('old-zero').stale,true);
 store.replace([],new Set(['current','old-zero']));assert.equal(store.summary(file,hashes).stale,true,'historical zero-hit ownership remains stale after removing old positive hits');
 store.replace([],new Set(['current']));assert.equal(store.summary(file,hashes).stale,false);
 assert.equal(initial.stale,false);assert.deepEqual(initial.groupIds,['current','old-zero']);
});

test('replacing or removing an owner with an unapplied stale transition preserves other stale memberships',()=>{
 for(const operation of ['retain','change-version','remove']){
  const store=new CoverageStore(),file='/Pending.cs',hashes=new Map([[file,'v1']]),live=new Set(['pending','stale']);
  store.replace([
   trace('pending',[coverage(file,'v1',[line(1,2)])],{dependencies:[],inputs:{}}),
   trace('stale',[coverage(file,'v1',[line(2,0)])],{dependencies:[],inputs:{},stale:true})
  ],live);
  assert.equal(store.summary(file,hashes).stale,true);store.takeDelta();
  store.markStale(new Set(['pending']));
  if(operation==='remove')store.replace([],new Set(['stale']));
  else store.replace([trace('pending',[coverage(file,operation==='change-version'?'v2':'v1',[line(1,2)])],{dependencies:[],inputs:{}})],live);
  const current=operation==='change-version'?new Map([[file,'v2']]):hashes;
  assert.equal(store.summary(file,current).stale,true,`${operation} must not consume the other owner's already-applied stale membership`);
  store.markStale(new Set(['stale']),false);
  assert.equal(store.summary(file,current).stale,false,`${operation} must not leave a stale count after both surviving owners are fresh`);
 }
});

test('ownership summaries and deltas match a scanned checkpoint through a deterministic mixed operation trace',async()=>{
 const store=new CoverageStore(),checkpoint=new Checkpoint(),files=Array.from({length:7},(_,index)=>`/File${index}.cs`);
 let hashes=new Map(files.map(file=>[file,'v1'])),seed=0x63b5f729;const retained=[];
 const random=max=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%max;};
 for(let step=0;step<180;step++){
  const live=new Set(checkpoint.traces.keys()),group=`group${random(15)}`,operation=random(10);
  if(operation<5||!live.size){
   live.add(group);const selected=files.filter(()=>random(3)===0);if(!selected.length)selected.push(files[random(files.length)]);
   const values=selected.map(file=>coverage(file,random(4)?hashes.get(file):`v${1+random(3)}`,
    Array.from({length:1+random(8)},(_,index)=>line(index+1,random(4)))));
   if(random(3)===0)values.push(coverage(values[0].file,values[0].hash,[line(10,0)]));
   const module=`/Project${random(4)}.csproj`,next=trace(group,values,{reliable:random(4)!==0,moduleProjects:[module,module],timestamp:step});
   if(step%2)await store.replaceAsync([next],live);else store.replace([next],live);
  }else if(operation===5){live.delete(group);store.replace([],live);}
  else if(operation===6)store.markStale(new Set([group]),!!random(2));
  else if(operation===7)store.invalidate(new Set([group]),!!random(2));
  else if(operation===8)store.markHistorical(new Set([group]));
  else{hashes=new Map(hashes);hashes.set(files[random(files.length)],`v${1+random(3)}`);}
  const summaries=step%2?await store.summarizeAsync(hashes):store.summarize(hashes);
  const delta=step%3?store.takeDelta():await store.takeDeltaAsync();checkpoint.apply(delta);checkpoint.check(store,hashes,summaries);
  for(const [value,json]of retained)assert.equal(JSON.stringify(value),json,'previous summaries and deltas remain immutable');
  if(step%29===0)retained.push([summaries,JSON.stringify(summaries)],[delta,JSON.stringify(delta)]);
 }
});

test('packed restoration rebuilds ownership and module queries identically for sync and async checkpoints',async()=>{
 const original=new CoverageStore(),hashes=new Map([['/A.cs','v1'],['/B.cs','v2']]);
 original.replace([
  trace('one',[coverage('/A.cs','v1',[line(3,2),line(1,0)]),coverage('/B.cs','v1',[line(1,0)])],{moduleProjects:['/Core.csproj']}),
  trace('two',[coverage('/A.cs','v1',[line(4,0)]),coverage('/B.cs','v2',[line(2,1)])],{moduleProjects:['/Other.csproj']}),
  trace('module-only',[],{dependencies:['/input.json'],moduleProjects:['/Core.csproj']})
 ],new Set(['one','two','module-only']));
 const packed=original.takeDelta(),missing={...packed.traces[0],groupId:'missing-source',sourceIds:['absent']};
 const sync=new CoverageStore(),asyncStore=new CoverageStore();
 sync.restorePacked(packed.sources,[...packed.traces,missing]);await asyncStore.restorePackedAsync(packed.sources,[...packed.traces,missing]);
 assert.deepEqual(byFile(await asyncStore.summarizeAsync(hashes)),byFile(sync.summarize(hashes)));
 for(const store of [sync,asyncStore]){
  assert.deepEqual(ids(store.traces.keys()),['module-only','one','two']);assert.ok([...store.traces.values()].every(trace=>!trace.reliable&&trace.stale));
  assert.deepEqual(ids(store.dependentGroups(['/A.cs'])),['one','two']);assert.deepEqual(ids(store.dependentGroups(['/input.json'])),['module-only']);
  assert.deepEqual(ids(store.dependentProjects(['/Core.csproj'])),['module-only','one']);assert.deepEqual(store.takeDelta(),emptyDelta);
  store.replace([trace('one',[coverage('/A.cs','v1',[line(1,7)])],{moduleProjects:['/New.csproj']})],new Set(['one','two','module-only']));
  assert.deepEqual(ids(store.dependentProjects(['/Core.csproj'])),['module-only']);assert.deepEqual(ids(store.dependentProjects(['/New.csproj'])),['one']);
  store.markStale(new Set(['two']),false);assert.equal(store.summary('/A.cs',hashes).stale,false);
  assert.deepEqual(store.summary('/A.cs',hashes).lines,[line(1,7),line(3,0),line(4,0)]);
 }
 assert.deepEqual(byFile(await asyncStore.summarizeAsync(hashes)),byFile(sync.summarize(hashes)));
 assert.deepEqual(asyncStore.takeDelta(),sync.takeDelta());
});

const wideFiles=count=>Array.from({length:count},(_,index)=>coverage(`/Wide${index}.cs`,'v1',[line(1,1)]));

test('an unrelated synchronous summary cannot double-apply a paused asynchronous stale-membership update',async()=>{
 const store=new CoverageStore(),files=wideFiles(5000),unrelated='/Unrelated.cs',hashes=new Map([...files.map(file=>[file.file,file.hash]),[unrelated,'v1']]);
 store.replace([trace('wide',files),trace('unrelated',[coverage(unrelated,'v1',[line(1,3)])])],new Set(['wide','unrelated']));
 const initial=store.summarize(hashes),saved=JSON.stringify(initial),originalUnrelated=initial.find(summary=>summary.file===unrelated);
 store.takeDelta();store.markStale(new Set(['wide']));
 const pending=store.summarizeAsync(hashes);await turn();
 assert.equal(store.summary(unrelated,hashes),originalUnrelated,'an editor read of an unrelated source preserves its cached summary');
 const stale=await pending;assert.equal(stale.filter(summary=>summary.stale).length,files.length);
 store.markStale(new Set(['wide']),false);
 assert.ok((await store.summarizeAsync(hashes)).every(summary=>!summary.stale),'reversing one stale transition clears every wide-source membership exactly once');
 assert.equal(JSON.stringify(initial),saved);
});

test('cancelled dirty-owner traversal retries completely and concurrent membership changes supersede paused summaries',async()=>{
 const store=new CoverageStore(),files=wideFiles(5000),hashes=new Map(files.map(file=>[file.file,file.hash])),live=new Set(['wide']);
 store.replace([trace('wide',files)],live);const initial=store.summarize(hashes),saved=JSON.stringify(initial);store.takeDelta();
 store.markStale(live);const abort=new AbortController(),cancelled=store.summarizeAsync(hashes,abort.signal);
 await turn();abort.abort();await assert.rejects(cancelled,{name:'AbortError'});
 const stale=await store.summarizeAsync(hashes);assert.equal(stale.length,files.length);assert.ok(stale.every(summary=>summary.stale));
 store.markStale(live,false);const pending=store.summarizeAsync(hashes);
 await turn();
 store.replace([
  trace('wide',[coverage(files[0].file,'v1',[line(1,7)])]),
  trace('survivor',[coverage(files.at(-1).file,'v1',[line(1,0)])])
 ],new Set(['wide','survivor']));
 store.markHistorical(new Set(['wide']));
 const editor=store.summary(files[0].file,hashes),completed=await pending;
 assert.equal(completed.length,2);assert.equal(completed.find(summary=>summary.file===files[0].file),editor);
 assert.equal(editor.stale,true);assert.deepEqual(editor.lines,[line(1,7)]);
 assert.equal(completed.find(summary=>summary.file===files.at(-1).file).stale,false);
 assert.deepEqual(ids(store.dependentGroups([files[1].file])),[],'removed memberships cannot remain in dependency queries');
 assert.equal(JSON.stringify(initial),saved);
});

test('cancelled replacement and obsolete packed restoration never publish partial ownership indexes',async()=>{
 const store=new CoverageStore(),original=trace('current',[coverage('/Current.cs','v1',[line(1,2)])],{moduleProjects:['/Current.csproj']});
 store.replace([original],new Set(['current']));store.takeDelta();const version=store.revision;
 const files=wideFiles(5000),abort=new AbortController(),replacement=store.replaceAsync([trace('wide',files)],new Set(['wide']),abort.signal);
 await turn();abort.abort();await assert.rejects(replacement,{name:'AbortError'});
 assert.equal(store.revision,version);assert.deepEqual(ids(store.traces.keys()),['current']);assert.deepEqual(ids(store.dependentProjects(['/Current.csproj'])),['current']);
 assert.deepEqual(store.takeDelta(),emptyDelta);
 const disk=new CoverageStore();disk.replace([trace('disk',files,{moduleProjects:['/Disk.csproj']})],new Set(['disk']));const packed=disk.takeDelta();
 const restoring=store.restorePackedAsync(packed.sources,packed.traces);
 await turn();store.replace([trace('newer',[coverage('/Newer.cs','v1',[line(2,1)])],{moduleProjects:['/Newer.csproj']})],new Set(['newer']));
 await restoring;assert.deepEqual(ids(store.traces.keys()),['newer']);assert.deepEqual(ids(store.dependentProjects(['/Disk.csproj'])),[]);
 assert.deepEqual(ids(store.dependentGroups([files[0].file])),[]);
 await store.restorePackedAsync(packed.sources,packed.traces);
 assert.deepEqual(ids(store.traces.keys()),['disk']);assert.deepEqual(ids(store.dependentProjects(['/Newer.csproj'])),[]);
 assert.deepEqual(ids(store.dependentProjects(['/Disk.csproj'])),['disk']);assert.deepEqual(ids(store.dependentGroups([files.at(-1).file])),['disk']);
 assert.deepEqual(store.takeDelta(),emptyDelta);
});

test('asynchronous delta retry observes membership replacement during serialization and clears only the current checkpoint',async()=>{
 const store=new CoverageStore(),files=wideFiles(5000);
 store.replace([trace('old',files,{moduleProjects:['/Old.csproj']})],new Set(['old']));
 const serializing=store.takeDeltaAsync();await turn();
 store.replace([trace('new',[coverage('/Latest.cs','v2',[line(3,4)])],{moduleProjects:['/Latest.csproj']})],new Set(['new']));
 const delta=await serializing,checkpoint=new Checkpoint();checkpoint.apply(delta);
 const hashes=new Map([['/Latest.cs','v2']]);checkpoint.check(store,hashes,await store.summarizeAsync(hashes));
 assert.deepEqual(delta.traces.map(trace=>trace.groupId),['new']);assert.deepEqual(delta.sources.map(source=>source.file),['/Latest.cs']);
 assert.deepEqual(ids(store.dependentProjects(['/Old.csproj'])),[]);assert.deepEqual(store.takeDelta(),emptyDelta);
});
