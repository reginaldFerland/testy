const test=require('node:test'),assert=require('node:assert/strict');
const {CoverageStore}=require('../../out/core/coverage');

const line=(line,hits)=>({line,hits});
const coverage=(file,hash,lines)=>({file,hash,lines});
const trace=(groupId,files,extra={})=>({groupId,coverage:files,dependencies:[],inputs:{},moduleProjects:[],reliable:true,timestamp:1,...extra});
const emptyDelta={sources:[],traces:[],removedSources:[],removedTraces:[]};
const sorted=values=>[...values].sort();

function calculations(store){
 const original=store.calculation,calls=[];
 store.calculation=function*(file){calls.push(file);return yield*original.call(this,file);};
 return{calls,clear(){calls.length=0;}};
}

test('identical fresh zero and positive reports reuse summaries while trace metadata and durable deltas advance',async()=>{
 const store=new CoverageStore(),file='/Positive.cs',zero='/Zero.cs',hashes=new Map([[file,'v1'],[zero,'v1'],['/old-input','old'],
  ...Array.from({length:4},(_,index)=>[`/input-${index}`,`v${index}`])]);
 const files=[coverage(file,'v1',[line(1,2.5),line(2,0)]),coverage(zero,'v1',[line(5,0)])],live=new Set(['one']);
 store.replace([trace('one',files,{dependencies:['/old-input'],inputs:{'/old-input':'old'},moduleProjects:['/Old.csproj']})],live);
 const initial=store.summarize(hashes),saved=JSON.stringify(initial);store.takeDelta();const probe=calculations(store);
 for(let index=0;index<4;index++){
  const dependency=`/input-${index}`,module=`/Module${index}.csproj`;
  await store.replaceAsync([trace('one',structuredClone(files),{timestamp:index+2,dependencies:[dependency],inputs:{[dependency]:`v${index}`},moduleProjects:[module]})],live);
  const next=await store.summarizeAsync(hashes);
  assert.equal(next,initial,'no visible coverage change retains the public summary array');
  assert.equal(await store.summarizeAsync(new Map(hashes)),initial,'equal hash values in a new map preserve the same cached array');
  assert.equal(store.summary(file,hashes),initial.find(summary=>summary.file===file));
  assert.equal(next.find(summary=>summary.file===file).lines,initial.find(summary=>summary.file===file).lines);
  assert.deepEqual(probe.calls,[],'equal reports do not calculate either positive or zero-hit summaries');
  assert.deepEqual(sorted(store.dependentGroups([dependency])),['one']);assert.deepEqual(sorted(store.dependentProjects([module])),['one']);
  assert.deepEqual(sorted(store.dependentGroups(['/old-input'])),[]);assert.deepEqual(sorted(store.dependentProjects(['/Old.csproj'])),[]);
  const delta=await store.takeDeltaAsync();assert.equal(delta.traces.length,1);assert.equal(delta.traces[0].timestamp,index+2);
  assert.deepEqual(delta.traces[0].dependencies,[dependency]);assert.deepEqual(delta.traces[0].inputs,{[dependency]:`v${index}`});
  assert.deepEqual(delta.traces[0].moduleProjects,[module]);assert.equal(delta.sources.length,2);
 }
 store.invalidate(live,false);assert.equal(await store.summarizeAsync(hashes),initial);assert.deepEqual(probe.calls,[]);
 const invalidated=store.takeDelta();assert.equal(invalidated.traces.length,1);assert.equal(invalidated.traces[0].reliable,false);
 assert.equal(invalidated.traces[0].stale,false,'loss of selection trust need not change the coverage display');
 assert.equal(JSON.stringify(initial),saved);
});

test('module-only trace addition, staleness and removal preserve coverage summaries while queries and deltas change',async()=>{
 const store=new CoverageStore(),file='/OnlyCoverage.cs',hashes=new Map([[file,'v1']]);
 store.replace([trace('one',[coverage(file,'v1',[line(1,2)])])],new Set(['one']));
 const initial=store.summarize(hashes),probe=calculations(store);store.takeDelta();
 await store.replaceAsync([trace('module-only',[],{dependencies:['/runtime-input'],moduleProjects:['/Runtime.csproj']})],new Set(['one','module-only']));
 store.markStale(new Set(['module-only']));assert.equal(await store.summarizeAsync(hashes),initial);assert.deepEqual(probe.calls,[]);
 assert.deepEqual(sorted(store.dependentGroups(['/runtime-input'])),['module-only']);assert.deepEqual(sorted(store.dependentProjects(['/Runtime.csproj'])),['module-only']);
 const added=store.takeDelta();assert.equal(added.traces.length,1);assert.equal(added.traces[0].groupId,'module-only');
 assert.equal(added.traces[0].stale,true);assert.deepEqual(added.sources,[]);
 store.replace([],new Set(['one']));assert.equal(await store.summarizeAsync(new Map(hashes)),initial);assert.deepEqual(probe.calls,[]);
 assert.deepEqual(sorted(store.dependentGroups(['/runtime-input'])),[]);assert.deepEqual(sorted(store.dependentProjects(['/Runtime.csproj'])),[]);
 assert.deepEqual(store.takeDelta(),{...emptyDelta,removedTraces:['module-only']});
});

test('historical-version stale counts skip nonzero and net-zero updates but still expose the final zero crossing',async()=>{
 const store=new CoverageStore(),file='/Versions.cs',hashes=new Map([[file,'v2']]),live=new Set(['current','old-a','old-b']);
 store.replace([
  trace('current',[coverage(file,'v2',[line(1,3)])]),
  trace('old-a',[coverage(file,'v1',[line(5,0)])]),
  trace('old-b',[coverage(file,'v1',[line(5,0)])])
 ],live);
 const fresh=store.summarize(hashes),saved=JSON.stringify(fresh);store.takeDelta();const probe=calculations(store);
 store.markStale(new Set(['old-a']));const stale=await store.summarizeAsync(hashes);
 assert.equal(stale[0].stale,true);assert.equal(stale[0].lines,fresh[0].lines);assert.deepEqual(probe.calls,[file]);probe.clear();
 store.markStale(new Set(['old-b']));assert.equal(await store.summarizeAsync(hashes),stale);
 store.markStale(new Set(['old-a']),false);assert.equal(await store.summarizeAsync(hashes),stale);
 assert.deepEqual(probe.calls,[],'one-to-two and two-to-one stale owners preserve the cached summary');
 store.markStale(new Set(['old-b']),false);store.markStale(new Set(['old-a']));
 assert.equal(await store.summarizeAsync(hashes),stale);assert.deepEqual(probe.calls,[],'a staged owner swap applies a net-zero count change');
 store.markStale(new Set(['old-a']),false);const recovered=await store.summarizeAsync(hashes);
 assert.equal(recovered[0].stale,false);assert.deepEqual(probe.calls,[file]);probe.clear();store.takeDelta();
 store.markStale(new Set(['old-a']));store.markStale(new Set(['old-a']),false);
 assert.equal(await store.summarizeAsync(hashes),recovered);assert.deepEqual(probe.calls,[]);assert.deepEqual(store.takeDelta(),emptyDelta);
 store.markHistorical(new Set(['old-a']));const historical=await store.summarizeAsync(hashes);assert.equal(historical[0].stale,true);probe.clear();
 store.markStale(new Set(['old-a']),false);assert.equal(await store.summarizeAsync(hashes),historical);assert.deepEqual(probe.calls,[]);
 live.delete('old-a');store.replace([],live);assert.equal((await store.summarizeAsync(hashes))[0].stale,false);
 assert.equal(JSON.stringify(fresh),saved);
});

test('retained memberships explicitly dirty changed and deleted positive contributions',async()=>{
 const store=new CoverageStore(),file='/Hits.cs',hashes=new Map([[file,'v1']]),live=new Set(['one','two']);
 const one=hits=>trace('one',[coverage(file,'v1',[line(1,hits),line(2,hits?2:0),line(3,0)])]);
 store.replace([one(5),trace('two',[coverage(file,'v1',[line(1,2)])])],live);
 const initial=store.summarize(hashes),saved=JSON.stringify(initial),probe=calculations(store);
 await store.replaceAsync([one(4)],live);assert.deepEqual((await store.summarizeAsync(hashes))[0].lines,[line(1,4),line(2,2),line(3,0)]);
 assert.deepEqual(probe.calls,[file]);probe.clear();
 await store.replaceAsync([one(0)],live);const remaining=(await store.summarizeAsync(hashes))[0];
 assert.deepEqual(remaining.lines,[line(1,2),line(2,0),line(3,0)]);assert.deepEqual(remaining.groupIds,['one','two']);assert.deepEqual(probe.calls,[file]);probe.clear();
 await store.replaceAsync([trace('two',[coverage(file,'v1',[line(1,0)])])],live);
 assert.deepEqual((await store.summarizeAsync(hashes))[0].lines,[line(1,0),line(2,0),line(3,0)]);assert.deepEqual(probe.calls,[file]);
 assert.equal(JSON.stringify(initial),saved);
});

test('historical hit removal, pending hash switches and geometry growth survive equal-report reuse',async()=>{
 const store=new CoverageStore(),file='/History.cs',live=new Set(['current','old']);let hashes=new Map([[file,'v2']]);
 const old=lines=>trace('old',[coverage(file,'v1',lines)]);
 store.replace([trace('current',[coverage(file,'v2',[line(1,7)])]),old([line(5,3)])],live);
 const initial=store.summarize(hashes),saved=JSON.stringify(initial);assert.equal(initial[0].stale,true);const probe=calculations(store);
 await store.replaceAsync([old([line(5,0)])],live);const current=await store.summarizeAsync(hashes);
 assert.equal(current[0].stale,false,'removing the last old-version positive contribution clears historical staleness');
 assert.equal(current[0].lines,initial[0].lines);assert.deepEqual(probe.calls,[file]);probe.clear();
 hashes=new Map([[file,'v1']]);assert.equal(store.summary('/Unrelated.cs',hashes),undefined);
 await store.replaceAsync([old([line(5,0)])],live);
 const switched=await store.summarizeAsync(hashes);assert.deepEqual(switched[0].lines,[line(5,0)]);assert.equal(switched[0].stale,true);
 assert.deepEqual(probe.calls,[file],'an equal report cannot clear a pending source-hash invalidation');probe.clear();
 store.replace([old([line(5,0),line(6,0)])],live);await store.replaceAsync([old([line(5,0),line(6,0)])],live);
 const grown=await store.summarizeAsync(hashes);assert.deepEqual(grown[0].lines,[line(5,0),line(6,0)]);assert.deepEqual(probe.calls,[file]);
 assert.equal(JSON.stringify(initial),saved);
});

test('equal replacements preserve earlier dirty hits, geometry and unapplied freshness changes',async()=>{
 const store=new CoverageStore(),file='/Pending.cs',hashes=new Map([[file,'v1']]),live=new Set(['one','zero']);
 const positive=hits=>trace('one',[coverage(file,'v1',[line(1,hits)])]);
 const zero=lines=>trace('zero',[coverage(file,'v1',lines.map(number=>line(number,0)))]);
 store.replace([positive(1),zero([2])],live);store.summarize(hashes);const probe=calculations(store);
 store.replace([positive(7)],live);await store.replaceAsync([positive(7)],live);
 assert.deepEqual((await store.summarizeAsync(hashes))[0].lines,[line(1,7),line(2,0)]);assert.deepEqual(probe.calls,[file]);probe.clear();
 store.replace([zero([2,3])],live);await store.replaceAsync([positive(7)],live);
 assert.deepEqual((await store.summarizeAsync(hashes))[0].lines,[line(1,7),line(2,0),line(3,0)]);assert.deepEqual(probe.calls,[file]);probe.clear();
 store.markStale(new Set(['one']));await store.replaceAsync([zero([2,3])],live);
 assert.equal((await store.summarizeAsync(hashes))[0].stale,true);assert.deepEqual(probe.calls,[file]);probe.clear();
 store.markStale(new Set(['one']),false);await store.replaceAsync([positive(7)],live);
 assert.equal((await store.summarizeAsync(hashes))[0].stale,false);assert.deepEqual(probe.calls,[file]);
});

test('changing a group ID changes public ownership even when its entire report is identical',async()=>{
 const store=new CoverageStore(),file='/Owners.cs',hashes=new Map([[file,'v1']]),files=[coverage(file,'v1',[line(1,3),line(2,0)])];
 store.replace([trace('old-id',files)],new Set(['old-id']));const original=store.summarize(hashes),probe=calculations(store);store.takeDelta();
 await store.replaceAsync([trace('new-id',structuredClone(files))],new Set(['new-id']));
 const changed=await store.summarizeAsync(hashes);assert.deepEqual(changed[0].groupIds,['new-id']);assert.deepEqual(probe.calls,[file]);
 assert.deepEqual(original[0].groupIds,['old-id']);assert.deepEqual(changed[0].lines,original[0].lines);
 const delta=store.takeDelta();assert.deepEqual(delta.removedTraces,['old-id']);assert.deepEqual(delta.traces.map(trace=>trace.groupId),['new-id']);
});

test('dense comparisons detect a changed last value and a deleted positive tail',async()=>{
 const store=new CoverageStore(),file='/Dense.cs',hashes=new Map([[file,'v1']]),live=new Set(['one']),count=16384;
 const dense=last=>trace('one',[coverage(file,'v1',Array.from({length:count},(_,index)=>line(index+1,index===count-1?last:1)))]);
 store.replace([dense(1)],live);const initial=store.summarize(hashes),saved=JSON.stringify(initial),probe=calculations(store);
 await store.replaceAsync([dense(9)],live);let result=(await store.summarizeAsync(hashes))[0];
 assert.equal(result.total,count);assert.equal(result.covered,count);assert.deepEqual(result.lines.at(-1),line(count,9));
 assert.ok(result.lines.slice(0,-1).every(value=>value.hits===1));assert.deepEqual(probe.calls,[file]);probe.clear();
 await store.replaceAsync([dense(0)],live);result=(await store.summarizeAsync(hashes))[0];
 assert.equal(result.total,count);assert.equal(result.covered,count-1);assert.deepEqual(result.lines.at(-1),line(count,0));assert.deepEqual(probe.calls,[file]);
 assert.equal(JSON.stringify(initial),saved);
});

for(const cancel of [true,false])test(`${cancel?'cancellation':'concurrent replacement'} during staged equality cannot reuse an obsolete aggregate`,{timeout:10000},async t=>{
 const store=new CoverageStore(),file='/Comparison.cs',hashes=new Map([[file,'v1']]),live=new Set(['one']),count=16384;
 let armed=false,oldReads=0,ready;const compared=new Promise(resolve=>ready=resolve);
 const oldLines=Array.from({length:count},(_,index)=>({line:index+1,get hits(){if(armed&&++oldReads===1)ready();return 3;}}));
 const incoming=hits=>trace('one',[coverage(file,'v1',Array.from({length:count},(_,index)=>line(index+1,hits)))],{timestamp:2,moduleProjects:['/Incoming.csproj']});
 store.replace([trace('one',[coverage(file,'v1',oldLines)],{moduleProjects:['/Original.csproj']})],live);
 const initial=store.summarize(hashes),saved=JSON.stringify(initial),beforeTrace=JSON.stringify(store.traces.get('one'));store.takeDelta();
 const revision=store.revision,probe=calculations(store),control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]);
 armed=true;const replacing=store.replaceAsync([incoming(3)],live,signal);
 const settlement=replacing.then(()=>{throw new Error('replacement completed without yielding inside its old-hit comparison');},error=>{throw error;});
 // Observe the first old-hit comparison, not an arbitrary earlier packing yield.
 try{
  await Promise.race([compared,settlement]);assert.ok(oldReads>0&&oldReads<count);armed=false;
  assert.equal(store.revision,revision);assert.equal(JSON.stringify(store.traces.get('one')),beforeTrace);
  if(cancel){
   control.abort();await assert.rejects(replacing,{name:'AbortError'});
   assert.equal(store.revision,revision);assert.equal(await store.summarizeAsync(hashes),initial);assert.deepEqual(probe.calls,[]);
   assert.deepEqual(store.takeDelta(),emptyDelta);assert.equal(JSON.stringify(store.traces.get('one')),beforeTrace);
  }else{
   store.replace([incoming(9)],live);const intervening=store.summary(file,hashes);assert.ok(intervening.lines.every(value=>value.hits===9));
   probe.clear();await replacing;
   const result=(await store.summarizeAsync(hashes))[0];assert.ok(result.lines.every(value=>value.hits===3));
   assert.notEqual(result,intervening);assert.deepEqual(probe.calls,[file],'the commit checks the current contribution before preserving its aggregate');
   assert.ok(intervening.lines.every(value=>value.hits===9));assert.deepEqual(store.traces.get('one').moduleProjects,['/Incoming.csproj']);
   assert.equal(store.takeDelta().traces[0].timestamp,2);
  }
  assert.equal(JSON.stringify(initial),saved);
 }finally{armed=false;control.abort();await Promise.allSettled([replacing,settlement]);}
});
