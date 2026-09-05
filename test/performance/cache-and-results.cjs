const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),{createRequire}=require('node:module');
const repo=path.resolve(__dirname,'../..');
const {CoverageStore}=require(path.join(repo,'out/core/coverage')),{CoverageCache}=require(path.join(repo,'out/services/cache'));
const {normalizePath}=require(path.join(repo,'out/core/paths'));
(async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-review3-perf-'));
 try{
  const live=new Set(['dense']);
  for(const count of [100000,500000,1000000]){
   const hashes=new Map(),coverage=Array.from({length:1000},(_,i)=>{const file=`/source/File${i}.cs`;hashes.set(file,'v1');return{file,hash:'v1',lines:Array.from({length:count/1000},(_,j)=>({line:j+1,hits:1}))};});
   const store=new CoverageStore();let start=performance.now();store.replace([{groupId:'dense',dependencies:[],inputs:{},timestamp:1,reliable:true,coverage}],live);const ingest=performance.now()-start;
   start=performance.now();store.summarize(hashes);const summarize=performance.now()-start;
   const cache=new CoverageCache(path.join(temp,String(count)),()=>{});await cache.save(store.takeDelta());
   let calls=0;const createHash=crypto.createHash;crypto.createHash=(...args)=>{calls++;return createHash(...args);};
   let previous=performance.now(),maxGap=0;const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;},5);
   start=performance.now();await cache.restore(new CoverageStore());const restore=performance.now()-start;
   await new Promise(r=>setTimeout(r,10));clearInterval(timer);crypto.createHash=createHash;
   console.log(JSON.stringify({kind:'dense-coverage',lines:count,files:1000,ingestMs:ingest,summarizeMs:summarize,restoreMs:restore,restoreSha256Calls:calls,maxTimerGapMs:maxGap}));
  }
  const enginePath=path.join(repo,'out/services/engine.js'),realRequire=createRequire(enginePath);
  for(const count of [5000,10000,20000]){
   let groups,callbackMs;
   const exports={};
   class Session{
    constructor(options){this.options=options;}
    async discover(){return groups;}
    async run(selected){
     const results=[];const start=performance.now();
     for(const group of selected)for(const test of group.tests){const result={id:test.id,name:test.name,outcome:'passed',node:test.node};this.options.onResult(group,result);results.push(result);}
     callbackMs=performance.now()-start;
     return {executedGroups:selected,results,coverageAvailable:false,trace:{groupId:selected[0].id,dependencies:[],inputs:{},coverage:[],reliable:false,timestamp:1}};
    }
    async dispose(){}
   }
   vm.runInNewContext(sync.readFileSync(enginePath,'utf8'),{exports,require:name=>name==='./projects'?{...realRequire(name),evaluateProject:async()=>[project]}:name==='./runner'?{...realRequire(name),RunnerSession:Session}:name==='./process'?{...realRequire(name),runProcess:async()=>({code:0,stdout:'10.0.400',stderr:''})}:realRequire(name)});
   const project={file:path.join(temp,'Tests.csproj'),assembly:path.join(temp,'Tests.dll'),framework:'net10.0',sourceFiles:[],references:[],isTestProject:true};
   groups=[{id:'g',project:project.file,framework:project.framework,assembly:project.assembly,file:path.join(temp,'Tests.cs'),tests:Array.from({length:count},(_,i)=>({id:`case-${i}`,name:`Case ${i}`,node:{uid:`case-${i}`}}))}];
   Object.defineProperty(groups[0].tests,'some',{value:()=>{throw new Error('Live classification scanned discovered tests');}});
   const engine=new exports.TestEngine({roots:[temp],storage:temp,tools:temp,analyzer:'',configuration:()=>({dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000}),events:{output(){},phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
   engine.initialized=true;engine.structureDirty=false;engine.projects=[project];engine.groups=groups;engine.cache.save=async()=>{};
   await engine.run({files:[],full:false},new AbortController().signal,{groups:new Set(['g']),coverage:false});
   if(engine.runtime.size)throw new Error('Known results were classified as new runtime IDs');
   console.log(JSON.stringify({kind:'engine-result-callback',casesInOneFile:count,callbackMs,scope:'actual engine onResult callback with process and runner I/O mocked; no UI'}));
  }
 }finally{await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
