const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

async function fixture(t) {
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy regression '));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 const state={selected:[],results:[],prepared:0,started:()=>{},output:[]};
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
  output:text=>state.output.push(text),phase:()=>{},discovered:()=>{},selected:s=>state.selected=s.groups.map(group=>path.basename(group.file||group.project)),
  result:(group,result)=>state.results.push({file:group.file,...result}),started:(...args)=>state.started(...args),coverage:()=>{},invalidated:()=>{},prepared:()=>state.prepared++
 }});
 return {root,temp,config,state,engine,file:relative=>normalizePath(path.join(root,relative)),run:(files=[],full=false,manual)=>engine.run({files,full},new AbortController().signal,manual)};
}

test('execution-time rows preserve a failure followed by a pass under one UID',{timeout:90000},async t=>{
 const f=await fixture(t), file=f.file('ImpactDemo.Tests/CalculatorTests.cs');
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('[DataRow(1, 2, 3)]','[DataRow(1, 2, 4)]').replace('namespace ImpactDemo.Tests;','[assembly: TestDataSourceDiscovery(TestDataSourceDiscoveryOption.DuringExecution)]\nnamespace ImpactDemo.Tests;'));
 const result=await f.run([],true);assert.equal(result.failed,1);assert.equal(result.passed,1);
 const calculator=f.engine.groups.find(group=>group.file===file);
 assert.equal(f.engine.coverage.traces.get(calculator.id).reliable,false);
 assert.equal(f.state.results.filter(result=>result.file===file).at(-1).outcome,'failed');
 assert.equal(f.state.prepared,1,'prepare and instrument each project output once');
});

test('excluded bodies force fallback and manual runs without coverage preserve attribution',{timeout:90000},async t=>{
 const f=await fixture(t), arithmetic=f.file('ImpactDemo/Arithmetic.cs'), greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 const source=(await fs.readFile(arithmetic,'utf8')).replace('    public static int Sum','    [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage]\n    public static int Hidden(int x) => x;\n    public static int Sum');
 await fs.writeFile(arithmetic,source);
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);','Assert.AreEqual(3, Arithmetic.Expected); Assert.AreEqual(7, Arithmetic.Hidden(7));'));
 assert.equal((await f.run([],true)).passed,3);
 const calculator=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
 const before=JSON.stringify([...f.engine.coverage.traces]);
 assert.equal((await f.run([],false,{groups:new Set([calculator.id]),tests:new Map([[calculator.id,new Set([calculator.tests[0].id])]]),coverage:false})).tests,1);
 assert.equal(JSON.stringify([...f.engine.coverage.traces]),before);
 await fs.writeFile(arithmetic,source.replace('Hidden(int x) => x;','Hidden(int x) => x + 1;'));
 const result=await f.run([arithmetic]);assert.equal(result.tests,3);assert.equal(result.failed,1);
});

test('an exclusion on another partial declaration cannot hide a failing test',{timeout:90000},async t=>{
 const f=await fixture(t), source=f.file('ImpactDemo/Arithmetic.cs'), greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 await fs.appendFile(source,'\npublic static partial class Hidden { public static int Value(int value)=>value; }');
 await fs.writeFile(f.file('ImpactDemo/Hidden.Attributes.cs'),'namespace ImpactDemo; [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public static partial class Hidden {}');
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);','Assert.AreEqual(3, Arithmetic.Expected); Assert.AreEqual(7, Hidden.Value(7));'));
 assert.equal((await f.run([],true)).passed,3);
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('Value(int value)=>value;','Value(int value)=>value + 1;'));
 const affected=await f.run([source]);assert.equal(affected.tests,3);assert.equal(affected.failed,1);
});

test('manual builds ignore unrelated broken projects and preserve their pending changes',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 await fs.mkdir(f.file('Other'));
 await fs.writeFile(f.file('Other/Other.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(f.file('Other/Code.cs'),'public class Other {}');
 assert.equal((await f.run([],true)).passed,3);
 await fs.writeFile(f.file('Other/Code.cs'),'public class Broken {');
 const group=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
 assert.equal((await f.run([],false,{groups:new Set([group.id]),coverage:false})).passed,2);
 await assert.rejects(f.run(),/Building Other.csproj failed/,'an unrelated edit consumed during the manual refresh must stay pending');
});

test('an excluded production dependency is still built from a clean checkout',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.excludes=['ImpactDemo/**'];
 const result=await f.run([],true);assert.equal(result.passed,3);
 assert.equal(f.engine.projects.length,1,'excluded dependency is not included in watched discovery');
});

test('manual multi-file coverage retains the unselected part of an all-mode aggregate',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.mode='all';
 await fs.writeFile(f.file('ImpactDemo/Third.cs'),'namespace ImpactDemo; public static class Third { public static int Value()=>42; }');
 await fs.writeFile(f.file('ImpactDemo.Tests/ThirdTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; using ImpactDemo; [TestClass] public class ThirdTests { [TestMethod] public void Test()=>Assert.AreEqual(42,Third.Value()); }');
 assert.equal((await f.run([],true)).passed,4);
 const before=f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes);
 const selected=f.engine.groups.filter(group=>!group.file.endsWith('ThirdTests.cs'));
 const result=await f.run([],false,{groups:new Set(selected.map(group=>group.id)),coverage:true});
 assert.equal(result.tests,3);assert.equal(result.files,2);
 const after=f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes);
 assert.equal(after.covered,before.covered);assert.equal(after.total,before.total);
 assert.equal(after.stale,true,'an aggregate has no file attribution, so its retained history must be marked honestly');
 for(const group of selected)assert.ok(f.engine.coverage.traces.has(group.id),'the new complete file contribution must be collected');
 await f.run([],false,{groups:new Set([selected[0].id]),coverage:false});
 assert.equal(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes).stale,true,'matching hashes cannot refresh a superseded aggregate');
 assert.equal((await f.run([],true)).passed,4);
 assert.equal(f.engine.coverage.summary(f.file('ImpactDemo/Third.cs'),f.engine.hashes).stale,false);
});

test('an aborted checkpoint retries its unsaved coverage without relearning the completed file',{timeout:90000},async t=>{
 const f=await fixture(t),abort=new AbortController();
 const {withLock}=require('../../out/services/lock'),{CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage');
 let release,ready,released=false;
 const gate=new Promise(resolve=>release=()=>{released=true;resolve();}), acquired=new Promise(resolve=>ready=resolve);
 const holding=withLock(path.join(f.temp,'state','coverage-v2.lock'),undefined,async()=>{ready();await gate;});await acquired;
 const save=f.engine.cache.save.bind(f.engine.cache);
 f.engine.cache.save=async(delta,signal)=>{
  const pending=save(delta,signal);abort.abort();
  const fallback=setTimeout(release,2000);
  try{return await pending;}finally{clearTimeout(fallback);}
 };
 try{
  await assert.rejects(f.engine.run({files:[],full:true,generation:99},abort.signal),{name:'AbortError'});
  assert.equal(released,false,'cancellation must finish while the other writer still owns the lock');
  assert.equal(f.engine.baselineProgress.completed,1);
 }finally{release();await holding;f.engine.cache.save=save;}
 const resumed=await f.engine.run({files:[],full:true,generation:99},new AbortController().signal);
 assert.equal(resumed.files,1);
 const restored=new CoverageStore();await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(restored);
 assert.equal(restored.traces.size,2,'both the retried checkpoint and remaining file must be persisted');
});

test('switching from all to affected mode retains aggregate history through cancelled learning',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.mode='all';
 assert.equal((await f.run([],true)).passed,3);
 const {projectCoverageId}=require('../../out/services/runner');
 const aggregate=projectCoverageId(f.engine.groups[0]);assert.ok(f.engine.coverage.traces.has(aggregate));
 const original=f.engine.coverage.summarize(f.engine.hashes);
 f.config.mode='affected';const abort=new AbortController();let active;
 f.state.started=group=>{if(active&&active!==group.id)abort.abort();active=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:123},abort.signal),()=>abort.signal.aborted);
 assert.equal(f.engine.baselineProgress.completed,1);
 assert.equal(f.engine.coverage.traces.get(aggregate).historical,true);
 for(const source of original){
  const retained=f.engine.coverage.summary(source.file,f.engine.hashes);
  assert.equal(retained.covered,source.covered,'interrupted learning must retain the unlearned contribution');
 }
 f.state.started=()=>{};
 const resumed=await f.engine.run({files:[],full:true,generation:123},new AbortController().signal);
 assert.equal(resumed.files,1);assert.equal(f.engine.coverage.traces.has(aggregate),false);
 assert.ok(f.engine.coverage.summarize(f.engine.hashes).every(source=>!source.stale));
});

test('all skipped and class initialization failures do not stop other test files',{timeout:90000},async t=>{
 const f=await fixture(t), file=f.file('ImpactDemo.Tests/CalculatorTests.cs'), original=await fs.readFile(file,'utf8');
 await fs.writeFile(file,original.replace('[TestClass]','[TestClass]\n[Ignore]'));
 const skipped=await f.run([],true);assert.equal(skipped.passed,1);assert.equal(skipped.skipped,2);
 await fs.writeFile(file,original.replace('public class CalculatorTests\n{','public class CalculatorTests\n{\n    [ClassInitialize] public static void Init(TestContext context) => throw new System.Exception("intentional initialization failure");'));
 const failed=await f.run([],true);assert.equal(failed.passed,1);assert.equal(failed.failed,2);
});

test('binary Reference builds the changed workspace input and selects its runtime dependents',{timeout:90000},async t=>{
 const f=await fixture(t), project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('<ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" />','<Reference Include="ImpactDemo"><HintPath>../ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll</HintPath></Reference>'));
 assert.equal((await f.run([],true)).passed,3);
 const source=f.file('ImpactDemo/Arithmetic.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
 const affected=await f.run([source]);assert.equal(affected.tests,2);assert.equal(affected.failed,2);
 assert.deepEqual(f.state.selected,['CalculatorTests.cs']);
});

test('baseline checkpoints completed files and resumes without rerunning unchanged completed work',{timeout:90000},async t=>{
 const f=await fixture(t), abort=new AbortController();let active;
 f.state.started=(group)=>{if(active && active!==group.id){abort.abort();}active=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:42},abort.signal),()=>abort.signal.aborted);
 assert.equal(f.engine.coverage.traces.size,1);assert.deepEqual(f.engine.baselineProgress,{completed:1,total:2});
 const completed=[...f.engine.coverage.traces.values()][0];f.state.started=()=>{};
 const pending=f.engine.groups.find(group=>group.id!==completed.groupId);
 await f.run([],false,{groups:new Set([pending.id]),coverage:false});
 assert.equal(f.engine.baselineProgress.completed,1,'a manual run without collection must not mark an unlearned file complete');
 const resumed=await f.engine.run({files:[],full:true,generation:42},new AbortController().signal);
 assert.equal(resumed.files,1);assert.equal(f.engine.baselineProgress,undefined);
 assert.equal(f.engine.coverage.traces.get(completed.groupId).timestamp,completed.timestamp);
 // Reopen restores stale coverage, while a new baseline is still required.
 const {CoverageStore}=require('../../out/core/coverage'), {CoverageCache}=require('../../out/services/cache');
 const restored=new CoverageStore();await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(restored);
 assert.equal(restored.traces.size,2);assert.ok([...restored.traces.values()].every(trace=>trace.stale && !trace.reliable));
});

test('workspace roots can change and each nested SDK context is checked',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 const empty=path.join(f.temp,'empty');await fs.mkdir(empty);
 f.engine.setRoots([empty,f.root]);assert.equal((await f.run([],true)).passed,3);
 f.engine.setRoots([empty]);assert.equal((await f.run([],true)).tests,0);assert.equal(f.engine.groups.length,0);
 await fs.writeFile(f.file('ImpactDemo.Tests/global.json'),JSON.stringify({sdk:{version:'9.0.100',rollForward:'disable'}}));
 f.engine.setRoots([f.root]);await assert.rejects(f.run([],true),/SDK|sdk|9\.0\.100/);
});

for(const framework of ['xunit','nunit']) {
 test(`${framework} MTP discovers files, retains coverage and runs affected tests`,{timeout:120000},async t=>{
  const f=await fixture(t), project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
  const configuration=framework==='xunit'
   ? '<UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>'
   : '<EnableNUnitRunner>true</EnableNUnitRunner>';
  const packages=framework==='xunit'
   ? '<PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0" />'
   : '<PackageReference Include="NUnit" Version="4.4.0" /><PackageReference Include="NUnit3TestAdapter" Version="6.3.0" />';
  await fs.writeFile(project,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings>${configuration}</PropertyGroup><ItemGroup>${packages}<ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" /></ItemGroup></Project>`);
  await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),framework==='xunit'
   ? 'using Xunit; using ImpactDemo; public class CalculatorTests { [Theory][InlineData(1,2,3)][InlineData(4,5,9)] public void Add(int a,int b,int expected)=>Assert.Equal(expected,Calculator.Add(a,b)); }'
   : 'using NUnit.Framework; using ImpactDemo; public class CalculatorTests { [TestCase(1,2,3)][TestCase(4,5,9)] public void Add(int a,int b,int expected)=>Assert.That(Calculator.Add(a,b),Is.EqualTo(expected)); }');
  await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),framework==='xunit'
   ? 'using Xunit; using ImpactDemo; public class GreetingTests { [Fact] public void Hello()=>Assert.Equal("Hello, Ada",Greeting.For("Ada")); }'
   : 'using NUnit.Framework; using ImpactDemo; public class GreetingTests { [Test] public void Hello()=>Assert.That(Greeting.For("Ada"),Is.EqualTo("Hello, Ada")); }');
  const baseline=await f.run([],true);assert.equal(baseline.passed,3);assert.equal(f.engine.groups.length,2);
  const source=f.file('ImpactDemo/Arithmetic.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
  const affected=await f.run([source]);assert.equal(affected.files,1);assert.equal(affected.failed,2);
 });
}

test('xUnit Unicode and colliding row names retain stable IDs and support selected reruns',{timeout:90000},async t=>{
 const f=await fixture(t), prefix='a'.repeat(1000);
 await fs.writeFile(f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0" /><ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" /></ItemGroup></Project>');
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Xunit; using ImpactDemo; public class CalculatorTests { [Theory][InlineData("${prefix}1")][InlineData("${prefix}2")] public void Duplicate(string value)=>Assert.EndsWith("1",value); [Fact(DisplayName="Unicode café 日本語 😀")] public void Normal()=>Assert.Equal(3,Calculator.Add(1,2)); }`);
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Xunit; public class GreetingTests { [Fact] public void Hello()=>Assert.True(true); }');
 const baseline=await f.run([],true);assert.equal(baseline.tests,4);assert.equal(baseline.failed,1);
 const group=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
 const passed=f.state.results.find(result=>result.file===group.file&&result.name.includes('Duplicate')&&result.outcome==='passed');
 const failed=f.state.results.find(result=>result.file===group.file&&result.outcome==='failed');
 assert.equal(passed.name,failed.name);assert.notEqual(passed.id,failed.id);
 const ids=group.tests.map(test=>test.id).sort();
 const manual=async id=>f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([id])]]),coverage:true});
 const pass=await manual(passed.id);assert.equal(pass.tests,1);assert.equal(pass.passed,1);
 const fail=await manual(failed.id);assert.equal(fail.tests,1);assert.equal(fail.failed,1);
 assert.deepEqual(f.engine.groups.find(item=>item.id===group.id).tests.map(test=>test.id).sort(),ids);
 f.config.mode='all';assert.equal((await f.run([],true)).failed,1,'a full-project request also reports every row');
});

test('xUnit deferred theories retain failures when rerunning shared discovery identities',{timeout:90000},async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup><ItemGroup><PackageReference Include="xunit.v3.mtp-v2" Version="3.2.0" /><ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" /></ItemGroup></Project>');
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),'using Xunit; using ImpactDemo; public class CalculatorTests { [Theory(DisableDiscoveryEnumeration=true)][InlineData(1,2,4)][InlineData(4,5,9)] public void Add(int a,int b,int expected)=>Assert.Equal(expected,Calculator.Add(a,b)); }');
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Xunit; public class GreetingTests { [Fact] public void Hello()=>Assert.True(true); }');
 const baseline=await f.run([],true);assert.equal(baseline.tests,2);assert.equal(baseline.failed,1);
 const group=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
 const failed=f.state.results.find(result=>result.file===group.file&&result.outcome==='failed');
 assert.ok(group.tests.some(test=>test.id===failed.id),'this provider reports execution rows using the discovered theory UID');
 assert.ok(f.engine.knownTests(group).some(test=>test.id===failed.id));
 const rerun=await f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([failed.id])]]),coverage:true});
 assert.equal(rerun.tests,1);assert.equal(rerun.failed,1);assert.equal(rerun.passed,0);
 const updates=f.state.results.filter(result=>result.file===group.file);
 assert.ok(updates.some(result=>result.name.includes('expected: 9')),'both deferred rows must execute');
 assert.equal(f.engine.coverage.traces.get(group.id).reliable,false,'runtime-only row attribution remains conservative');
});

test('linked source and two target frameworks maintain separate test identities',{timeout:120000},async t=>{
 const f=await fixture(t), project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('<TargetFramework>net10.0</TargetFramework>','<TargetFrameworks>net10.0;net10.0-windows</TargetFrameworks><EnableWindowsTargeting>true</EnableWindowsTargeting>'));
 const linked=path.join(f.temp,'linked');await fs.mkdir(linked);const source=normalizePath(path.join(linked,'Arithmetic.cs'));
 await fs.rename(f.file('ImpactDemo/Arithmetic.cs'),source);
 const library=f.file('ImpactDemo/ImpactDemo.csproj');await fs.writeFile(library,(await fs.readFile(library,'utf8')).replace('</Project>',`<ItemGroup><Compile Include="${source}" Link="Arithmetic.cs" /></ItemGroup></Project>`));
 const baseline=await f.run([],true);assert.equal(baseline.tests,6);assert.equal(baseline.passed,6);assert.equal(f.engine.groups.length,4);
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
 const changed=await f.run([source]);assert.equal(changed.tests,4);assert.equal(changed.failed,4);assert.equal(changed.files,2);
});

test('shared imports and resources select every consuming project',{timeout:90000},async t=>{
 const f=await fixture(t),other=f.file('Other.Tests');await fs.mkdir(other);
 const props=f.file('ImpactDemo.Tests/Shared.props'),resource=f.file('ImpactDemo.Tests/shared.txt');
 const settings=flag=>`<Project><PropertyGroup><DefineConstants>$(DefineConstants);${flag}</DefineConstants></PropertyGroup></Project>`;
 await fs.writeFile(props,settings('OK'));await fs.writeFile(resource,'before');
 await fs.writeFile(path.join(other,'Other.Tests.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><EnableMSTestRunner>true</EnableMSTestRunner><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport></PropertyGroup><Import Project="../ImpactDemo.Tests/Shared.props"/><ItemGroup><PackageReference Include="MSTest" Version="4.3.3"/><EmbeddedResource Include="../ImpactDemo.Tests/shared.txt"/></ItemGroup></Project>');
 await fs.writeFile(path.join(other,'OtherTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class OtherTests { [TestMethod] public void ImportedSetting() {\n#if BROKEN\nAssert.Fail("Imported setting changed");\n#else\nAssert.IsTrue(true);\n#endif\n} }');
 assert.equal((await f.run([],true)).passed,4);
 await fs.writeFile(props,settings('BROKEN'));const affected=await f.run([props]);assert.equal(affected.failed,1);assert.ok(f.state.selected.includes('OtherTests.cs'));
 await fs.writeFile(props,settings('OK'));await f.run([props]);
 await fs.writeFile(resource,'after');await f.run([resource]);assert.ok(f.state.selected.includes('OtherTests.cs'));
});

test('reference AdditionalProperties control the build and contextual source ownership',{timeout:90000},async t=>{
 const f=await fixture(t),project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),library=f.file('ImpactDemo/ImpactDemo.csproj');
 const external=normalizePath(path.join(f.temp,'OnlyFromTests.cs'));
 await fs.writeFile(external,'namespace ImpactDemo; public static class Conditional { public static int Value => 0; }');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('Include="../ImpactDemo/ImpactDemo.csproj"','Include="../ImpactDemo/ImpactDemo.csproj" AdditionalProperties="FromTests=true"'));
 await fs.writeFile(library,(await fs.readFile(library,'utf8')).replace('</Project>',`<PropertyGroup Condition="'$(FromTests)' == 'true'"><DefineConstants>$(DefineConstants);FROM_TESTS</DefineConstants></PropertyGroup><ItemGroup Condition="'$(FromTests)' == 'true'"><Compile Include="${external}"/></ItemGroup></Project>`));
 const arithmetic=f.file('ImpactDemo/Arithmetic.cs');let source=await fs.readFile(arithmetic,'utf8');
 source=source.replace('a + b;','a + b + Flag;').replace('public static int Sum','public static int Flag =>\n#if FROM_TESTS\nConditional.Value;\n#else\n1;\n#endif\n    public static int Sum');await fs.writeFile(arithmetic,source);
 assert.equal((await f.run([],true)).passed,3);assert.ok(f.engine.knownFiles.includes(external));
 await fs.writeFile(external,'namespace ImpactDemo; public static class Conditional { public static int Value => 1; }');
 assert.equal((await f.run([external])).failed,2);
});

test('manual file and project containers discover new tests and files while automation is idle',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.run([],true)).passed,3);
 const source=f.file('ImpactDemo.Tests/CalculatorTests.cs'),group=f.engine.groups.find(group=>group.file===source),original=await fs.readFile(source,'utf8');
 await fs.writeFile(source,original.slice(0,original.lastIndexOf('}'))+'[Microsoft.VisualStudio.TestTools.UnitTesting.TestMethod] public void NewlyAdded() => Microsoft.VisualStudio.TestTools.UnitTesting.Assert.Fail("new failure");\n}\n');
 const selected=await f.run([],false,{groups:new Set([group.id]),coverage:false});assert.equal(selected.tests,3);assert.equal(selected.failed,1);
 await fs.writeFile(f.file('ImpactDemo.Tests/NewFileTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class NewFileTests { [TestMethod] public void NewFile() => Assert.Fail("new file"); }');
 const project=await f.run([],false,{groups:new Set(),projects:new Set([group.project]),coverage:false});assert.equal(project.tests,5);assert.equal(project.failed,2);
 const workspace=await f.run([],false,{groups:new Set(),all:true,exclude:{groups:new Set([group.id])},coverage:false});assert.equal(workspace.tests,2);assert.equal(workspace.failed,1);
});
