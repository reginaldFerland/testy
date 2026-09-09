const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const analysis=require('../../out/services/analysis'),mtp=require('../../out/services/mtp');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

async function fixture(t,limit){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-preparation-pipeline-')),workspace=path.join(temp,'workspace'),storage=path.join(temp,'state');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),workspace,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]);
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:limit,maxParallelTestFiles:limit};
 const output=[],cleanup=[];
 const engine=new TestEngine({roots:[workspace],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 t.after(async()=>{control.abort();for(const release of cleanup)release();await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 return{engine,signal,storage,output,cleanup:release=>cleanup.push(release)};
}

for(const limit of [1,2,4])test(`analysis and discovery share ${limit} preparation worker${limit===1?'':'s'}`,{timeout:120000},async t=>{
 const f=await fixture(t,limit),entered=deferred(),release=deferred();
 const analyze=analysis.sourceAnalyses,request=mtp.requestTests;
 let active=0,peak=0,overlapped=false;
 const counted=async(slots,work)=>{active+=slots;peak=Math.max(peak,active);assert.ok(active<=limit,`${active} reserved workers exceeds ${limit}`);try{return await work();}finally{active-=slots;}};
 analysis.sourceAnalyses=(...args)=>counted(args[6],async()=>{
  entered.resolve();if(limit>1)await release.promise;return analyze(...args);
 });
 mtp.requestTests=async(options,operation,...args)=>{
  if(operation!=='discover')return request(options,operation,...args);
  await entered.promise;
  overlapped=active>0;
  return counted(1,async()=>{release.resolve();return request(options,operation,...args);});
 };
 f.cleanup(()=>{release.resolve();analysis.sourceAnalyses=analyze;mtp.requestTests=request;});
 const result=await f.engine.run({files:[],full:true},f.signal);
 assert.equal(result.passed,3,f.output.join(''));assert.equal(result.failed,0);
 assert.equal(overlapped,limit>1,'parallel mode overlaps the stages and sequential mode preserves one worker');
 assert.equal(peak,limit);assert.equal(active,0);
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});

test('discovery failure cancels and drains concurrent analysis before disposing the engine',{timeout:120000},async t=>{
 const f=await fixture(t,2),entered=deferred(),aborted=deferred(),finish=deferred();
 const analyze=analysis.sourceAnalyses,request=mtp.requestTests;
 analysis.sourceAnalyses=async(...args)=>{
  const signal=args[4].signal;entered.resolve();
  await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
  aborted.resolve();await finish.promise;signal.throwIfAborted();
 };
 mtp.requestTests=async(options,operation,...args)=>{
  if(operation!=='discover')return request(options,operation,...args);
  await entered.promise;throw new Error('controlled discovery failure');
 };
 f.cleanup(()=>{finish.resolve();analysis.sourceAnalyses=analyze;mtp.requestTests=request;});
 let settled=false;
 const rejected=assert.rejects(f.engine.run({files:[],full:true},f.signal),/controlled discovery failure/).then(()=>{settled=true;});
 await aborted.promise;
 assert.equal(settled,false,'the failed run still owns unfinished analysis');
 let disposed=false;const disposal=f.engine.dispose().then(()=>{disposed=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(disposed,false);
 finish.resolve();await Promise.all([rejected,disposal]);
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});
