const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const projects=require('../../out/services/projects');
const {normalizePath}=require('../../out/core/paths');

test('excluded production dependencies still serialize conflicting reference contexts',{timeout:120000},async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-excluded-build-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'workspace'),hidden=path.join(root,'Excluded','Core');await fs.mkdir(hidden,{recursive:true});
 const library=normalizePath(path.join(hidden,'Core.csproj')),source=normalizePath(path.join(hidden,'Core.cs'));
 await fs.writeFile(library,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><DefineConstants Condition="'$(Flavor)' == 'First'">$(DefineConstants);FIRST</DefineConstants></PropertyGroup></Project>`);
 await fs.writeFile(source,'public static class Core { public static int Value =>\n#if FIRST\n11;\n#else\n22;\n#endif\n}');
 const targets=[];
 for(const [name,value] of [['First',11],['Second',22]]){
  const directory=path.join(root,`${name}.Tests`);await fs.mkdir(directory);
  const file=normalizePath(path.join(directory,`${name}.Tests.csproj`));targets.push(file);
  await fs.writeFile(file,`<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Excluded/Core/Core.csproj" AdditionalProperties="Flavor=${name}"/></ItemGroup></Project>`);
  await fs.writeFile(path.join(directory,'FlavorTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class FlavorTests { [TestMethod] public void UsesOwnReferenceContext() => Assert.AreEqual(${value},Core.Value); }`);
 }
 const output=[],results=[];
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),
  configuration:()=>({dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:['**/Excluded/**'],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2}),
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>results.push({project:group.project,...result}),started(){},coverage(){},invalidated(){}}});
 const build=projects.buildProjects,batches=[];let active=0,peak=0;
 projects.buildProjects=async(...args)=>{
  const roots=args[1];batches.push(roots.map(project=>project.file));
  assert.equal(roots.length,1,'the excluded Core contexts share outputs and must build in separate waves');
  peak=Math.max(peak,++active);try{return await build(...args);}finally{active--;}
 };
 try{
  const baseline=await engine.run({files:[],full:true},new AbortController().signal);
  assert.equal(baseline.tests,2);assert.equal(baseline.passed,2,output.join(''));assert.equal(baseline.failed,0);
  assert.deepEqual(new Set(batches.flat()),new Set(targets));assert.equal(batches.length,2);assert.equal(peak,1);assert.equal(active,0);
  assert.ok(engine.projects.every(project=>project.file!==library),'excluded projects stay outside the watched project inventory');
  assert.equal(engine.knownFiles.includes(source),false);assert.equal(engine.knownFiles.includes(library),false);
  assert.deepEqual(new Set(results.filter(result=>result.outcome==='passed').map(result=>result.project)),new Set(targets));
  const first=engine.groups.find(group=>group.project===targets[0]);assert.ok(first);batches.length=0;
  const manual=await engine.run({files:[],full:false},new AbortController().signal,{groups:new Set([first.id]),coverage:false});
  assert.equal(manual.tests,1);assert.equal(manual.passed,1,output.join(''));assert.deepEqual(batches,[[targets[0]]]);
  assert.deepEqual(await fs.readdir(path.join(temp,'state','runs')),[],'all isolated test outputs are cleaned up');
 }finally{projects.buildProjects=build;}
});
