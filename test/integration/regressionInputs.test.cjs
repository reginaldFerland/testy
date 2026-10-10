// Regression scenarios: build inputs, references and watchers. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
// Patch the defining modules: `projects` only re-exports them through read-only bindings.
const projectGraph=require('../../out/services/projectGraph');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('../unit/support/ui.cjs');
const {defined,fixture,editorInputs}=require('./support/regressions.cjs');

test('tooling files and editor settings neither restore nor run tests, while unowned test data and an owned appsettings.json do',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.run([],true)).passed,3);
 const restored=[...f.engine.restored].sort();assert.ok(restored.length>0);
 await fs.mkdir(f.file('.vscode'),{recursive:true});
 const unrelated=[f.file('package.json'),f.file('tsconfig.json'),f.file('.vscode/settings.json')];
 for(const file of unrelated){await fs.writeFile(file,'{}');}
 const ignored=await f.run(unrelated);assert.equal(ignored.tests,0);assert.deepEqual(f.state.selected,[]);
 assert.deepEqual([...f.engine.restored].sort(),restored,'no project is restored again');
 // Tests may read data outside every project at runtime; no trace maps it, so it must select tests, not a green empty run.
 await fs.mkdir(f.file('testdata'));const cases=f.file('testdata/cases.json');await fs.writeFile(cases,'[1,2]');
 const data=await f.run([cases]);assert.equal(data.tests,3,'unowned test data selects every project');
 assert.deepEqual([...f.engine.restored].sort(),restored,'unowned test data does not repeat Restore');
 const settings=f.file('ImpactDemo.Tests/appsettings.json');await fs.writeFile(settings,'{"value":1}');
 const created=await f.run([settings]);assert.equal(created.tests,3,'a new evaluated input selects its owning test project');
 assert.ok(f.engine.index.hasSource(settings));
 await fs.writeFile(settings,'{"value":2}');
 const edited=await f.run([settings]);assert.equal(edited.tests,3);
 assert.deepEqual([...f.engine.restored].sort(),restored,'an ordinary input never repeats Restore');
});

test('manual builds ignore unrelated broken projects and preserve their pending changes',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 await fs.mkdir(f.file('Other'));
 await fs.writeFile(f.file('Other/Other.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(f.file('Other/Code.cs'),'public class Other {}');
 assert.equal((await f.run([],true)).passed,3);
 await fs.writeFile(f.file('Other/Code.cs'),'public class Broken {');
 const group=defined(f.engine.groups.find(group=>defined(group.file).endsWith('CalculatorTests.cs')));
 assert.equal((await f.run([],false,{groups:new Set([group.id]),coverage:false})).passed,2);
 await assert.rejects(f.run(),error=>{
  assert.match(/** @type {Error} */ (error).message,/Building.*failed/);assert.match(/** @type {Error} */ (error).message,/Other\.csproj/);return true;
 },'an unrelated edit consumed during the manual refresh must stay pending');
});

test('an excluded production dependency is still built from a clean checkout',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.excludes=['ImpactDemo/**'];
 const result=await f.run([],true);assert.equal(result.passed,3);
 assert.equal(f.engine.projects.length,1,'excluded dependency is not included in watched discovery');
});

test('binary Reference builds the changed workspace input and selects its runtime dependents',{timeout:90000},async t=>{
 const f=await fixture(t), project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('<ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" />','<Reference Include="ImpactDemo"><HintPath>../ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll</HintPath></Reference>'));
 assert.equal((await f.run([],true)).passed,3);
 const source=f.file('ImpactDemo/Arithmetic.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
 const affected=await f.run([source]);assert.equal(affected.tests,2);assert.equal(affected.failed,2);
 assert.deepEqual(f.state.selected,['CalculatorTests.cs']);
});

test('shared imports and resources select every consuming project',{timeout:90000},async t=>{
 const f=await fixture(t),other=f.file('Other.Tests');await fs.mkdir(other);
 const props=f.file('ImpactDemo.Tests/Shared.props'),resource=f.file('ImpactDemo.Tests/shared.txt');
 const settings=(/** @type {string} */ flag)=>`<Project><PropertyGroup><DefineConstants>$(DefineConstants);${flag}</DefineConstants></PropertyGroup></Project>`;
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

test('binary consumers build contextual producers first from clean and stale outputs',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 await fs.cp(f.file('ImpactDemo.Tests'),f.file('AConsumer.Tests'),{recursive:true});
 const consumer=f.file('AConsumer.Tests/ImpactDemo.Tests.csproj'),producer=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(consumer,(await fs.readFile(consumer,'utf8')).replace('<ProjectReference Include="../ImpactDemo/ImpactDemo.csproj" />','<Reference Include="Special"><HintPath>../ImpactDemo/bin/Debug/net10.0/Special.dll</HintPath></Reference>'));
 await fs.writeFile(producer,(await fs.readFile(producer,'utf8')).replace('Include="../ImpactDemo/ImpactDemo.csproj"','Include="../ImpactDemo/ImpactDemo.csproj" AdditionalProperties="AssemblyName=Special"'));
 assert.equal((await f.run([],true)).passed,6);
 const source=f.file('ImpactDemo/Arithmetic.cs');
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 1'));
 const changed=await f.run([source]);assert.equal(changed.tests,6);assert.equal(changed.failed,4);
});

test('fresh conditional MSBuild contexts form a valid build chain through the same project twice',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 await fs.mkdir(f.file('A'));await fs.mkdir(f.file('B'));
 await fs.writeFile(f.file('A/A.csproj'),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup Condition="'$(Flavor)' != 'Leaf'"><ProjectReference Include="../B/B.csproj" AdditionalProperties="Flavor=Middle"/></ItemGroup></Project>`);
 await fs.writeFile(f.file('B/B.csproj'),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup Condition="'$(Flavor)' == 'Middle'"><ProjectReference Include="../A/A.csproj" AdditionalProperties="Flavor=Leaf"/></ItemGroup></Project>`);
 const tests=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(tests,(await fs.readFile(tests,'utf8')).replace('</ItemGroup>','<ProjectReference Include="../A/A.csproj"/></ItemGroup>'));
 assert.equal((await f.run([],true)).passed,3);
 const order=require('../../out/services/projects').buildOrder(f.engine.projects,new Set([tests]));
 const a=order.filter(project=>project.file===f.file('A/A.csproj'));assert.ok(a.length>=2);assert.ok(a.some(project=>defined(project.properties).Flavor==='Leaf'));
});

test('an unchanged manual leaf reuses its validated evaluation in a shared solution',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 for(let i=1;i<4;i++){await fs.cp(f.file('ImpactDemo.Tests'),f.file(`Tests${i}`),{recursive:true});}
 assert.equal((await f.run([],true)).passed,12);
 const group=f.engine.groups[0],evaluate=projectGraph.evaluateProjects,/** @type {unknown[]} */ evaluated=[];
 projectGraph.evaluateProjects=async(...args)=>{evaluated.push(...args[1]);return evaluate(...args);};
 try{
  const result=await f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([group.tests[0].id])]]),coverage:false});
  assert.equal(result.tests,1);assert.deepEqual(evaluated,[]);
 }finally{projectGraph.evaluateProjects=evaluate;}
});

test('shared editorconfig saves must invalidate the projects they compile',{timeout:90000},async t=>{
 const f=await fixture(t); f.config.coverage=false;
 const config=f.file('.editorconfig');
 await fs.writeFile(config,'root = true\n[*.cs]\ndotnet_diagnostic.CS0168.severity = none\n');
 await fs.appendFile(f.file('ImpactDemo/Calculator.cs'),'\ninternal class W { public void M() { int unused; } }');
 const baseline=await f.run([],true);assert.equal(baseline.passed,3);assert.ok(f.engine.knownFiles.includes(config));
 const contents='root = true\n[*.cs]\ndotnet_diagnostic.CS0168.severity = error\n';
 await fs.writeFile(config,contents);
 const loaded=loadUi();
 const /** @type {unknown[][]} */ requests=[],context={roots:[normalizePath(f.root)],disposed:false,engine:f.engine,scheduler:{request:(/** @type {unknown[]} */ ...args)=>requests.push(args)},queueChanged:(/** @type {string[]} */ files)=>f.engine.markChanged(files),
  config:{excludes:[],pattern:'**/*.{cs,csproj,sln,slnx,props,targets,runsettings,json,config,resx}'}};
 await loaded.changeWatcher(context).changed({scheme:'file',fsPath:config},contents);
 let actualBuildError='';try {await f.run([],true);}catch(e){actualBuildError=/** @type {Error} */ (e).message;}
 assert.match(actualBuildError,/CS0168/);
 assert.equal(requests.length,1,'the saved compiler configuration should trigger a run');
});

test('an inherited SDK pin remains observable through initial failure and subsequent saves',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;await fs.rm(f.file('global.json'));
 const {runProcess,requireSuccess}=require('../../out/services/process');
 const version=requireSuccess(await runProcess('dotnet',['--version'],{cwd:f.root}),'Reading selected SDK').stdout.trim();
 const global=normalizePath(path.join(f.temp,'global.json')),valid=JSON.stringify({sdk:{version,rollForward:'disable'}}),invalid=JSON.stringify({sdk:{version:'9.0.100',rollForward:'disable'}});
 const editor=await editorInputs(f);await fs.writeFile(global,invalid);await assert.rejects(f.run([],true),/SDK|sdk|9\.0\.100/);
 assert.ok(f.engine.knownFiles.includes(global));assert.ok(editor.patterns.some(p=>p.base===normalizePath(f.temp)&&p.pattern==='*'));
 await fs.writeFile(global,valid);await editor.changed(global);assert.equal(editor.requests.length,1);assert.equal((await f.run(editor.requests[0][0])).passed,3);
 assert.ok(f.engine.hashes.has(global));
 await fs.writeFile(global,invalid);await editor.changed(global);assert.equal(editor.requests.length,2);await assert.rejects(f.run(editor.requests[1][0]),/SDK|sdk|9\.0\.100/);
 await fs.writeFile(global,valid);await editor.changed(global);assert.equal(editor.requests.length,3);assert.equal((await f.run(editor.requests[2][0])).passed,3);
});

test('external input watchers are published before a first failed build or discovery',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 const external=normalizePath(path.join(f.temp,'linked'));await fs.mkdir(external);
 const linked=normalizePath(path.join(external,'Arithmetic.cs')),source=f.file('ImpactDemo/Arithmetic.cs'),original=await fs.readFile(source,'utf8');
 await fs.rm(source);await fs.writeFile(linked,original.replace('a + b','a +'));
 const project=f.file('ImpactDemo/ImpactDemo.csproj');await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',`<ItemGroup><Compile Include="${linked}" Link="Arithmetic.cs" /></ItemGroup></Project>`));
 const editor=await editorInputs(f);await assert.rejects(f.run([],true),/Building.*failed/);
 assert.ok(f.engine.knownFiles.includes(linked));assert.ok(editor.patterns.some(p=>p.base===external),'a failing build still installs external watchers');
 await fs.writeFile(linked,original);await editor.changed(linked);assert.equal(editor.requests.length,1);assert.equal((await f.run(editor.requests[0][0])).passed,3);
 // Discover a new external input during a later failing discovery as well.
 const other=normalizePath(path.join(f.temp,'data'));await fs.mkdir(other);const data=normalizePath(path.join(other,'tests.txt'));await fs.writeFile(data,'fixture');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',`<ItemGroup><AdditionalFiles Include="${data}" /></ItemGroup></Project>`));
 const mtp=require('../../out/services/mtp'),request=mtp.requestTests;
 try{mtp.requestTests=async()=>{throw new Error('controlled discovery failure');};await assert.rejects(f.run([project]),/controlled discovery failure/);}
 finally{mtp.requestTests=request;}
 assert.ok(editor.patterns.some(p=>p.base===other));await editor.changed(data);assert.equal(editor.requests.length,2);assert.equal((await f.run(editor.requests[1][0])).passed,3);
});
