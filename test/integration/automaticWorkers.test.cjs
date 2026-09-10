const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
const processes=require('../../out/services/process'),mtp=require('../../out/services/mtp');

const workers=6;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};

async function fixture(t,{blocked=false}={}) {
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy automatic workers ')));
 const root=path.join(temp,'workspace'),storage=path.join(temp,'state'),barrier=path.join(temp,'started'),blocker=path.join(temp,'blocked');
 const file=relative=>normalizePath(path.join(root,relative));
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),running=new Set();
 const original={availableParallelism:os.availableParallelism,runProcess:processes.runProcess,requestTests:mtp.requestTests};
 let engine;
 t.after(async()=>{
  control.abort();
  try {await Promise.allSettled(running);await engine?.dispose();}
  finally {
   os.availableParallelism=original.availableParallelism;processes.runProcess=original.runProcess;mtp.requestTests=original.requestTests;
   await fs.rm(temp,{recursive:true,force:true});
  }
 });
 await fs.mkdir(file('Core'),{recursive:true});await fs.mkdir(file('Tests'));await fs.mkdir(barrier);
 if(blocked)await fs.writeFile(blocker,'hold real test hosts until cancellation');
 await fs.writeFile(file('Core/Core.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(file('Tests/Tests.csproj'),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Core/Core.csproj"/></ItemGroup></Project>');
 for(let index=0;index<workers;index++) {
  await fs.writeFile(file(`Core/Feature${index}.cs`),`public static class Feature${index} { public static int Value() => ${index+1}; }`);
  await fs.writeFile(file(`Tests/Feature${index}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting;
using System.Diagnostics;
[TestClass] public class Feature${index}Tests {
 [TestMethod] public void OwnFeature() {
  var barrier = ${JSON.stringify(barrier)};
  var temporary = Path.Combine(barrier, "Feature${index}.pending");
  File.WriteAllText(temporary, Environment.ProcessId.ToString());
  File.Move(temporary, Path.Combine(barrier, "Feature${index}.pid"), true);
  var timer = Stopwatch.StartNew();
  while (Directory.GetFiles(barrier, "*.pid").Length < ${workers} && timer.Elapsed < TimeSpan.FromSeconds(45)) Thread.Sleep(20);
  Assert.AreEqual(${workers}, Directory.GetFiles(barrier, "*.pid").Length, "All six real test hosts must reach the barrier together.");
  while (File.Exists(${JSON.stringify(blocker)}) && timer.Elapsed < TimeSpan.FromSeconds(60)) Thread.Sleep(20);
  Assert.IsFalse(File.Exists(${JSON.stringify(blocker)}), "The cancellation barrier timed out.");
  Assert.AreEqual(${index+1}, Feature${index}.Value());
 }
}`);
 }
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:90000,
  coverageTool:process.env.TESTY_COVERAGE_TOOL,maxParallelProjects:0,maxParallelTestFiles:0};
 const output=[],probe={runs:[],instruments:[],activeRequests:0,activeCommands:0};
 os.availableParallelism=()=>7;
 processes.runProcess=async(command,args,options)=>{
  probe.activeCommands++;
  if(args[0]==='instrument')probe.instruments.push({assembly:normalizePath(args[1]),session:args[args.indexOf('--session-id')+1]});
  try{return await original.runProcess(command,args,options);}finally{probe.activeCommands--;}
 };
 mtp.requestTests=async(options,operation,...args)=>{
  if(operation==='run')probe.runs.push({assembly:normalizePath(options.assembly),session:options.wrapper?.args[options.wrapper.args.indexOf('--session-id')+1]});
  probe.activeRequests++;
  try{return await original.requestTests(options,operation,...args);}finally{probe.activeRequests--;}
 };
 engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 const run=(abortSignal=signal)=>{
  const operation=engine.run({files:[],full:true,generation:903},AbortSignal.any([signal,abortSignal]));
  running.add(operation);void operation.then(()=>running.delete(operation),()=>running.delete(operation));return operation;
 };
 const pids=async()=>{
  const markers=(await fs.readdir(barrier)).filter(name=>/^Feature\d+\.pid$/.test(name));
  return Promise.all(markers.map(async name=>({index:Number(/^Feature(\d+)\.pid$/.exec(name)[1]),pid:Number(await fs.readFile(path.join(barrier,name),'utf8'))})));
 };
 const waitForHosts=async()=>{
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){signal.throwIfAborted();const values=await pids();if(values.length===workers)return values;await delay(20,undefined,{signal});}
  assert.fail(`Only ${(await pids()).length} actual test hosts reached the barrier.\n${output.join('')}`);
 };
 return{temp,root,storage,file,barrier,blocker,engine,probe,output,signal,run,pids,waitForHosts};
}

function assertIdentities(f,runs) {
 assert.equal(runs.length,workers);assert.equal(new Set(runs.map(run=>run.assembly)).size,workers,'every concurrent host executes its own private copy');
 assert.equal(new Set(runs.map(run=>run.session)).size,workers,'collector sessions remain exclusive across all automatic workers');
 for(const run of runs) {
  assert.match(run.session,/^[a-f\d-]{36}$/i);assert.ok(run.assembly.startsWith(normalizePath(f.storage)+'/'));
  const template=normalizePath(path.join(path.dirname(path.dirname(run.assembly)),'template','Tests.dll'));
  assert.ok(f.probe.instruments.some(instrument=>instrument.assembly===template&&instrument.session===run.session),'each collector uses the session embedded in its own template');
 }
}

function assertCoverage(f,result) {
 assert.equal(result.files,workers);assert.equal(result.tests,workers);assert.equal(result.passed,workers,f.output.join(''));
 assert.equal(result.failed,0);assert.equal(result.coverageAvailable,true);
 assert.equal(f.engine.groups.length,workers);assert.equal(f.engine.coverage.traces.size,workers);
 for(const group of f.engine.groups) {
  const index=Number(/^Feature(\d+)Tests\.cs$/i.exec(path.basename(group.file))[1]),expected=f.file(`Core/Feature${index}.cs`);
  const trace=f.engine.coverage.traces.get(group.id);assert.ok(trace?.reliable);assert.equal(!!trace.stale,false);
  assert.deepEqual(trace.dependencies.filter(file=>/\/Core\/Feature\d+\.cs$/i.test(file)),[expected],`Feature${index} retains only its own production dependency`);
  assert.deepEqual(trace.coverage.filter(source=>/\/Core\/Feature\d+\.cs$/i.test(source.file)&&source.lines.some(line=>line.hits>0)).map(source=>source.file),[expected]);
 }
 assert.ok(f.output.some(line=>line.includes('Testy concurrency: projects=4, test files=6.')));
 assert.equal(f.probe.activeRequests,0);assert.equal(f.probe.activeCommands,0);
}

test('automatic test-file workers exceed four actual processes while retaining isolated coverage',{timeout:150000},async t=>{
 const f=await fixture(t),result=await f.run(),pids=await f.pids();
 assertCoverage(f,result);assertIdentities(f,f.probe.runs);
 assert.equal(pids.length,workers);assert.equal(new Set(pids.map(value=>value.pid)).size,workers);
 assert.deepEqual(pids.map(value=>value.index).sort((a,b)=>a-b),[0,1,2,3,4,5]);
 assert.ok(pids.every(value=>Number.isSafeInteger(value.pid)&&value.pid>0&&!alive(value.pid)),'completed real hosts have exited');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});

test('cancelling six real automatic workers drains their hosts and resumes with fresh isolated coverage',{timeout:180000},async t=>{
 const f=await fixture(t,{blocked:true}),abort=new AbortController();
 const operation=f.run(abort.signal);void operation.catch(()=>undefined);
 const started=await Promise.race([f.waitForHosts(),operation.then(()=>{throw new Error('The run finished before all six blocked hosts started.');})]);
 assert.equal(new Set(started.map(value=>value.pid)).size,workers);
 assert.ok(started.every(value=>Number.isSafeInteger(value.pid)&&value.pid>0&&alive(value.pid)),'six distinct test hosts are simultaneously alive before cancellation');
 const cancelledRuns=[...f.probe.runs];assertIdentities(f,cancelledRuns);
 abort.abort();await assert.rejects(operation,{name:'AbortError'});
 assert.equal(f.probe.activeRequests,0);assert.equal(f.probe.activeCommands,0);
 assert.ok(started.every(value=>!alive(value.pid)),'cancellation awaits actual test-host exit');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
 assert.equal(f.engine.coverage.traces.size,0,'interrupted tests publish no successful coverage contribution');
 await fs.unlink(f.blocker);await fs.rm(f.barrier,{recursive:true});await fs.mkdir(f.barrier);
 f.probe.runs.length=0;
 const resumed=await f.run();assertCoverage(f,resumed);assertIdentities(f,f.probe.runs);
 const sessions=new Set(cancelledRuns.map(run=>run.session));
 assert.ok(f.probe.runs.every(run=>!sessions.has(run.session)),'cancelled prepared sessions are discarded before recovery');
 const completed=await f.pids();assert.equal(new Set(completed.map(value=>value.pid)).size,workers);
 assert.ok(completed.every(value=>!alive(value.pid)));assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});
