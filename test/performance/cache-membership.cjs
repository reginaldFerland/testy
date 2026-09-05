const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CoverageStore}=require('../../out/core/coverage'),{CoverageCache}=require('../../out/services/cache'),{contentHash}=require('../../out/core/paths');

(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-membership-benchmark-'));
 try {
  const sources=Array.from({length:1000},(_,i)=>({id:contentHash(`/Source${i}.cs\0v1`),file:`/Source${i}.cs`,hash:'v1',lines:[1]}));
  const sourceIds=sources.map(source=>source.id);
  const traces=Array.from({length:1000},(_,i)=>({groupId:`group${i}`,sourceIds,dependencies:[`/Source${i}.cs`],inputs:{[`/Source${i}.cs`]:'v1'},reliable:true,stale:false,timestamp:1,
   coverage:[{file:`/Source${i}.cs`,hash:'v1',lines:[{line:1,hits:1}]}]}));
  await new CoverageCache(root,()=>{}).save({sources,traces,removedSources:[],removedTraces:[]});
  const store=new CoverageStore();let previous=performance.now(),maxTimerGapMs=0,ticks=0;
  const timer=setInterval(()=>{const now=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,now-previous);previous=now;ticks++;},1);
  const start=performance.now();
  try {await new CoverageCache(root,()=>{}).restore(store);await new Promise(resolve=>setTimeout(resolve,10));}finally{clearInterval(timer);}
  const elapsedMs=performance.now()-start;
  assert.equal(store.traces.size,1000);assert.equal(store.summary('/Source999.cs',new Map([['/Source999.cs','v1']])).groupIds.length,1000);
  console.log(JSON.stringify({sourceMemberships:1000000,elapsedMs,maxTimerGapMs,ticks}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
