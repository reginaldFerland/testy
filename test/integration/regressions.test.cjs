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
