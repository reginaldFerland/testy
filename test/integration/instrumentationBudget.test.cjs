const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {TestEngine}=require('../../out/services/engine');
const {RunnerSession}=require('../../out/services/runner');
const analysis=require('../../out/services/analysis'),processes=require('../../out/services/process');

function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});void promise.catch(()=>{});return{promise,resolve,reject};}
async function waitFor(gate,signal){
 signal?.throwIfAborted();if(!signal)return gate.promise;
 let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
 try{await Promise.race([gate.promise,cancelled]);signal.throwIfAborted();}finally{signal.removeEventListener('abort',abort);}
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture(t,limit){
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-instrument-budget-'))),root=path.join(temp,'workspace'),storage=path.join(temp,'state');
 const names=['Core','App','Infra','Web','Tests'];
 for(const [index,name]of names.entries()){
  const directory=path.join(root,name);await fs.mkdir(directory,{recursive:true});
  const reference=index?`<ItemGroup><ProjectReference Include="../${names[index-1]}/${names[index-1]}.csproj"/></ItemGroup>`:'';
  await fs.writeFile(path.join(directory,name+'.csproj'),`<Project Sdk="${index===4?'MSTest.Sdk/4.3.3':'Microsoft.NET.Sdk'}"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup>${reference}</Project>`);
  for(let file=0;file<4;file++)await fs.writeFile(path.join(directory,`Feature${file}.cs`),index===4
   ? `using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature${file}Tests { [TestMethod][DataRow(1)][DataRow(2)] public void Value(int value) { Assert.AreEqual(value+${file}, Layers.Web.Feature${file}.Value(value)); } }`
   : `namespace Layers.${name}; public static class Feature${file} { public static int Value(int value) => ${index?`Layers.${names[index-1]}.Feature${file}.Value(value)`:`value+${file}`}; }`);
 }
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:limit,maxParallelTestFiles:2};
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),release=deferred(),parsed=deferred(),analyzed=deferred(),output=[];
 const state={instrumented:0,primaryCommands:0,active:0,peak:0,primaryActive:0,primaryPeak:0,privateActive:0,privatePeak:0,privatePreparations:0,callback:undefined,analysisHeld:false,afterStart(){},phase:''};
 const originalRun=processes.runProcess,originalAnalyze=analysis.sourceAnalysisBatch,originalInstrument=RunnerSession.prototype.instrumentTemplate;
 let firstAnalysis=true,firstPrimary=true;
 analysis.sourceAnalysisBatch=async(...args)=>{
  if(!firstAnalysis)return originalAnalyze(...args);firstAnalysis=false;
  let result;try{result=await originalAnalyze(...args);}catch(error){parsed.reject(error);throw error;}
  state.analysisHeld=limit>1;parsed.resolve();
  if(limit>1){try{await waitFor(release,args[4].signal);}finally{state.analysisHeld=false;}}
  return result;
 };
 RunnerSession.prototype.instrumentTemplate=function(...args){
  if(this.options.preparationLane){state.privatePreparations++;assert.equal(this.options.tryInstrumentation,undefined,'private workers cannot borrow project capacity');}
  else state.callback=this.options.tryInstrumentation;
  return originalInstrument.apply(this,args);
 };
 processes.runProcess=async(command,args,options)=>{
  if(args[0]!=='instrument')return originalRun(command,args,options);
  const primary=!/[\\/]lanes[\\/]/i.test(args[1]);
  if(primary){
   await waitFor(parsed,options.signal);
   // Release the held analysis after DLL one, then let its post-helper
   // validation finish before DLL two completes. No wall-clock race is needed.
   if(++state.primaryCommands===2&&limit>1)await waitFor(analyzed,options.signal);
  }
  state.instrumented++;state.active++;state.peak=Math.max(state.peak,state.active);
  const active=primary?'primaryActive':'privateActive',peak=primary?'primaryPeak':'privatePeak';state[active]++;state[peak]=Math.max(state[peak],state[active]);
  try{
   if(primary&&state.analysisHeld)assert.equal(state.primaryActive,1,'analysis owns the other preparation slots');
   assert.ok(state.primaryActive<=limit);assert.ok(state.privateActive<=2);
   const pending=originalRun(command,args,options);void pending.catch(()=>{});state.afterStart(primary);
   return await pending;
  }finally{
   state.active--;state[active]--;
   if(primary&&firstPrimary){firstPrimary=false;release.resolve();}
  }
 };
 const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>{output.push(text);if(/Testy timing: Source analysis \d+ms/.test(text))analyzed.resolve();},phase:text=>{state.phase=text;},async discovered(){
   if(!state.callback)return;
   let started=false;const extra=state.callback(signal,async()=>{started=true;});await extra;
   assert.equal(extra,undefined,'the initial preparation budget is unavailable after discovery');assert.equal(started,false);
  },selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 t.after(async()=>{
  control.abort();release.resolve();parsed.resolve();analyzed.resolve();await engine.dispose();
  processes.runProcess=originalRun;analysis.sourceAnalysisBatch=originalAnalyze;RunnerSession.prototype.instrumentTemplate=originalInstrument;
  await fs.rm(temp,{recursive:true,force:true});
 });
 const stamps=async()=>Promise.all(names.flatMap(name=>['dll','pdb'].map(extension=>path.join(root,'Tests/bin/Debug/net10.0',`${name}.${extension}`))).map(async file=>{
  const stat=await fs.stat(file,{bigint:true});return[file,hash(await fs.readFile(file)),String(stat.mtimeNs),String(stat.ctimeNs)];
 }));
 return{engine,state,signal,output,storage,stamps,run:signal_=>engine.run({files:[],full:true},signal_??signal)};
}

function fingerprint(engine){return JSON.stringify({groups:engine.groups,coverage:[...engine.coverage.traces].map(([id,trace])=>[id,trace.dependencies,trace.coverage,trace.moduleProjects,trace.reliable])});}

for(const limit of [1,4])test(`managed DLL instrumentation shares ${limit} preparation slots with analysis and stays inside file-worker limits`,{timeout:180000},async t=>{
 const f=await fixture(t,limit),first=await f.run();
 assert.equal(first.passed,8,f.output.join(''));assert.equal(first.failed,0);assert.equal(first.coverageAvailable,true);
 assert.equal(f.state.active,0);assert.equal(f.state.primaryPeak===1,limit===1);
 assert.ok(f.state.privatePreparations>0);assert.ok(f.state.privatePeak<=2);
 for(const trace of f.engine.coverage.traces.values()){
  assert.equal(trace.reliable,true);assert.deepEqual(trace.moduleProjects,[]);
  for(const layer of ['Core','App','Infra','Web'])assert.ok(trace.coverage.some(source=>source.file.replaceAll('\\','/').toLowerCase().includes('/'+layer.toLowerCase()+'/')&&source.lines.some(line=>line.hits>0)));
 }
 const before=fingerprint(f.engine),stamps=await f.stamps(),instruments=f.state.instrumented;
 const repeat=await f.run();assert.equal(repeat.passed,8,f.output.join(''));
 assert.equal(f.state.instrumented,instruments,'warm prepared templates skip instrumentation');
 assert.equal(fingerprint(f.engine),before,'native identities, coverage and dependencies are unchanged');assert.deepEqual(await f.stamps(),stamps);
});

test('cancelling real parallel instrumentation drains processes and permits before a fresh preparation succeeds',{timeout:180000},async t=>{
 const f=await fixture(t,4),abort=new AbortController();let cancelled=false;
 f.state.afterStart=primary=>{if(primary&&f.state.primaryActive>1&&!cancelled){cancelled=true;abort.abort();}};
 await assert.rejects(f.run(AbortSignal.any([f.signal,abort.signal])),{name:'AbortError'});
 assert.equal(cancelled,true,'cancellation reaches concurrent real collector processes');assert.equal(f.state.active,0);
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[],'owned run outputs are drained');
 f.state.afterStart=()=>{};const result=await f.run();
 assert.equal(result.passed,8,f.output.join(''));assert.equal(result.coverageAvailable,true);assert.equal(f.state.active,0);
 for(const trace of f.engine.coverage.traces.values())assert.equal(trace.reliable,true);
});
