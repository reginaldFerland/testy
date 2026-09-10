const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
const processes=require('../../out/services/process'),mtp=require('../../out/services/mtp');

test('seventeen test targets retain every instrumented preparation through warm runs and clean restart',{timeout:180000},async t=>{
 const count=17,temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-adaptive-prepared-')));
 const root=path.join(temp,'workspace'),storage=path.join(temp,'state'),core=path.join(root,'Core','Core.cs');
 const engines=[],control=new AbortController(),signal=AbortSignal.any([t.signal,control.signal]);
 const runProcess=processes.runProcess,requestTests=mtp.requestTests;
 t.after(async()=>{
  control.abort();
  try{await Promise.all(engines.map(engine=>engine.dispose()));}
  finally{processes.runProcess=runProcess;mtp.requestTests=requestTests;await fs.rm(temp,{recursive:true,force:true});}
 });
 await fs.mkdir(path.dirname(core),{recursive:true});
 await fs.writeFile(path.join(root,'Core','Core.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(core,'public static class Core { public static int Value(int value) => value + 1; }');
 for(let index=0;index<count;index++){
  const name=`CapacitySuite${String(index).padStart(2,'0')}`,directory=path.join(root,name);await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,`${name}.csproj`),`<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><AssemblyName>${name}</AssemblyName><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Core/Core.csproj"/></ItemGroup></Project>`);
  await fs.writeFile(path.join(directory,`${name}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting;
 [TestClass] public class ${name}Tests { [TestMethod] public void UsesSharedCore() { Assert.AreEqual(${index+1},Core.Value(${index})); } }`);
 }
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,
  coverageTool:process.env.TESTY_COVERAGE_TOOL,maxParallelProjects:4,maxParallelTestFiles:1};
 const probe={instruments:[],discoveries:[],runs:[],builds:0,activeInstruments:0,activeRequests:0,activeRuns:0,peakInstruments:0,peakRequests:0,peakRuns:0};
 processes.runProcess=async(command,args,...rest)=>{
  if(args.includes('-target:Build'))probe.builds++;
  if(args[0]!=='instrument')return runProcess(command,args,...rest);
  probe.instruments.push({assembly:args[1],session:args[args.indexOf('--session-id')+1]});
  probe.peakInstruments=Math.max(probe.peakInstruments,++probe.activeInstruments);
  try{return await runProcess(command,args,...rest);}finally{probe.activeInstruments--;}
 };
 mtp.requestTests=async(options,operation,...rest)=>{
  const invocation={assembly:options.assembly,session:options.wrapper?.args[options.wrapper.args.indexOf('--session-id')+1]};
  (operation==='discover'?probe.discoveries:probe.runs).push(invocation);
  probe.peakRequests=Math.max(probe.peakRequests,++probe.activeRequests);
  if(operation==='run')probe.peakRuns=Math.max(probe.peakRuns,++probe.activeRuns);
  try{return await requestTests(options,operation,...rest);}
  finally{probe.activeRequests--;if(operation==='run')probe.activeRuns--;}
 };
 const reset=()=>{
  assert.equal(probe.activeRequests+probe.activeRuns+probe.activeInstruments,0);
  probe.instruments=[];probe.discoveries=[];probe.runs=[];probe.builds=0;probe.peakRequests=0;probe.peakRuns=0;probe.peakInstruments=0;
 };
 const makeEngine=()=>{
  const state={output:[],results:[]};
  const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
   events:{output:text=>state.output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>state.results.push({group:group.id,...result}),
    started(){},coverage(){},invalidated(){}}});
  engines.push(engine);return{engine,state};
 };
 const snapshot=instance=>{
  const {engine,state}=instance,seen=new Set(),results=new Map();
  for(const result of state.results){const key=JSON.stringify([result.group,result.id]);assert.ok(!seen.has(key),'each canonical test emits exactly one terminal result');seen.add(key);results.set(key,result);}
  assert.equal(results.size,count);assert.equal(engine.groups.length,count);assert.equal(engine.coverage.traces.size,count);
  return engine.groups.map(group=>{
   assert.ok(group.file&&!group.runtimeOnly);assert.equal(group.tests.length,1);
   const native=group.tests[0],result=results.get(JSON.stringify([group.id,native.id]));
   assert.ok(result);assert.equal(result.outcome,'passed');assert.equal(result.name,native.name);
   const trace=engine.coverage.traces.get(group.id);assert.ok(trace?.reliable&&!trace.stale&&!trace.historical);
   assert.deepEqual(trace.dependencies.filter(file=>file.endsWith('.cs')&&!file.includes('/obj/')).sort(),[normalizePath(core),group.file].sort(),
    'each trace belongs to its own source file and the shared Core dependency');
   assert.ok(trace.coverage.some(file=>file.file===normalizePath(core)&&file.lines.some(line=>line.hits>0)));
   return{id:group.id,project:group.project,file:group.file,test:[native.id,native.name,native.fullyQualifiedName],
    dependencies:[...trace.dependencies].sort(),coverage:trace.coverage.map(file=>({file:file.file,hash:file.hash,lines:file.lines})).sort((a,b)=>a.file.localeCompare(b.file))};
  }).sort((a,b)=>a.id.localeCompare(b.id));
 };
 const run=async instance=>{
  instance.state.results=[];instance.state.output=[];
  const summary=await instance.engine.run({files:[],full:true},signal);
  assert.equal(summary.passed,count,instance.state.output.join(''));assert.equal(summary.failed,0);assert.equal(summary.tests,count);assert.equal(summary.coverageAvailable,true);
  assert.equal(probe.discoveries.length,count,'every project performs fresh discovery');assert.equal(probe.runs.length,count,'every baseline executes all seventeen tests');
  assert.equal(probe.peakRuns,1,'test execution is deliberately sequential');
  assert.ok(probe.peakRequests<=4&&probe.peakInstruments<=4,'initial preparation stays within four project workers');
  assert.equal(probe.activeRequests+probe.activeRuns+probe.activeInstruments,0);
  assert.equal(instance.engine.preparedOutputs.entries.size,count,'all seventeen private templates remain retained after the run');
  assert.deepEqual(await fs.readdir(path.join(storage,'runs')),[]);
  return snapshot(instance);
 };
 const invocations=()=>[...probe.runs].sort((a,b)=>a.assembly.localeCompare(b.assembly));
 const owners=async()=>{
  const directory=path.join(storage,'prepared-v2');
  return Promise.all((await fs.readdir(directory)).filter(name=>name.endsWith('.owner.json')).map(async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))));
 };
 const assertParked=async()=>{
  const saved=await owners();assert.equal(saved.length,1);const [owner]=saved;
  assert.equal(owner.state,'parked');assert.equal(owner.pid,0);assert.equal(owner.retention.entries,count);assert.equal(owner.snapshot.entries.length,count);
  assert.ok(owner.retention.bytes<=512*1024*1024,'the byte limit remains in force');
  assert.equal(new Set(owner.snapshot.entries.map(entry=>entry.session)).size,count,'each target owns a distinct collector session');
  for(const entry of owner.snapshot.entries){
   assert.equal(entry.coverage,true);assert.ok(!entry.coveragePending);
   assert.deepEqual(await fs.readdir(path.join(storage,'prepared-v2',owner.identity,entry.directory)),['template'],'only templates survive disposal');
  }
  return owner;
 };

 const first=makeEngine(),initial=await run(first);
 assert.equal(probe.instruments.length,count*2,'each target and its private Core copy are instrumented once');
 const originalInvocations=invocations();
 assert.equal(new Set(originalInvocations.map(value=>value.assembly)).size,count);
 assert.equal(new Set(originalInvocations.map(value=>value.session)).size,count);assert.ok(originalInvocations.every(value=>value.session));
 reset();assert.deepEqual(await run(first),initial);
 assert.equal(probe.instruments.length,0,'a second full baseline reuses all seventeen instrumented preparations');
 assert.deepEqual(invocations(),originalInvocations,'warm runs keep every private assembly path and collector session');
 await first.engine.dispose();const parked=await assertParked();

 reset();const second=makeEngine();await second.engine.restore();
 assert.deepEqual(await run(second),initial,'fresh execution after restart preserves exact test identities, results and coverage attribution');
 assert.equal(probe.instruments.length,0,'adoption must raise capacity before a default sixteen-entry trim can discard the parked container');
 assert.equal(probe.builds,1,'restart still executes an authoritative MSBuild build');
 assert.deepEqual(invocations(),originalInvocations,'adoption preserves all seventeen instrumentation sessions and absolute paths');
 const [active]=await owners();assert.equal(active.identity,parked.identity);assert.notEqual(active.token,parked.token);assert.equal(active.state,'active');assert.equal(active.pid,process.pid);
 await second.engine.dispose();await assertParked();
});
