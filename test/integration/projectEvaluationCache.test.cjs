const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
const projects=require('../../out/services/projects');

async function fixture(t){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-evaluation-integration-')),root=path.join(temp,'workspace');await fs.mkdir(root);
 const project=normalizePath(path.join(root,'Tests.csproj')),source=normalizePath(path.join(root,'Tests.cs'));
 await fs.writeFile(project,'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(source,'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class SmokeTests { [TestMethod] public void Pass() => Assert.IsTrue(true); }');
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2};
 const output=[];let evaluations=0;const evaluate=projects.evaluateProjects;
 projects.evaluateProjects=async(...args)=>{evaluations++;return evaluate(...args);};
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase:()=>{},discovered:()=>{},selected:()=>{},result:()=>{},started:()=>{},coverage:()=>{},invalidated:()=>{}}});
 t.after(async()=>{projects.evaluateProjects=evaluate;await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 return{temp,root,project,source,config,engine,output,evaluations:()=>evaluations,
  baseline:()=>engine.run({files:[],full:true},new AbortController().signal),
  manual:()=>engine.run({files:[],full:false},new AbortController().signal,{all:true,groups:new Set(),coverage:false})};
}

test('MSTest evaluations reuse immediately after baseline and detect idle file additions and deletions',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1);const before=f.evaluations();
 assert.equal((await f.manual()).passed,1);assert.equal(f.evaluations(),before,'unchanged manual run launches no Inspect');
 const added=path.join(f.root,'Added.cs');await fs.writeFile(added,'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Added { [TestMethod] public void AddedTest() => Assert.IsTrue(true); }');
 assert.equal((await f.manual()).passed,2);assert.ok(f.evaluations()>before);const addedCount=f.evaluations();
 await fs.rm(added);assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>addedCount);
});

test('SDK obj import globs invalidate without treating ordinary build artifacts as graph changes',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1);const before=f.evaluations();
 await fs.writeFile(path.join(f.root,'obj','unrelated-generated.txt'),'ordinary build output');
 assert.equal((await f.manual()).passed,1);assert.equal(f.evaluations(),before);
 const imported=path.join(f.root,'obj','Tests.csproj.extra.props');
 await fs.writeFile(imported,'<Project><PropertyGroup><DefineConstants>$(DefineConstants);EXTRA</DefineConstants></PropertyGroup></Project>');
 assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>before);const count=f.evaluations();
 await fs.rm(imported);assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>count);
});

test('absent imports, changed imports, SDK pins and build configuration invalidate retained evaluations',{timeout:120000},async t=>{
 const f=await fixture(t),optional=path.join(f.root,'Optional.props');
 await fs.writeFile(f.project,(await fs.readFile(f.project,'utf8')).replace('</Project>','<Import Project="Optional.props" Condition="Exists(\'Optional.props\')"/></Project>'));
 assert.equal((await f.baseline()).passed,1);assert.equal((await f.manual()).passed,1);let count=f.evaluations();assert.equal(count,1);
 for(const operation of [
  ()=>fs.writeFile(optional,'<Project><PropertyGroup><DefineConstants>FIRST</DefineConstants></PropertyGroup></Project>'),
  ()=>fs.writeFile(optional,'<Project><PropertyGroup><DefineConstants>OTHER</DefineConstants></PropertyGroup></Project>'),
  ()=>fs.rm(optional),
  ()=>fs.writeFile(path.join(f.root,'global.json'),'{}'),
  async()=>{f.config.configuration='Release';}
 ]){await operation();assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>count);count=f.evaluations();}
});

test('arbitrary evaluation file reads and custom output locations retain conservative inspection',{timeout:90000},async t=>{
 const f=await fixture(t),flag=path.join(f.root,'flag.txt');await fs.writeFile(flag,'FIRST');
 await fs.writeFile(f.project,(await fs.readFile(f.project,'utf8')).replace('</PropertyGroup>',`<DefineConstants>$([System.IO.File]::ReadAllText('${flag}'))</DefineConstants></PropertyGroup>`));
 assert.equal((await f.baseline()).passed,1);let count=f.evaluations();await fs.writeFile(flag,'OTHER');
 assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>count);
 await fs.writeFile(f.project,'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutDir>generated/</OutDir></PropertyGroup></Project>');
 assert.equal((await f.manual()).passed,1);count=f.evaluations();assert.equal((await f.manual()).passed,1);assert.ok(f.evaluations()>count);
});

test('an SDK wildcard import appearing after evaluation cannot validate an older graph',{timeout:90000},async t=>{
 const f=await fixture(t),probe=path.join(f.temp,'probe');await fs.mkdir(probe);
 const taskProject=path.join(probe,'Probe.csproj'),taskOutput=path.join(probe,'compiled'),result=path.join(probe,'result.json');
 await fs.writeFile(taskProject,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>
 <Reference Include="Microsoft.Build" HintPath="$(MSBuildToolsPath)/Microsoft.Build.dll" Private="false"/>
 <Reference Include="Microsoft.Build.Framework" HintPath="$(MSBuildToolsPath)/Microsoft.Build.Framework.dll" Private="false"/>
 <Reference Include="Microsoft.Build.Utilities.Core" HintPath="$(MSBuildToolsPath)/Microsoft.Build.Utilities.Core.dll" Private="false"/>
 </ItemGroup></Project>`);
 await fs.writeFile(path.join(probe,'Probe.cs'),`using System; using System.IO; using System.Reflection; using System.Text.Json;
 using Microsoft.Build.Evaluation; using Microsoft.Build.Evaluation.Context; using Microsoft.Build.Definition; using Microsoft.Build.FileSystem;
 public class Probe : Microsoft.Build.Utilities.Task {
 public string Analyzer {get;set;} public string Input {get;set;} public string Output {get;set;}
 public override bool Execute() {
 var type=Assembly.LoadFrom(Analyzer).GetType("Testy.Analysis.EvaluationInputs");
 MSBuildFileSystemBase Recorder() { var shared=Activator.CreateInstance(type.GetNestedType("Shared",BindingFlags.NonPublic),true); return (MSBuildFileSystemBase)Activator.CreateInstance(type,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic,null,new[]{shared},null); }
 var recorder=Recorder();
 using var collection=new ProjectCollection();
 var project=Project.FromFile(Input,new ProjectOptions {ProjectCollection=collection,EvaluationContext=EvaluationContext.Create(EvaluationContext.SharingPolicy.Shared,recorder)});
 var added=Path.Combine(Path.GetDirectoryName(Input),"obj",Path.GetFileName(Input)+".late.props");
 File.WriteAllText(added,"<Project><PropertyGroup><LateImport>true</LateImport></PropertyGroup></Project>");
 var snapshot=type.GetMethod("Complete",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(recorder,new[]{project});
 File.Delete(added); var stableRecorder=Recorder(); using var stableCollection=new ProjectCollection();
 var stableProject=Project.FromFile(Input,new ProjectOptions {ProjectCollection=stableCollection,EvaluationContext=EvaluationContext.Create(EvaluationContext.SharingPolicy.Shared,stableRecorder)});
 var stableSnapshot=type.GetMethod("Complete",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(stableRecorder,new[]{stableProject});
 var stable=(bool)stableSnapshot.GetType().GetProperty("reusable").GetValue(stableSnapshot);
 File.WriteAllText(Output,JsonSerializer.Serialize(new { raced=JsonSerializer.SerializeToElement(snapshot,snapshot.GetType()),stable }));return true;
 }} `);
 const {runProcess,requireSuccess}=require('../../out/services/process'),options={cwd:probe,timeoutMs:60000};
 requireSuccess(await runProcess('dotnet',['build',taskProject,'-o',taskOutput,'--nologo'],options),'Building evaluation race probe');
 await projects.restoreProjects('dotnet',[f.project],'Debug',{cwd:f.root},2);
 const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;'),query=path.join(probe,'query.proj');
 await fs.writeFile(query,`<Project><UsingTask TaskName="Probe" AssemblyFile="${xml(path.join(taskOutput,'Probe.dll'))}"/><Target Name="Inspect"><Probe Analyzer="${xml(path.resolve('dist/analyzer/Testy.Analysis.dll'))}" Input="${xml(f.project)}" Output="${xml(result)}"/></Target></Project>`);
 requireSuccess(await runProcess('dotnet',['msbuild',query,'-target:Inspect','-nologo'],options),'Checking evaluation race');
 const {raced:snapshot,stable}=JSON.parse(await fs.readFile(result,'utf8'));
 assert.equal(stable,true,'the same ordinary MSTest graph is reusable when no concurrent import change occurs');
 assert.ok(snapshot.queries.some(query=>query.kind==='imports'&&query.values.some(file=>file.endsWith('.late.props'))),'probe deterministically adds the matching file after Project.FromFile');
 assert.equal(snapshot.reusable,false,'current directory contents must not validate a graph that never imported the new file');
});
