const test=require('node:test'),assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {CoverageStore}=require('../../out/core/coverage');

/** @typedef {import('../../out/core/model').Trace} Trace */
/** @typedef {import('../../out/core/model').FileCoverage} FileCoverage */
/** @typedef {import('../../out/core/model').CoveredLine} CoveredLine */
/** @typedef {import('../../out/core/coverage').CoverageSummary} CoverageSummary */
/** @typedef {import('../../out/core/coverage').CoverageSource} CoverageSource */
/** @typedef {import('../../out/core/coverage').StoredTrace} StoredTrace */

const file='/Code.cs',hashes=new Map([[file,'v1']]);
/** @type {(file:string,hash:string,lines:readonly CoveredLine[])=>FileCoverage} */
const coverage=(file,hash,lines)=>({file,hash,lines});
/** @type {(groupId:string,files:FileCoverage[],extra?:Partial<Trace>)=>Trace} */
const trace=(groupId,files,extra={})=>({groupId,dependencies:files.map(source=>source.file),coverage:files,reliable:true,timestamp:1,...extra});
/** @type {(line:number,hits:number)=>CoveredLine} */
const line=(line,hits)=>({line,hits});
/** @param {Iterable<CoverageSummary>} values */
const canonical=values=>[...values].sort((a,b)=>a.file.localeCompare(b.file));

/** The summary of a file the test has populated. @param {CoverageStore} store @param {string} file @param {ReadonlyMap<string,string>} hashes */
const summaryOf=(store,file,hashes)=>/** @type {CoverageSummary} */ (store.summary(file,hashes));

/** @param {CoverageStore} store @param {Map<string,CoverageSource>} sources */
function collectSources(store,sources){
 const delta=store.takeDelta();
 for(const id of delta.removedSources)sources.delete(id);
 for(const source of delta.sources)sources.set(source.id,source);
}

// Recompute from persisted geometry and public trace facts, without consulting
// the store's derived indexes or previously calculated summaries.
/** @param {ReadonlyMap<string,CoverageSource>} sources @param {ReadonlyMap<string,StoredTrace>} traces @param {ReadonlyMap<string,string>} hashes */
function referenceSummary(sources,traces,hashes){
 const byFile=/** @type {Map<string,{source:CoverageSource,members:StoredTrace[]}[]>} */ (new Map());
 for(const source of sources.values()){
  const members=[...traces.values()].filter(trace=>trace.sourceIds.includes(source.id));
  if(!members.length)continue;
  const versions=byFile.get(source.file)??[];
  versions.push({source,members});byFile.set(source.file,versions);
 }
 return canonical([...byFile].map(([file,versions])=>{
  const current=versions.find(version=>version.source.hash===hashes.get(file));
  const displayed=/** @type {{source:CoverageSource,members:StoredTrace[]}} */ (current??versions.at(-1)),hits=new Map(),groups=new Set();
  let stale=!current;
  for(const version of versions){
   for(const trace of version.members){
    groups.add(trace.groupId);stale||=!!trace.stale;
    const contribution=trace.coverage.filter(source=>source.file===file&&source.hash===version.source.hash).at(-1);
    if(!contribution)continue;
    stale||=version!==current;
    if(version===displayed)for(const value of contribution.lines)hits.set(value.line,Math.max(hits.get(value.line)??0,value.hits));
   }
  }
  const lines=displayed.source.lines.map(line=>({line,hits:hits.get(line)??0}));
  return{file,lines,stale,covered:hits.size,total:lines.length,groupIds:[...groups].sort()};
 }));
}

test('coverage aggregates match an independent recomputation across incremental changes and restoration',async()=>{
 let store=new CoverageStore(),sources=/** @type {Map<string,CoverageSource>} */ (new Map()),current=new Map(Array.from({length:6},(_,i)=>/** @type {[string,string]} */ ([`/Source${i}.cs`,'v1']))),seed=0x517cc1b7;
 const random=(/** @type {number} */ limit)=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%limit;};
 const retained=/** @type {[readonly CoverageSummary[],string][]} */ ([]);
 for(let step=0;step<220;step++){
  const live=new Set(store.traces.keys()),group=`group${random(18)}`,operation=random(10);
  if(operation<5||!live.size){
   live.add(group);
   const selected=[...current.keys()].filter(()=>random(3)===0);
   if(!selected.length)selected.push(`/Source${random(6)}.cs`);
   const files=selected.map(file=>coverage(file,random(4)?/** @type {string} */ (current.get(file)):`v${1+random(3)}`,
    Array.from({length:1+random(18)},()=>line(1+random(22),random(5)))));
   const next=trace(group,files,{reliable:random(5)!==0,stale:random(7)===0,timestamp:step});
   if(step%3===0)await store.replaceAsync([next],live);else store.replace([next],live);
  }else if(operation===5){live.delete(group);store.replace([],live);}
  else if(operation===6)store.markStale(new Set([group]),!!random(2));
  else if(operation===7)store.invalidate(new Set([group]),!!random(2));
  else if(operation===8)store.markHistorical(new Set([group]));
  else{current=new Map(current);current.set(`/Source${random(6)}.cs`,`v${1+random(3)}`);}
  const actual=step%2?await store.summarizeAsync(current):store.summarize(current);
  collectSources(store,sources);
  assert.deepEqual(canonical(actual),referenceSummary(sources,store.traces,current),`operation ${step}`);
  for(const [snapshot,json]of retained)assert.equal(JSON.stringify(snapshot),json,'published snapshots remain immutable');
  if(step%17===0)retained.push([actual,JSON.stringify(actual)]);
  if(step%43===42){
   const restored=new CoverageStore();
   if(step%2)await restored.restorePackedAsync([...sources.values()],[...store.traces.values()]);
   else restored.restorePacked([...sources.values()],[...store.traces.values()]);
   store=restored;
   assert.deepEqual(canonical(await store.summarizeAsync(current)),referenceSummary(sources,store.traces,current),'restored stale checkpoint');
  }
 }
});

test('zero-hit membership and freshness changes reuse line data without reading existing positive contributions',()=>{
 const store=new CoverageStore();let reads=0;
 const positive={line:1,get hits(){reads++;return 3;}};
 store.replace([trace('positive',[coverage(file,'v1',[positive,line(2,0)])])],new Set(['positive']));
 const initial=summaryOf(store,file,hashes),saved=JSON.stringify(initial),live=new Set(['positive','zero']);
 store.replace([trace('zero',[coverage(file,'v1',[line(1,0),line(2,0)])])],live);
 reads=0;
 const added=summaryOf(store,file,hashes);
 assert.equal(reads,0,'adding an uncovered assertion does not rescan unchanged positive lines');
 assert.equal(added.lines,initial.lines);assert.deepEqual(added.groupIds,['positive','zero']);
 store.markStale(new Set(['zero']));
 const stale=summaryOf(store,file,hashes);
 assert.equal(stale.stale,true);assert.equal(stale.lines,initial.lines);assert.equal(reads,0);
 store.markStale(new Set(['zero']),false);
 assert.equal(summaryOf(store,file,hashes).stale,false);assert.equal(reads,0);
 store.replace([],new Set(['positive']));
 const removed=summaryOf(store,file,hashes);
 assert.equal(removed.lines,initial.lines);assert.deepEqual(removed.groupIds,['positive']);assert.equal(reads,0);
 assert.equal(JSON.stringify(initial),saved);
});

test('max-hit replacements, retained geometry and historical source versions keep exact summaries and line identities',()=>{
 const store=new CoverageStore(),live=new Set(['high','low','zero']);
 store.replace([
  trace('high',[coverage(file,'v1',[line(1,9),line(2,2),line(3,0)])]),
  trace('low',[coverage(file,'v1',[line(1,3),line(2,2)])]),
  trace('zero',[coverage(file,'v1',[line(4,0)])],{dependencies:[],inputs:{}})
 ],live);
 const initial=summaryOf(store,file,hashes),snapshot=JSON.stringify(initial);
 store.replace([trace('low',[coverage(file,'v1',[line(1,2),line(2,2)])])],live);
 assert.equal(summaryOf(store,file,hashes).lines,initial.lines,'unchanged maxima retain the published line array');
 live.delete('high');store.replace([],live);
 assert.deepEqual(summaryOf(store,file,hashes).lines,[line(1,2),line(2,2),line(3,0),line(4,0)]);
 store.replace([trace('low',[coverage(file,'v2',[line(1,0),line(5,0)])])],live);
 const newer=new Map([[file,'v2']]);
 assert.equal(summaryOf(store,file,newer).stale,false,'an old zero-hit assertion alone does not stale the current version');
 store.replace([trace('zero',[coverage(file,'v1',[line(4,1)])])],live);
 const historical=summaryOf(store,file,newer);
 assert.equal(historical.stale,true);assert.equal(historical.covered,0);assert.deepEqual(historical.lines,[line(1,0),line(5,0)]);
 store.markHistorical(new Set(['zero']));store.markStale(new Set(['zero']),false);
 assert.equal(summaryOf(store,file,newer).stale,true);
 live.delete('zero');store.replace([],live);
 const current=summaryOf(store,file,newer);
 assert.equal(current.stale,false);assert.equal(current.lines,historical.lines);
 assert.equal(JSON.stringify(initial),snapshot);
});

test('cancelled aggregation and competing editor summaries cannot publish a partial or obsolete aggregate',async()=>{
 const store=new CoverageStore(),live=new Set(['one']);
 store.replace([trace('one',[coverage(file,'v1',[line(1,1)])])],live);
 const initial=summaryOf(store,file,hashes),snapshot=JSON.stringify(initial),count=18000;
 const dense=(/** @type {number} */ hits)=>trace('one',[coverage(file,'v1',Array.from({length:count},(_,index)=>line(index+1,hits)))]);
 await store.replaceAsync([dense(9)],live);
 const abort=new AbortController(),cancelled=store.summarizeAsync(hashes,abort.signal);
 await turn();abort.abort();await assert.rejects(cancelled,{name:'AbortError'});
 assert.equal(JSON.stringify(initial),snapshot);
 const pending=store.summarizeAsync(hashes);
 await turn();store.replace([dense(2)],live);store.markStale(live);
 const editor=summaryOf(store,file,hashes),completed=await pending;
 assert.equal(completed[0],editor);assert.equal(editor.stale,true);assert.equal(editor.covered,count);
 assert.ok(editor.lines.every(value=>value.hits===2));
 store.markStale(live,false);
 assert.equal(summaryOf(store,file,hashes).lines,editor.lines);
 assert.equal(JSON.stringify(initial),snapshot);
});

test('switching displayed source versions retains at most one derived line cache and preserves prior snapshots',async()=>{
 const store=new CoverageStore(),other='/Other.cs',count=12000;
 const dense=(/** @type {string} */ hash,/** @type {number} */ hits)=>coverage(file,hash,Array.from({length:count},(_,index)=>line(index+1,hits)));
 store.replace([
  trace('old',[dense('v1',3)],{dependencies:[],inputs:{}}),
  trace('new',[dense('v2',7)],{dependencies:[],inputs:{}}),
  trace('other',[coverage(other,'v1',[line(1,2)])])
 ],new Set(['old','new','other']));
 const first=summaryOf(store,file,hashes),saved=JSON.stringify(first);
 const otherSummary=summaryOf(store,other,new Map([...hashes,[other,'v1']]));
 // The store's source records are private; the test inspects which derived caches are retained.
 const cached=()=>/** @type {{source:CoverageSource,aggregate:unknown}[]} */ ([.../** @type {any} */ (store).sources.values()].filter((/** @type {{source:CoverageSource,aggregate:unknown}} */ source)=>source.source.file===file&&source.aggregate));
 assert.deepEqual(cached().map(source=>source.source.hash),['v1']);
 const second=summaryOf(store,file,new Map([[file,'v2'],[other,'v1']]));
 assert.equal(second.lines[0].hits,7);assert.deepEqual(cached().map(source=>source.source.hash),['v2']);
 const pending=store.summarizeAsync(new Map([...hashes,[other,'v1']]));
 await turn();
 const editor=summaryOf(store,file,new Map([[file,'v2'],[other,'v1']]));
 await pending;
 assert.deepEqual(cached().map(source=>source.source.hash),['v2'],'an older paused calculation cannot repopulate an undisplayed cache');
 assert.equal(summaryOf(store,file,new Map([...hashes,[other,'v1']])).lines[0].hits,3);
 assert.deepEqual(cached().map(source=>source.source.hash),['v1']);
 assert.equal(editor.lines[0].hits,7);assert.equal(JSON.stringify(first),saved);
 assert.equal(summaryOf(store,other,new Map([...hashes,[other,'v1']])).lines,otherSummary.lines);
});
