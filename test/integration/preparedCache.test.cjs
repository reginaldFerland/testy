const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

async function fixture(t,{projects=1,files=1,dynamic=false}={}) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-prepared-cache-'));
 const root=path.join(temp,'workspace'),storage=path.join(temp,'state');
 const file=relative=>normalizePath(path.join(root,relative));
 const control=path.join(temp,'expected.txt'),assetControl=path.join(temp,'expected-asset.txt'),slow=path.join(temp,'slow');
 await fs.mkdir(file('Core'),{recursive:true});
 await fs.writeFile(file('Core/Core.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(file('Core/Core.cs'),'public static class Core { public static int Value(int value) => value + 1; }');
 await fs.writeFile(control,'2');await fs.writeFile(assetControl,'clean');
 for(let project=0;project<projects;project++) {
  const name=`Suite${project}`,directory=file(name);await fs.mkdir(directory);
  await fs.writeFile(file(`${name}/${name}.csproj`),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Core/Core.csproj"/><None Update="asset.txt" CopyToOutputDirectory="PreserveNewest"/></ItemGroup></Project>');
  await fs.writeFile(file(`${name}/asset.txt`),'clean');
  for(let index=0;index<files;index++) {
   const nameOfClass=`Value${index}Tests`;
   await fs.writeFile(file(`${name}/${nameOfClass}.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting;
[TestClass] public class ${nameOfClass} {
 ${dynamic?`public static IEnumerable<object[]> Cases() { yield return new object[] { int.Parse(File.ReadAllText(${JSON.stringify(control)})), File.ReadAllText(${JSON.stringify(assetControl)}) }; }`:''}
 [TestMethod] ${dynamic?'[DynamicData(nameof(Cases), DynamicDataSourceType.Method)]':''}
 public void Value(${dynamic?'int expected, string expectedAsset':''}) {
  var asset=Path.Combine(Path.GetDirectoryName(typeof(${nameOfClass}).Assembly.Location)!,"asset.txt");
  Assert.AreEqual(${dynamic?'expectedAsset':'"clean"'},File.ReadAllText(asset));
  if(File.Exists(${JSON.stringify(slow)})) Thread.Sleep(30000);
  Assert.AreEqual(${dynamic?'expected':'2'},Core.Value(1));
  File.WriteAllText(asset,"mutated by test");
  ${projects>1?'Thread.Sleep(150);':''}
 }
}`);
  }
 }
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,
  coverageTool:process.env.TESTY_COVERAGE_TOOL,maxParallelProjects:projects,maxParallelTestFiles:projects};
 const state={output:[],prepared:[],started(){},results:[]};
 const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>state.output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>state.results.push({group,...result}),
   started:(...args)=>state.started(...args),coverage(){},invalidated(){},prepared:project=>state.prepared.push(project)}});
 t.after(async()=>{await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 const processTools=require('../../out/services/process'),mtp=require('../../out/services/mtp');
 const runProcess=processTools.runProcess,requestTests=mtp.requestTests;
 const probe={instruments:[],discoveries:[],runs:[],active:0,peak:0};
 processTools.runProcess=async(command,args,...rest)=>{
  if(args[0]==='instrument')probe.instruments.push({assembly:args[1],session:args[args.indexOf('--session-id')+1]});
  return runProcess(command,args,...rest);
 };
 mtp.requestTests=async(options,operation,...rest)=>{
  if(operation==='discover')probe.discoveries.push(options.assembly);
  if(operation!=='run')return requestTests(options,operation,...rest);
  probe.runs.push(options.assembly);probe.peak=Math.max(probe.peak,++probe.active);
  try{await probe.beforeRun?.(options);return await requestTests(options,operation,...rest);}finally{probe.active--;}
 };
 t.after(()=>{processTools.runProcess=runProcess;mtp.requestTests=requestTests;});
 const run=(full=false,manual)=>engine.run({files:[],full},new AbortController().signal,manual);
 const manual=()=>({groups:new Set(engine.groups.map(group=>group.id))});
 return {temp,root,storage,file,control,assetControl,slow,config,state,engine,probe,run,manual};
}

test('warm prepared outputs reuse instrumentation while rediscovering dynamic tests and restoring mutated assets',{timeout:120000},async t=>{
 const f=await fixture(t,{dynamic:true});
 const baseline=await f.run(true);assert.equal(baseline.passed,1,f.state.output.join(''));assert.equal(baseline.coverageAvailable,true);
 const instruments=f.probe.instruments.length;assert.equal(instruments,2,'the target and workspace dependency are instrumented');
 const originalName=f.engine.groups[0].tests[0].name;
 assert.equal((await f.run(false,f.manual())).passed,1,'a test-mutated copied asset is restored before reusing its output');
 assert.equal(f.probe.instruments.length,instruments,'unchanged manual reruns reuse their instrumented output');
 assert.equal(f.probe.discoveries.length,2,'cached preparation must still run fresh discovery');
 await fs.writeFile(f.control,'3');
 const changed=await f.run(false,f.manual());
 assert.equal(changed.failed,1,'fresh dynamic arguments must reach execution even when all build artifacts are unchanged');
 assert.notEqual(f.engine.groups[0].tests[0].name,originalName,'new dynamic rows replace the previous discovery inventory');
 assert.equal(f.probe.instruments.length,instruments,'a dynamic data change does not invalidate unchanged instrumented artifacts');
 assert.equal(f.probe.discoveries.length,3);
 assert.equal(new Set(f.probe.discoveries).size,1,'warm discovery and execution retain their stable private assembly path');
 assert.ok((await fs.readdir(path.join(f.storage,'prepared-v2'))).some(name=>name.endsWith('.owner.json')),'prepared artifacts survive completed engine runs');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[],'per-run outputs are still released promptly');
});

test('prepared outputs invalidate when a dependency DLL or copied asset changes',{timeout:150000},async t=>{
 const f=await fixture(t,{dynamic:true});assert.equal((await f.run(true)).passed,1);
 const initial=f.probe.instruments.length;
 await fs.writeFile(f.file('Core/Core.cs'),'public static class Core { public static int Value(int value) => value + 2; }');
 await fs.writeFile(f.control,'3');
 const dependency=await f.run(false,f.manual());assert.equal(dependency.passed,1,f.state.output.join(''));
 assert.ok(f.probe.instruments.length>initial,'changed production DLL bytes invalidate the retained target preparation');
 assert.ok(f.engine.coverage.traces.get(f.engine.groups[0].id).dependencies.includes(f.file('Core/Core.cs')));
 const afterDependency=f.probe.instruments.length;
 await fs.writeFile(f.file('Suite0/asset.txt'),'updated asset');await fs.writeFile(f.assetControl,'updated asset');
 const asset=await f.run(false,f.manual());assert.equal(asset.passed,1,f.state.output.join(''));
 assert.ok(f.probe.instruments.length>afterDependency,'changed copied asset bytes invalidate a preparation even without recompilation');
 const afterAsset=f.probe.instruments.length;
 assert.equal((await f.run(false,f.manual())).passed,1,'the newly cached asset is restored after test mutation');
 assert.equal(f.probe.instruments.length,afterAsset,'the replacement preparation is reusable');
});

test('xUnit selected and excluded row identities survive prepared-output invalidation',{timeout:150000},async t=>{
 const f=await fixture(t),prefix='a'.repeat(1000);
 await fs.writeFile(f.file('Suite0/Suite0.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0"/><ProjectReference Include="../Core/Core.csproj"/><None Update="asset.txt" CopyToOutputDirectory="PreserveNewest"/></ItemGroup></Project>');
 await fs.writeFile(f.file('Suite0/Value0Tests.cs'),`using Xunit; public class Value0Tests { [Theory][InlineData("${prefix}1")][InlineData("${prefix}2")] public void Duplicate(string value) { Assert.True(Core.Value(1)>0); Assert.EndsWith("1",value); } }`);
 const baseline=await f.run(true);assert.equal(baseline.tests,2);assert.equal(baseline.passed,1);assert.equal(baseline.failed,1);
 const group=f.engine.groups[0],ids=group.tests.map(test=>test.id).sort();
 const passed=f.state.results.find(result=>result.outcome==='passed'),failed=f.state.results.find(result=>result.outcome==='failed');
 assert.equal(passed.name,failed.name,'row names deliberately collide so name-based recovery cannot hide changed native IDs');assert.notEqual(passed.id,failed.id);
 const instrumented=f.probe.instruments.length;
 await fs.writeFile(f.file('Core/Core.cs'),'public static class Core { public static int Value(int value) => value + 2; }');
 const selected=await f.run(false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([passed.id])]])});
 assert.equal(selected.tests,1);assert.equal(selected.passed,1,f.state.output.join(''));
 assert.ok(f.probe.instruments.length>instrumented,'the selected-row rerun rebuilt and reinstrumented its changed dependency');
 assert.deepEqual(f.engine.groups[0].tests.map(test=>test.id).sort(),ids,'the replacement preparation retains path-dependent native row identities');
 await fs.writeFile(f.file('Suite0/asset.txt'),'new asset bytes');
 const excluded=await f.run(false,{groups:new Set([group.id]),exclude:{groups:new Set([group.id]),tests:new Map([[group.id,new Set([failed.id])]])}});
 assert.equal(excluded.tests,1);assert.equal(excluded.passed,1,'exclusions from the current explorer still apply after another cache invalidation');
 assert.deepEqual(f.engine.groups[0].tests.map(test=>test.id).sort(),ids);
 assert.equal(new Set(f.probe.discoveries).size,1,'invalidating a primary cache entry preserves its stable discovery path');
});

test('cancelled cached execution drains, retries cleanly and parks only pristine templates on engine disposal',{timeout:150000},async t=>{
 const f=await fixture(t);assert.equal((await f.run(true)).passed,1);
 const before=f.probe.instruments.length,abort=new AbortController();
 await fs.writeFile(f.slow,'wait');f.state.started=()=>abort.abort();
 await assert.rejects(f.engine.run({files:[],full:false},abort.signal,f.manual()),{name:'AbortError'});
 assert.equal(f.probe.active,0,'cancellation returns only after the collector/test process drains');
 assert.equal(f.probe.instruments.length,before,'the cancelled run initially acquired its warm preparation');
 f.state.started=()=>{};await fs.rm(f.slow);
 const retry=await f.run(false,f.manual());assert.equal(retry.passed,1,f.state.output.join(''));assert.equal(retry.coverageAvailable,true);
 assert.ok(f.probe.instruments.length>before,'a cancelled collector session is discarded before retry');
 assert.equal(f.engine.coverage.traces.get(f.engine.groups[0].id).reliable,true);
 await f.engine.dispose();
 const owners=(await fs.readdir(path.join(f.storage,'prepared-v2'))).filter(name=>name.endsWith('.owner.json'));
 assert.equal(owners.length,1);
 const owner=JSON.parse(await fs.readFile(path.join(f.storage,'prepared-v2',owners[0]),'utf8'));
 assert.equal(owner.state,'parked');assert.equal(owner.pid,0,'the disposed engine relinquishes exclusive ownership');
 for(const entry of owner.snapshot.entries)assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared-v2',owner.identity,entry.directory)),['template'],'executed output and reports are removed before parking');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});

test('balanced project scheduling uses prepared primaries before creating additional worker copies',{timeout:180000},async t=>{
 const f=await fixture(t,{projects:4,files:3});
 let admitted=0,release,firstWave,timer;
 const primariesAdmitted=new Promise(resolve=>release=resolve);
 t.after(()=>clearTimeout(timer));
 f.probe.beforeRun=async()=>{
  const index=admitted++;if(index>=4)return;
  timer??=setTimeout(release,60000);
  if(index===3) {
   firstWave={discoveries:[...f.probe.discoveries],instruments:[...f.probe.instruments],runs:[...f.probe.runs]};release();
  }
  await primariesAdmitted;
 };
 const baseline=await f.run(true);assert.equal(baseline.tests,12);assert.equal(baseline.passed,12,f.state.output.join(''));assert.equal(baseline.failed,0);
 assert.equal(f.probe.peak,4,'all four worker slots are used');assert.equal(f.probe.active,0);
 assert.equal(f.state.prepared.length,4,'every project prepares its primary output once');
 assert.ok(firstWave,'all four workers must be admitted before releasing the first wave');
 assert.equal(firstWave.discoveries.length,4,'initial file batches reuse all four already-discovered primaries');
 assert.equal(firstWave.instruments.length,8,'only four target/dependency pairs are instrumented before every primary is busy');
 assert.equal(new Set(firstWave.runs).size,4,'the first four file batches execute in distinct prepared projects');
 // Finishing targets may donate workers to unfinished targets, so the tail can
 // legitimately create additional lanes when real process durations differ.
 assert.equal(f.engine.coverage.traces.size,12);
 for(const group of f.engine.groups) {
  const trace=f.engine.coverage.traces.get(group.id);assert.equal(trace.reliable,true);assert.ok(trace.dependencies.includes(f.file('Core/Core.cs')));
 }
});
