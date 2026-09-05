const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CoverageStore}=require('../../out/core/coverage'),{CoverageCache}=require('../../out/services/cache');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-checkpoint-'));
 try{
  for(const size of [100000,500000,1000000]){
   const store=new CoverageStore(),cache=new CoverageCache(path.join(root,String(size)),()=>{}),hashes=new Map();
   const coverage=Array.from({length:100},(_,i)=>{const file=`/code/Source${i}.cs`;hashes.set(file,'v1');return{file,hash:'v1',lines:Array.from({length:size/100},(_,j)=>({line:j+1,hits:1}))};});
   const trace={groupId:'g',dependencies:[],inputs:{},timestamp:1,reliable:true,coverage};
   await store.replaceAsync([trace],new Set(['g']));await cache.save(store.takeDelta());
   let last=performance.now(),gap=0;const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},5);
   await new Promise(r=>setTimeout(r,10));
   let start=performance.now();await store.replaceAsync([{...trace,timestamp:2}],new Set(['g']));const replaceMs=performance.now()-start;
   start=performance.now();await store.summarizeAsync(hashes);const summarizeMs=performance.now()-start;
   start=performance.now();await cache.save(store.takeDelta());const saveMs=performance.now()-start;
   await new Promise(r=>setTimeout(r,10));clearInterval(timer);
   console.log(JSON.stringify({case:'warm-checkpoint',positiveLines:size,files:100,replaceMs,summarizeMs,saveMs,maxTimerGapMs:gap}));
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
