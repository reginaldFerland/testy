// Regression scenarios: runtime module attribution. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {defined,fixture}=require('./support/regressions.cjs');

test('mapped source methods sharing a physical file with observed code cannot hide failing callers',{timeout:90000},async t=>{
 const f=await fixture(t),arithmetic=f.file('ImpactDemo/Arithmetic.cs'),greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 const source=(await fs.readFile(arithmetic,'utf8')).replace('    public static int Sum','#line 200 "VirtualArithmetic.cs"\n    public static int Mapped(int value) => value;\n#line default\n    public static int Sum');
 await fs.writeFile(arithmetic,source);
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);','Assert.AreEqual(3, Arithmetic.Expected); Assert.AreEqual(7, Arithmetic.Mapped(7));'));
 assert.equal((await f.run([],true)).passed,3);
 await fs.writeFile(arithmetic,source.replace('Mapped(int value) => value;','Mapped(int value) => value + 1;'));
 const affected=await f.run([arithmetic]);assert.equal(affected.tests,3);assert.equal(affected.failed,1);
 assert.ok(f.state.selected.includes('GreetingTests.cs'));
});

test('dynamically loaded workspace code must select its calling test file',{timeout:90000},async t=>{
 const f=await fixture(t);
 const source=f.file('ImpactDemo/Calculator.cs'),originalAssembly=path.join(f.root,'ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll');
 await fs.writeFile(source,'namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>1; public static int OtherValue()=>2; }');
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests { [TestMethod] public void Dynamic() { var assembly=System.Reflection.Assembly.LoadFile(@"${originalAssembly.replaceAll('"','""')}"); Assert.AreEqual(1,(int)assembly.GetType("ImpactDemo.Calculator")!.GetMethod("DynamicValue")!.Invoke(null,null)!); } }`);
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class GreetingTests { [TestMethod] public void Direct() => Assert.AreEqual(2,Calculator.OtherValue()); }');
 assert.equal((await f.run([],true)).passed,2);
 const dynamic=defined(f.engine.groups.find(g=>defined(g.file).endsWith('CalculatorTests.cs')));
 assert.ok(defined(f.engine.coverage.traces.get(dynamic.id)).dependencies.includes(source));
 await fs.writeFile(source,'namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>3; public static int OtherValue()=>2; }');
 const affected=await f.run([source]);assert.deepEqual(new Set(f.state.selected),new Set(['CalculatorTests.cs','GreetingTests.cs']));
 assert.equal((await f.run([],true)).failed,1);
 assert.equal(affected.failed,1,'affected run must include the changed reflected method');
});

test('in-memory loads and managed child processes retain workspace module dependencies',{timeout:120000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs'),tests=f.file('ImpactDemo.Tests/CalculatorTests.cs');
 const library=path.join(f.root,'ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll');
 await fs.mkdir(f.file('Child'));
 await fs.writeFile(f.file('Child/Child.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><ProjectReference Include="../ImpactDemo/ImpactDemo.csproj"/></ItemGroup></Project>');
 await fs.writeFile(f.file('Child/Program.cs'),'System.Console.WriteLine(ImpactDemo.Calculator.DynamicValue());');
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class GreetingTests { [TestMethod] public void Direct() => Assert.AreEqual(2,Calculator.OtherValue()); }');
 const value=(/** @type {number} */ n)=>`namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>${n}; public static int OtherValue()=>2; }`;
 for(const kind of ['memory','child']){
  await fs.writeFile(source,value(1));
  const body=kind==='memory'?`var assembly=System.Reflection.Assembly.Load(System.IO.File.ReadAllBytes(@"${library}")); Assert.AreEqual(1,(int)assembly.GetType("ImpactDemo.Calculator")!.GetMethod("DynamicValue")!.Invoke(null,null)!);`
   :`var p=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("dotnet") { ArgumentList={ @"${path.join(f.root,'Child/bin/Debug/net10.0/Child.dll')}" }, UseShellExecute=false, RedirectStandardOutput=true }); var output=p!.StandardOutput.ReadToEnd(); p.WaitForExit(); Assert.AreEqual("1",output.Trim());`;
  await fs.writeFile(tests,`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests { [TestMethod] public void Dynamic() { ${body} } }`);
  assert.equal((await f.run([],true)).passed,2,kind);
  const group=defined(f.engine.groups.find(g=>g.file===tests)),trace=defined(f.engine.coverage.traces.get(group.id));
  assert.equal(trace.reliable,true,kind);assert.ok(defined(trace.moduleProjects).includes(f.file('ImpactDemo/ImpactDemo.csproj')),kind);
  await fs.writeFile(source,value(3));assert.equal((await f.run([source])).failed,1,kind);
 }
});

test('module dependencies select callers without ProjectReference when a new source file changes discovery',{timeout:90000},async t=>{
 const f=await fixture(t),library=path.join(f.root,'ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll');
 await fs.mkdir(f.file('DynamicTests'));
 const project=await fs.readFile(f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),'utf8');
 await fs.writeFile(f.file('DynamicTests/DynamicTests.csproj'),project.replace('<ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" />',''));
 await fs.writeFile(f.file('DynamicTests/ReflectionTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class ReflectionTests { [TestMethod] public void NoNewType() { var a=System.Reflection.Assembly.LoadFile(@"${library}"); Assert.IsNull(a.GetType("ImpactDemo.Added")); } }`);
 assert.equal((await f.run([],true)).passed,4);
 const added=f.file('ImpactDemo/Added.cs');await fs.writeFile(added,'namespace ImpactDemo; public class Added {}');
 const result=await f.run([added]);assert.equal(result.failed,1);assert.ok(f.state.selected.includes('ReflectionTests.cs'));
});

test('symbol-less workspace modules retain affected callers without selecting unrelated tests',{timeout:90000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs');
 const content=(/** @type {number} */ n)=>`namespace ImpactDemo; public static class Calculator { public static int Blind(int value) => value + ${n}; public static int Visible(int value) => value + 1; }`;
 await fs.writeFile(source,content(1));
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),'using ImpactDemo; using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class CalculatorTests { [TestMethod] public void C() => Assert.AreEqual(2,Calculator.Visible(1)); }');
 await fs.mkdir(f.file('BlindLibrary'));await fs.writeFile(f.file('BlindLibrary/BlindLibrary.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><DebugType>none</DebugType></PropertyGroup><ItemGroup><Compile Include="../ImpactDemo/Calculator.cs" Link="Calculator.cs" /></ItemGroup></Project>');
 await fs.mkdir(f.file('BlindTests'));await fs.writeFile(f.file('BlindTests/BlindTests.csproj'),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../BlindLibrary/BlindLibrary.csproj" /></ItemGroup></Project>');
 await fs.writeFile(f.file('BlindTests/BlindTests.cs'),'using ImpactDemo; using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class BlindCases { [TestMethod] public void C() => Assert.AreEqual(2,Calculator.Blind(1)); }');
 assert.equal((await f.run([],true)).passed,3);
 const caller=defined(f.engine.groups.find(group=>defined(group.file).endsWith('/BlindTests.cs'))),trace=defined(f.engine.coverage.traces.get(caller.id));
 assert.equal(trace.reliable,true);assert.ok(trace.dependencies.includes(source));assert.ok(defined(trace.moduleProjects).includes(f.file('BlindLibrary/BlindLibrary.csproj')));
 assert.ok(f.state.output.some(text=>text.includes('No instrumentation change in BlindLibrary.dll')));
 await fs.writeFile(source,content(2));const affected=await f.run([source]);
 assert.equal(affected.failed,1);assert.equal(affected.tests,2);assert.deepEqual(new Set(f.state.selected),new Set(['BlindTests.cs','CalculatorTests.cs']));
 const all=await f.run([],true);assert.equal(all.tests,3);assert.equal(affected.failed,all.failed);
});
