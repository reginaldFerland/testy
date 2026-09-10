const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

async function fixture(t,{xunit=false}={}) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-persistent-prepared-'));
 const root=path.join(temp,'workspace'),storage=path.join(temp,'state'),file=relative=>normalizePath(path.join(root,relative));
 const expected=path.join(temp,'expected.txt'),expectedAsset=path.join(temp,'expected-asset.txt'),rows=path.join(temp,'rows.txt');
 await fs.mkdir(file('Core'),{recursive:true});await fs.mkdir(file('Tests'));
 await fs.writeFile(expected,'2');await fs.writeFile(expectedAsset,'clean');await fs.writeFile(rows,'1');
 await fs.writeFile(file('Core/Core.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(file('Core/Core.cs'),'public static class Core { public static int Value(int value) => value + 1; }');
 await fs.writeFile(file('Tests/Tests.csproj'),xunit
  ?'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0"/><ProjectReference Include="../Core/Core.csproj"/><None Update="asset.txt" CopyToOutputDirectory="PreserveNewest"/></ItemGroup></Project>'
  :'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Core/Core.csproj"/><None Update="asset.txt" CopyToOutputDirectory="PreserveNewest"/></ItemGroup></Project>');
 await fs.writeFile(file('Tests/asset.txt'),'clean');
 const body=`var asset=Path.Combine(Path.GetDirectoryName(typeof(ValueTests).Assembly.Location)!,"asset.txt");
  Assert.${xunit?'Equal':'AreEqual'}(File.ReadAllText(${JSON.stringify(expectedAsset)}),File.ReadAllText(asset));
  Assert.${xunit?'Equal':'AreEqual'}(int.Parse(File.ReadAllText(${JSON.stringify(expected)})),Core.Value(1));
  ${xunit?`if(File.ReadAllText(${JSON.stringify(rows)})=="1")`:''} File.WriteAllText(asset,"changed by a test");`;
 await fs.writeFile(file('Tests/ValueTests.cs'),xunit
  ?`using Xunit; public class ValueTests { public static IEnumerable<object[]> Cases() { for(var row=1;row<=int.Parse(File.ReadAllText(${JSON.stringify(rows)}));row++) yield return new object[] {new string('a',1000)+row}; } [Theory][MemberData(nameof(Cases))] public void Value(string row) { ${body} } }`
  :`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class ValueTests { [TestMethod] public void Value() { ${body} } }`);
 // A private analyzer copy allows testing real tool-identity invalidation without
 // changing the extension's bundled tools or another concurrently open workspace.
 const analyzerDirectory=path.join(temp,'analyzer');await fs.cp(path.resolve('dist/analyzer'),analyzerDirectory,{recursive:true});
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,
  coverageTool:process.env.TESTY_COVERAGE_TOOL,maxParallelProjects:1,maxParallelTestFiles:1};
 const engines=[],states=[];
 const makeEngine=()=>{
  const state={output:[],results:[],started(){}};states.push(state);
  const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.join(analyzerDirectory,'Testy.Analysis.dll'),configuration:()=>config,
   events:{output:text=>state.output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>state.results.push({group,...result}),
    started:(...args)=>state.started(...args),coverage(){},invalidated(){}}});
  engines.push(engine);return {engine,state};
 };
 const processes=require('../../out/services/process'),mtp=require('../../out/services/mtp');
 const runProcess=processes.runProcess,requestTests=mtp.requestTests;
 const probe={instruments:[],builds:0,discoveries:[],runs:[],activeInstruments:0,activeRequests:0};
 processes.runProcess=async(command,args,options)=>{
  if(args.includes('-target:Build'))probe.builds++;
  if(args[0]!=='instrument')return runProcess(command,args,options);
  const invocation={assembly:args[1],session:args[args.indexOf('--session-id')+1]};probe.instruments.push(invocation);probe.activeInstruments++;
  try {const result=await runProcess(command,args,options);await probe.afterInstrument?.(invocation);return result;}
  finally{probe.activeInstruments--;}
 };
 mtp.requestTests=async(options,operation,...rest)=>{
  const invocation={assembly:options.assembly,session:options.wrapper?.args[options.wrapper.args.indexOf('--session-id')+1]};
  (operation==='discover'?probe.discoveries:probe.runs).push(invocation);probe.activeRequests++;
  try {if(operation==='run')await probe.beforeRun?.(invocation);return await requestTests(options,operation,...rest);}
  finally{probe.activeRequests--;}
 };
 t.after(async()=>{await Promise.all(engines.map(engine=>engine.dispose()));processes.runProcess=runProcess;mtp.requestTests=requestTests;await fs.rm(temp,{recursive:true,force:true});});
 const run=async(instance)=>{
  await instance.engine.restore();
  const result=await instance.engine.run({files:[],full:true},new AbortController().signal);
  assert.equal(result.failed,0,instance.state.output.join(''));return result;
 };
 const reset=()=>{probe.instruments.length=0;probe.builds=0;probe.discoveries.length=0;probe.runs.length=0;};
 const owners=async()=>{
  const directory=path.join(storage,'prepared-v2');
  const entries=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return Promise.all(entries.filter(name=>name.endsWith('.owner.json')).map(async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))));
 };
 const assertParked=async(count=1)=>{
  const saved=await owners();assert.equal(saved.length,count);
  for(const owner of saved) {
   assert.equal(owner.state,'parked');assert.equal(owner.pid,0);assert.ok(owner.snapshot.entries.length);
   for(const entry of owner.snapshot.entries) {
    assert.deepEqual(await fs.readdir(path.join(storage,'prepared-v2',owner.identity,entry.directory)),['template'],'only immutable templates survive a clean shutdown');
   }
  }
  assert.deepEqual(await fs.readdir(path.join(storage,'runs')),[]);return saved;
 };
 return {temp,root,storage,file,expected,expectedAsset,rows,analyzerDirectory,config,probe,makeEngine,run,reset,owners,assertParked};
}

function snapshot(engine) {
 return {
  groups:engine.groups.map(group=>({id:group.id,tests:group.tests.map(test=>[test.id,test.name]).sort()})).sort((a,b)=>a.id.localeCompare(b.id)),
  traces:[...engine.coverage.traces.values()].map(trace=>({groupId:trace.groupId,reliable:trace.reliable,dependencies:[...trace.dependencies].sort(),
   coverage:trace.coverage.map(file=>({file:file.file,hash:file.hash,lines:file.lines})).sort((a,b)=>a.file.localeCompare(b.file))})).sort((a,b)=>a.groupId.localeCompare(b.groupId))
 };
}

test('clean engine restarts reuse instrumentation while rebuilding and freshly discovering exact native rows',{timeout:150000},async t=>{
 const f=await fixture(t,{xunit:true}),first=f.makeEngine();
 assert.equal((await f.run(first)).passed,1);assert.equal(f.probe.instruments.length,2);
 const initial=snapshot(first.engine),assembly=f.probe.discoveries[0].assembly,session=f.probe.runs[0].session;
 assert.ok(session);const ids=first.engine.groups[0].tests.map(test=>test.id);
 await first.engine.dispose();const [parked]=await f.assertParked();
 f.reset();const second=f.makeEngine();assert.equal((await f.run(second)).passed,1);
 assert.equal(f.probe.instruments.length,0,'validated templates survive engine disposal and skip reinstrumentation');
 assert.equal(f.probe.builds,1,'restart still asks MSBuild to validate the current build');
 assert.equal(f.probe.discoveries.length,1,'restart discovers a fresh inventory');assert.equal(f.probe.runs.length,1,'restart establishes a full fresh baseline');
 assert.equal(f.probe.discoveries[0].assembly,assembly);assert.equal(f.probe.runs[0].session,session,'adoption preserves the instrumentation session');
 assert.deepEqual(snapshot(second.engine),initial,'fresh execution reproduces exact row identities, coverage and dependency ownership');
 const [active]=await f.owners();assert.equal(active.identity,parked.identity);assert.equal(active.state,'active');assert.equal(active.pid,process.pid);
 await second.engine.dispose();await f.assertParked();
 await fs.writeFile(f.rows,'2');f.reset();const third=f.makeEngine();assert.equal((await f.run(third)).passed,2);
 assert.equal(f.probe.instruments.length,0,'external dynamic data changes do not invalidate unchanged binaries');
 const tests=third.engine.groups[0].tests;assert.equal(tests.length,2);assert.ok(tests.some(test=>test.id===ids[0]));
 assert.equal(tests[0].name,tests[1].name,'colliding theory display names still have distinct native identities');assert.notEqual(tests[0].id,tests[1].id);
 assert.equal(f.probe.discoveries[0].assembly,assembly,'fresh dynamic discovery uses the retained canonical path');
});

test('persisted templates invalidate for source, copied assets, preparation tools and build context',{timeout:180000},async t=>{
 const f=await fixture(t);let current=f.makeEngine();assert.equal((await f.run(current)).passed,1);await current.engine.dispose();
 const changes=[
  ['source',async()=>{await fs.writeFile(f.file('Core/Core.cs'),'public static class Core { public static int Value(int value) => value + 2; }');await fs.writeFile(f.expected,'3');}],
  ['copied asset',async()=>{await fs.writeFile(f.file('Tests/asset.txt'),'updated');await fs.writeFile(f.expectedAsset,'updated');}],
  ['tool payload',()=>fs.appendFile(path.join(f.analyzerDirectory,'Testy.Analysis.deps.json'),'\n')],
  ['build context',async()=>{f.config.excludes=['**/unused-exclusion/**'];}]
 ];
 for(const [kind,change] of changes) {
  await change();f.reset();current=f.makeEngine();assert.equal((await f.run(current)).passed,1);
  assert.equal(f.probe.instruments.length,2,`${kind} change must invalidate persisted instrumentation`);
  await current.engine.dispose();await f.assertParked();
 }
 f.reset();current=f.makeEngine();assert.equal((await f.run(current)).passed,1);
 assert.equal(f.probe.instruments.length,0,'the replacement preparation is reusable after all changes stabilize');
});

test('cancelled and failed coverage preparations are not persisted for the next engine',{timeout:150000},async t=>{
 const f=await fixture(t),cancelled=f.makeEngine(),controller=new AbortController();
 f.probe.afterInstrument=()=>controller.abort();
 await assert.rejects(cancelled.engine.run({files:[],full:true},controller.signal),{name:'AbortError'});
 assert.equal(f.probe.activeInstruments,0);assert.equal(f.probe.activeRequests,0);await cancelled.engine.dispose();
 assert.deepEqual(await f.owners(),[],'an interrupted preparation leaves no adoptable container');
 f.probe.afterInstrument=()=>{throw new Error('controlled failure after a real instrumentation process');};
 f.reset();const failed=f.makeEngine(),fallback=await f.run(failed);assert.equal(fallback.passed,1);assert.equal(fallback.coverageAvailable,false);
 await failed.engine.dispose();assert.deepEqual(await f.owners(),[],'partially instrumented fallback output is discarded');
 f.probe.afterInstrument=undefined;f.reset();const healthy=f.makeEngine();assert.equal((await f.run(healthy)).passed,1);assert.equal(f.probe.instruments.length,2);
 const abortRun=new AbortController();healthy.state.started=()=>abortRun.abort();
 await assert.rejects(healthy.engine.run({files:[],full:false},abortRun.signal,{groups:new Set(healthy.engine.groups.map(group=>group.id))}),{name:'AbortError'});
 assert.equal(f.probe.activeInstruments,0);assert.equal(f.probe.activeRequests,0);await healthy.engine.dispose();
 assert.deepEqual(await f.owners(),[],'a cancelled collector session cannot be adopted after restart');
 f.reset();const retry=f.makeEngine();assert.equal((await f.run(retry)).passed,1);assert.equal(f.probe.instruments.length,2);
});

test('simultaneous engines keep exclusive containers and adopt only cleanly parked owners',{timeout:150000},async t=>{
 let release,firstAdmitted,bothAdmitted,timer;
 t.after(()=>{clearTimeout(timer);release?.();});
 const f=await fixture(t),first=f.makeEngine(),second=f.makeEngine();
 const gate=new Promise(resolve=>release=resolve),firstReady=new Promise(resolve=>firstAdmitted=resolve),bothReady=new Promise(resolve=>bothAdmitted=resolve);
 f.probe.beforeRun=async()=>{if(f.probe.runs.length===1)firstAdmitted();if(f.probe.runs.length===2)bothAdmitted();await gate;};
 const firstRun=f.run(first);
 await Promise.race([firstReady,firstRun.then(()=>{throw new Error('First engine completed without reaching test execution');})]);const secondRun=f.run(second);
 await Promise.race([bothReady,secondRun.then(()=>{throw new Error('Second engine completed without reaching test execution');}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Both engine outputs were not admitted')),60000);})]);clearTimeout(timer);
 const invocations=[...f.probe.runs],owners=await f.owners();
 assert.equal(owners.length,2);assert.ok(owners.every(owner=>owner.state==='active'&&owner.pid===process.pid));
 assert.notEqual(invocations[0].assembly,invocations[1].assembly);assert.notEqual(invocations[0].session,invocations[1].session,'concurrent collectors never share instrumentation sessions');
 release();assert.equal((await firstRun).passed,1);assert.equal((await secondRun).passed,1);f.probe.beforeRun=undefined;
 await first.engine.dispose();const afterFirst=await f.owners();assert.equal(afterFirst.filter(owner=>owner.state==='parked').length,1);assert.equal(afterFirst.filter(owner=>owner.state==='active').length,1);
 const live=afterFirst.find(owner=>owner.state==='active');
 f.reset();const third=f.makeEngine();assert.equal((await f.run(third)).passed,1);
 assert.equal(f.probe.instruments.length,0,'a third engine can adopt the cleanly parked first container');
 assert.equal(f.probe.discoveries[0].assembly,invocations[0].assembly);assert.equal(f.probe.runs[0].session,invocations[0].session);
 assert.deepEqual((await f.owners()).find(owner=>owner.identity===live.identity),live,'adoption leaves the other live owner untouched');
 await second.engine.dispose();await third.engine.dispose();await f.assertParked(2);
});
