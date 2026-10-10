// Regression scenarios: framework rows and target frameworks. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalizePath}=require('../../out/core/paths');
const {defined,fixture}=require('./support/regressions.cjs');

test('execution-time rows preserve a failure followed by a pass under one UID',{timeout:90000},async t=>{
 const f=await fixture(t), file=f.file('ImpactDemo.Tests/CalculatorTests.cs');
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('[DataRow(1, 2, 3)]','[DataRow(1, 2, 4)]').replace('namespace ImpactDemo.Tests;','[assembly: TestDataSourceDiscovery(TestDataSourceDiscoveryOption.DuringExecution)]\nnamespace ImpactDemo.Tests;'));
 const result=await f.run([],true);assert.equal(result.failed,1);assert.equal(result.passed,1);
 const calculator=defined(f.engine.groups.find(group=>group.file===file));
 assert.equal(defined(f.engine.coverage.traces.get(calculator.id)).reliable,false);
 assert.equal(defined(f.state.results.filter(result=>result.file===file).at(-1)).outcome,'failed');
 assert.equal(f.state.prepared,1,'prepare and instrument each project output once');
});

test('all skipped and class initialization failures do not stop other test files',{timeout:90000},async t=>{
 const f=await fixture(t), file=f.file('ImpactDemo.Tests/CalculatorTests.cs'), original=await fs.readFile(file,'utf8');
 await fs.writeFile(file,original.replace('[TestClass]','[TestClass]\n[Ignore]'));
 const skipped=await f.run([],true);assert.equal(skipped.passed,1);assert.equal(skipped.skipped,2);
 await fs.writeFile(file,original.replace('public class CalculatorTests\n{','public class CalculatorTests\n{\n    [ClassInitialize] public static void Init(TestContext context) => throw new System.Exception("intentional initialization failure");'));
 const failed=await f.run([],true);assert.equal(failed.passed,1);assert.equal(failed.failed,2);
});

for(const [framework,demo] of [['xunit','XunitDemo'],['nunit','NUnitDemo']]) {
 test(`${framework} MTP discovers files, retains coverage and runs affected tests`,{timeout:120000},async t=>{
  const f=await fixture(t,demo);
  const baseline=await f.run([],true);assert.equal(baseline.passed,3);assert.equal(f.engine.groups.length,2);
  const source=f.file('ImpactDemo/Arithmetic.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
  const affected=await f.run([source]);assert.equal(affected.files,1);assert.equal(affected.failed,2);
 });
}

test('xUnit Unicode and colliding row names retain stable IDs and support selected reruns',{timeout:90000},async t=>{
 const f=await fixture(t,'XunitDemo'), prefix='a'.repeat(1000);
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Xunit; using ImpactDemo; public class CalculatorTests { [Theory][InlineData("${prefix}1")][InlineData("${prefix}2")] public void Duplicate(string value)=>Assert.EndsWith("1",value); [Fact(DisplayName="Unicode café 日本語 😀")] public void Normal()=>Assert.Equal(3,Calculator.Add(1,2)); }`);
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Xunit; public class GreetingTests { [Fact] public void Hello()=>Assert.True(true); }');
 const baseline=await f.run([],true);assert.equal(baseline.tests,4);assert.equal(baseline.failed,1);
 const group=defined(f.engine.groups.find(group=>defined(group.file).endsWith('CalculatorTests.cs')));
 const passed=defined(f.state.results.find(result=>result.file===group.file&&result.name.includes('Duplicate')&&result.outcome==='passed'));
 const failed=defined(f.state.results.find(result=>result.file===group.file&&result.outcome==='failed'));
 assert.equal(passed.name,failed.name);assert.notEqual(passed.id,failed.id);
 const ids=group.tests.map(test=>test.id).sort();
 const manual=async (/** @type {string} */ id)=>f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([id])]]),coverage:true});
 const pass=await manual(passed.id);assert.equal(pass.tests,1);assert.equal(pass.passed,1);
 const fail=await manual(failed.id);assert.equal(fail.tests,1);assert.equal(fail.failed,1);
 assert.deepEqual(defined(f.engine.groups.find(item=>item.id===group.id)).tests.map(test=>test.id).sort(),ids);
 f.config.mode='all';assert.equal((await f.run([],true)).failed,1,'a full-project request also reports every row');
});

test('xUnit deferred theories retain failures when rerunning shared discovery identities',{timeout:90000},async t=>{
 const f=await fixture(t,'XunitDemo');
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),'using Xunit; using ImpactDemo; public class CalculatorTests { [Theory(DisableDiscoveryEnumeration=true)][InlineData(1,2,4)][InlineData(4,5,9)] public void Add(int a,int b,int expected)=>Assert.Equal(expected,Calculator.Add(a,b)); }');
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Xunit; public class GreetingTests { [Fact] public void Hello()=>Assert.True(true); }');
 const baseline=await f.run([],true);assert.equal(baseline.tests,2);assert.equal(baseline.failed,1);
 const group=defined(f.engine.groups.find(group=>defined(group.file).endsWith('CalculatorTests.cs')));
 const failed=defined(f.state.results.find(result=>result.file===group.file&&result.outcome==='failed'));
 assert.ok(group.tests.some(test=>test.id===failed.id),'this provider reports execution rows using the discovered theory UID');
 assert.ok(f.engine.knownTests(group).some(test=>test.id===failed.id));
 const rerun=await f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([failed.id])]]),coverage:true});
 assert.equal(rerun.tests,1);assert.equal(rerun.failed,1);assert.equal(rerun.passed,0);
 const updates=f.state.results.filter(result=>result.file===group.file);
 assert.ok(updates.some(result=>result.name.includes('expected: 9')),'both deferred rows must execute');
 assert.equal(defined(f.engine.coverage.traces.get(group.id)).reliable,false,'runtime-only row attribution remains conservative');
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
