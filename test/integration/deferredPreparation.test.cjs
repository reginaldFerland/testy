const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

async function fixture(t,{dynamic}={}) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-deferred-preparation-'));
 const root=path.join(temp,'workspace'),storage=path.join(temp,'state'),control=path.join(temp,'rows.txt');
 const file=relative=>normalizePath(path.join(root,relative));
 const layers=['Core','App','Infra','Web'];
 await fs.writeFile(control,'1');
 for(const [index,layer] of layers.entries()) {
  await fs.mkdir(file(layer),{recursive:true});
  const reference=index?`<ItemGroup><ProjectReference Include="../${layers[index-1]}/${layers[index-1]}.csproj"/></ItemGroup>`:'';
  await fs.writeFile(file(`${layer}/${layer}.csproj`),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${reference}</Project>`);
  for(let feature=0;feature<4;feature++) {
   const expression=index?`Scale.${layers[index-1]}.Feature${feature}.Value(value)`:`value + ${feature+1}`;
   await fs.writeFile(file(`${layer}/Feature${feature}.cs`),`namespace Scale.${layer}; public static class Feature${feature} { public static int Value(int value) => ${expression}; }`);
  }
 }
 for(let index=0;index<4;index++) {
  const name=`Suite${index}`;await fs.mkdir(file(name));
  const xunit=dynamic==='xunit'&&index===1;
  await fs.writeFile(file(`${name}/${name}.csproj`),xunit
   ?'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0"/><ProjectReference Include="../Web/Web.csproj"/></ItemGroup></Project>'
   :'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Web/Web.csproj"/></ItemGroup></Project>');
  let source=`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature${index}Tests { [TestMethod] public void Value() => Assert.AreEqual(${index+2},Scale.Web.Feature${index}.Value(1)); }`;
  if(dynamic&&index===1) {
   source=xunit
    ?`using Xunit; public class Feature1Tests { public static IEnumerable<object[]> Cases() { for(var row=1;row<=int.Parse(File.ReadAllText(${JSON.stringify(control)}));row++) yield return new object[] {new string('a',1000)+row}; } [Theory][MemberData(nameof(Cases))] public void Value(string row) { Assert.Equal(3,Scale.Web.Feature1.Value(1)); Assert.EndsWith("1",row); } }`
    :`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature1Tests { public static IEnumerable<object[]> Cases() { for(var row=0;row<int.Parse(File.ReadAllText(${JSON.stringify(control)}));row++) yield return new object[] {row}; } [TestMethod][DynamicData(nameof(Cases),DynamicDataSourceType.Method)] public void Value(int row) => Assert.AreEqual(row+2,Scale.Web.Feature1.Value(row)); }`;
  }
  await fs.writeFile(file(`${name}/Feature${index}Tests.cs`),source);
 }
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,
  coverageTool:process.env.TESTY_COVERAGE_TOOL,maxParallelProjects:4,maxParallelTestFiles:4};
 const state={output:[],results:[],selections:[]};
 const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>state.output.push(text),phase(){},discovered(){},selected:selection=>state.selections.push(selection),
   result:(group,result)=>state.results.push({group,...result}),started(){},coverage(){},invalidated(){}}});
 const processes=require('../../out/services/process'),mtp=require('../../out/services/mtp');
 const runProcess=processes.runProcess,requestTests=mtp.requestTests;
 const probe={instruments:[],discoveries:[],runs:[],activeInstruments:0,activeRequests:0};
 processes.runProcess=async(command,args,options)=>{
  if(args[0]!=='instrument')return runProcess(command,args,options);
  const invocation={assembly:args[1],project:path.basename(options.cwd)};probe.instruments.push(invocation);probe.activeInstruments++;
  try {
   const result=await runProcess(command,args,options);await probe.afterInstrument?.(invocation);return result;
  }finally{probe.activeInstruments--;}
 };
 mtp.requestTests=async(options,operation,...rest)=>{
  const invocation={assembly:options.assembly,instruments:probe.instruments.length};
  (operation==='discover'?probe.discoveries:probe.runs).push(invocation);probe.activeRequests++;
  try {const nodes=await requestTests(options,operation,...rest);invocation.nodes=nodes;return nodes;}
  finally{probe.activeRequests--;}
 };
 t.after(async()=>{await engine.dispose();processes.runProcess=runProcess;mtp.requestTests=requestTests;await fs.rm(temp,{recursive:true,force:true});});
 const run=(batch={files:[],full:true},manual)=>engine.run(batch,new AbortController().signal,manual);
 const reset=()=>{probe.instruments.length=0;probe.discoveries.length=0;probe.runs.length=0;state.results.length=0;state.selections.length=0;state.output.length=0;};
 const change=async()=>{
  const source=file('Web/Feature0.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('Scale.Infra.Feature0.Value(value)','Scale.Infra.Feature0.Value(value) + 1'));
  await engine.markChanged([source]);return {files:[source],full:false};
 };
 return {temp,root,storage,file,control,config,state,engine,probe,run,reset,change};
}

function preparedProjects(probe) {return [...new Set(probe.instruments.map(item=>item.project))].sort();}
function discoveriesFor(probe,name) {return probe.discoveries.filter(item=>path.basename(item.assembly)===`${name}.dll`);}

test('an affected dependency rebuild freshly discovers every target but instruments only the selected project',{timeout:150000},async t=>{
 const f=await fixture(t);assert.equal((await f.run()).passed,4,f.state.output.join(''));
 assert.equal(f.probe.instruments.length,20,'the baseline covers all five workspace DLLs in each of four targets');
 f.reset();const changed=await f.change();
 assert.deepEqual(f.engine.select(changed.files).groups.map(group=>path.basename(group.project)),['Suite0.csproj'],'retained per-file coverage anticipates only the changed feature');
 const result=await f.run(changed);assert.equal(result.tests,1);assert.equal(result.failed,1,f.state.output.join(''));
 assert.equal(f.probe.discoveries.length,4,'unselected build targets still receive a fresh inventory');
 assert.deepEqual(new Set(f.probe.discoveries.map(item=>path.basename(item.assembly))),new Set(['Suite0.dll','Suite1.dll','Suite2.dll','Suite3.dll']));
 assert.equal(f.probe.instruments.length,5,'unselected targets do not pay the four-layer instrumentation cost');
 assert.deepEqual(preparedProjects(f.probe),['Suite0']);
 assert.deepEqual(new Set(f.probe.instruments.map(item=>path.basename(item.assembly))),new Set(['Core.dll','App.dll','Infra.dll','Web.dll','Suite0.dll']));
 assert.equal(f.probe.runs.length,1);assert.equal(path.basename(f.probe.runs[0].assembly),'Suite0.dll');
 for(const group of f.engine.groups.filter(item=>path.basename(item.project)!=='Suite0.csproj'))assert.equal(f.engine.coverage.traces.get(group.id).reliable,true,'unchanged targets retain their previous reliable coverage');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
 const deferredPath=discoveriesFor(f.probe,'Suite2')[0].assembly;
 const manual={groups:new Set([f.engine.groups.find(group=>path.basename(group.project)==='Suite2.csproj').id])};
 f.reset();assert.equal((await f.run({files:[],full:false},manual)).passed,1,f.state.output.join(''));
 assert.equal(f.probe.instruments.length,5,'a later manual run upgrades the retained discovery-only artifact');
 assert.equal(f.probe.discoveries.length,1,'eager promotion completes before its one fresh manual discovery');
 assert.equal(f.probe.discoveries[0].assembly,deferredPath,'a retained discovery-only cache entry preserves the canonical path when promoted');
 f.reset();assert.equal((await f.run({files:[],full:false},manual)).passed,1,f.state.output.join(''));
 assert.equal(f.probe.instruments.length,0,'the promoted artifact is reusable on the next unchanged run');
});

test('changed dynamic inventories can select and upgrade a previously unanticipated target',{timeout:150000},async t=>{
 const f=await fixture(t,{dynamic:'mstest'});assert.equal((await f.run()).passed,4,f.state.output.join(''));
 f.reset();await fs.writeFile(f.control,'2');const changed=await f.change();
 assert.deepEqual(f.engine.select(changed.files).groups.map(group=>path.basename(group.project)),['Suite0.csproj']);
 const result=await f.run(changed);assert.equal(result.tests,3);assert.equal(result.passed,2);assert.equal(result.failed,1,f.state.output.join(''));
 assert.deepEqual(preparedProjects(f.probe),['Suite0','Suite1']);assert.equal(f.probe.instruments.length,10);
 const dynamic=discoveriesFor(f.probe,'Suite1');
 assert.equal(dynamic.length,2,'a newly selected target refreshes native identities after upgrading its discovery-only output');
 assert.equal(new Set(dynamic.map(item=>item.assembly)).size,1,'the upgrade retains the canonical private assembly path');
 assert.equal(f.engine.groups.find(group=>path.basename(group.project)==='Suite1.csproj').tests.length,2,'fresh dynamic rows replace the original inventory');
 assert.equal(discoveriesFor(f.probe,'Suite2').length,1);assert.equal(discoveriesFor(f.probe,'Suite3').length,1);
 assert.equal(f.probe.activeInstruments,0);assert.equal(f.probe.activeRequests,0);
});

test('xUnit row selection and exclusion remain exact after a deferred coverage upgrade',{timeout:180000},async t=>{
 const f=await fixture(t,{dynamic:'xunit'});assert.equal((await f.run()).passed,4,f.state.output.join(''));
 const initial=f.engine.groups.find(group=>path.basename(group.project)==='Suite1.csproj'),originalId=initial.tests[0].id;
 f.reset();await fs.writeFile(f.control,'2');const changed=await f.change();
 const result=await f.run(changed);assert.equal(result.tests,3);assert.equal(result.passed,1);assert.equal(result.failed,2,f.state.output.join(''));
 const dynamic=discoveriesFor(f.probe,'Suite1');assert.equal(dynamic.length,2,'xUnit is rediscovered after lazy instrumentation');
 assert.equal(new Set(dynamic.map(item=>item.assembly)).size,1);
 const passed=f.state.results.find(item=>item.group.id===initial.id&&item.outcome==='passed');
 const failed=f.state.results.find(item=>item.group.id===initial.id&&item.outcome==='failed');
 assert.ok(passed);assert.ok(failed);assert.equal(passed.name,failed.name,'long theory arguments deliberately produce colliding display names');
 assert.notEqual(passed.id,failed.id);assert.equal(passed.id,originalId,'an existing row keeps its native identity across the upgrade');
 const manual={groups:new Set([initial.id]),tests:new Map([[initial.id,new Set([originalId])]])};
 const selected=await f.run({files:[],full:false},manual);assert.equal(selected.tests,1);assert.equal(selected.passed,1,f.state.output.join(''));
 const excluded=await f.run({files:[],full:false},{groups:new Set([initial.id]),exclude:{groups:new Set([initial.id]),tests:new Map([[initial.id,new Set([failed.id])]])}});
 assert.equal(excluded.tests,1);assert.equal(excluded.passed,1,'the excluded failing row must not be confused with the identically named passing row');
});

test('cancelling a deferred upgrade drains preparation and retries with intact coverage',{timeout:180000},async t=>{
 const f=await fixture(t,{dynamic:'mstest'});assert.equal((await f.run()).passed,4,f.state.output.join(''));
 f.reset();await fs.writeFile(f.control,'2');const changed=await f.change(),controller=new AbortController();
 let cancelledUpgrade=false;
 f.probe.afterInstrument=invocation=>{if(invocation.project==='Suite1'){cancelledUpgrade=true;controller.abort();}};
 await assert.rejects(f.engine.run(changed,controller.signal),{name:'AbortError'});
 assert.equal(cancelledUpgrade,true,'cancellation interrupts instrumentation of the newly selected target');
 assert.equal(f.probe.activeInstruments,0);assert.equal(f.probe.activeRequests,0,'discovery, coverage and test processes drain before cancellation returns');
 assert.equal(f.probe.runs.some(item=>path.basename(item.assembly)==='Suite1.dll'),false,'the partially instrumented target never executes');
 assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
 f.probe.afterInstrument=undefined;f.reset();
 const retry=await f.run(changed);assert.equal(retry.tests,3);assert.equal(retry.passed,2);assert.equal(retry.failed,1,f.state.output.join(''));
 assert.ok(f.probe.instruments.some(item=>item.project==='Suite1'),'the cancelled upgrade is rebuilt before execution');
 const group=f.engine.groups.find(item=>path.basename(item.project)==='Suite1.csproj');assert.equal(f.engine.coverage.traces.get(group.id).reliable,true);
 await f.engine.dispose();assert.deepEqual(await fs.readdir(path.join(f.storage,'prepared')),[]);assert.deepEqual(await fs.readdir(path.join(f.storage,'runs')),[]);
});
