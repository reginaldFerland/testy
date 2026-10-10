// Shared fixtures of the regression suites (test/integration/regression*.test.cjs).
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {TestEngine}=require('../../../out/services/engine');
const {normalizePath}=require('../../../out/core/paths');
const {loadUi}=require('../../unit/support/ui.cjs');

/** @typedef {import('../../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../../out/core/model').TestResult} TestResult */
/** @typedef {{-readonly [K in keyof import('../../../out/core/model').EngineConfiguration]: import('../../../out/core/model').EngineConfiguration[K]}} MutableConfiguration */
/** @typedef {{selected: string[], results: (TestResult & {file?: string})[], prepared: number, started: (group: TestFile, id: string) => void, inputsChanged: () => void, output: string[]}} FixtureState */

/** @typedef {import('../../../out/services/mtp').TestNode} TestNode */
/** Narrows a value the test has already established as present; it checks nothing at runtime. @template T @param {T} value @returns {NonNullable<T>} */
const defined=value=>/** @type {NonNullable<T>} */ (value);

/** @param {import('node:test').TestContext} t @param {string} [demo] */
async function fixture(t,demo='ImpactDemo') {
 // Runs flush their coverage saves in the background; let them settle before deleting the storage they write to.
 /** @type {() => Promise<void>} */ let settle=async()=>{};
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy regression '));t.after(async()=>{await settle();await fs.rm(temp,{recursive:true,force:true});});
 const root=path.join(temp,'workspace');
 await fs.cp(path.resolve('test/fixtures',demo),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {MutableConfiguration} */ const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 /** @type {FixtureState} */ const state={selected:[],results:[],prepared:0,started:()=>{},inputsChanged:()=>{},output:[]};
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
  output:text=>state.output.push(text),phase:()=>{},inputsChanged:()=>state.inputsChanged(),discovered:()=>{},selected:s=>state.selected=s.groups.map(group=>path.basename(group.file||group.project)),
  result:(group,result)=>state.results.push({file:group.file,...result}),started:(group,id)=>state.started(group,id),coverage:()=>{},invalidated:()=>{},prepared:()=>state.prepared++
 }});
 settle=()=>/** @type {any} */ (engine).flushSaves();
 // `internal` is the same engine seen through any: the tests reach private members (cache, saves) and replace methods.
 return {root,temp,config,state,engine,internal:/** @type {any} */ (engine),file:(/** @type {string} */ relative)=>normalizePath(path.join(root,relative)),run:(/** @type {string[]} */ files=[],full=false,/** @type {import('../../../out/services/engine').ManualSelection | undefined} */ manual=undefined)=>engine.run({files,full},new AbortController().signal,manual)};
}

/** @param {import('node:test').TestContext} t */
async function parallelFixture(t){
 const f=await fixture(t);f.config.maxParallelProjects=2;f.config.maxParallelTestFiles=2;
 for(const [index,layer] of ['App','Infra','Web'].entries()){
  const previous=['ImpactDemo','App','Infra'][index];await fs.mkdir(f.file(layer));
  await fs.writeFile(f.file(`${layer}/${layer}.csproj`),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../${previous}/${previous}.csproj"/></ItemGroup></Project>`);
  if(layer!=='Web')await fs.writeFile(f.file(`${layer}/Pipeline.cs`),`namespace ${layer}; public static class Pipeline { public static int Value(int value) => ${index?'App.Pipeline.Value(value)':'ImpactDemo.Arithmetic.Sum(value,1)'}; }`);
 }
 const project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('../ImpactDemo/ImpactDemo.csproj','../Web/Web.csproj'));
 await fs.rm(f.file('ImpactDemo.Tests/CalculatorTests.cs'));await fs.rm(f.file('ImpactDemo.Tests/GreetingTests.cs'));
 for(let index=0;index<6;index++){
  await fs.writeFile(f.file(`Web/Feature${index}.cs`),`namespace Web; public static class Feature${index} { public static int Value(int value) => Infra.Pipeline.Value(value) + ${index}; }`);
  await fs.writeFile(f.file(`ImpactDemo.Tests/Feature${index}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature${index}Tests { [TestMethod] public void Value() { var marker=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(typeof(Feature${index}Tests).Assembly.Location)!,"worker-marker.txt"); System.IO.File.WriteAllText(marker,"${index}"); System.Threading.Thread.Sleep(40); Assert.AreEqual("${index}",System.IO.File.ReadAllText(marker)); Assert.AreEqual(${index+2},Web.Feature${index}.Value(1)); } }`);
 }
 return f;
}


/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} [trigger] */
async function editorInputs(f,trigger='fileSystem') {
 const exports=/** @type {{ui: ReturnType<typeof loadUi>}} */ ({}),/** @type {{base: string, pattern: string}[]} */ patterns=[],/** @type {[string[], ...unknown[]][]} */ requests=[];
 const vscode={RelativePattern:class {constructor(/** @type {string} */ base,/** @type {string} */ pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher:(/** @type {{base: string, pattern: string}} */ pattern)=>{
  patterns.push(pattern);return {dispose(){},onDidChange(){},onDidCreate(){},onDidDelete(){}};
 }}};
 exports.ui=loadUi({vscode});
 const ui={roots:[normalizePath(f.root)],watchers:[],engine:f.engine,scheduler:{request:(/** @type {[string[], ...unknown[]]} */ ...args)=>requests.push(args)},queueChanged:(/** @type {string[]} */ files)=>f.engine.markChanged(files),
  config:{trigger,excludes:[],pattern:require('../../../package.json').contributes.configuration.properties['testy.fileWatcherPattern'].default}};
 const watch=()=>exports.ui.changeWatcher(ui).watch();f.state.inputsChanged=watch;watch();
 return {patterns,requests,changed:(/** @type {string} */ file)=>exports.ui.changeWatcher(ui).changed({scheme:'file',fsPath:file})};
}

module.exports={defined,fixture,parallelFixture,editorInputs};
