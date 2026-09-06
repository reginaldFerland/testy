const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const {TestEngine}=require('../../out/services/engine');
const {CoverageStore}=require('../../out/core/coverage');
const {ProjectIndex}=require('../../out/core/selection');
const {normalizePath}=require('../../out/core/paths');

async function main() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy scale '));
 const fileCount=Number(process.env.TESTY_BENCH_FILES||60), cases=20;
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:120000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 let peakHeap=0,peakRss=0,prepared=0;
 const sample=setInterval(()=>{const memory=process.memoryUsage();peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);},20);
 try {
  const workspace=path.join(root,'workspace'), library=path.join(workspace,'Library');await fs.mkdir(library,{recursive:true});
  await fs.writeFile(path.join(library,'Library.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
  await fs.writeFile(path.join(library,'Shared.cs'),'namespace Scale; public static class Shared { public static int Offset(int value) => value + 1; }');
  for(let project=0;project<3;project++) {
   const directory=path.join(workspace,`Tests${project}`);await fs.mkdir(directory);
   await fs.writeFile(path.join(directory,`Tests${project}.csproj`),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Library/Library.csproj"/></ItemGroup></Project>');
  }
  for(let i=0;i<fileCount;i++) {
   await fs.writeFile(path.join(library,`Feature${i}.cs`),`namespace Scale; public static class Feature${i} { public static int Value(int value) { return Shared.Offset(value) + ${i}; } }`);
   const rows=Array.from({length:cases},(_,n)=>`[DataRow(${n})]`).join('');
   await fs.writeFile(path.join(workspace,`Tests${i%3}`,`Feature${i}Tests.cs`),`using Scale; using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature${i}Tests { [TestMethod]${rows} public void Value(int value) { Assert.AreEqual(value + 1 + ${i}, Feature${i}.Value(value)); } }`);
  }
  const engine=new TestEngine({roots:[workspace],storage:path.join(root,'state'),tools:path.join(root,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
   events:{output:()=>{},phase:()=>{},discovered:()=>{},selected:()=>{},result:()=>{},started:()=>{},coverage:()=>{},invalidated:()=>{},prepared:()=>prepared++}});
  const signal=new AbortController().signal;
  const baseline=await engine.run({files:[],full:true},signal);assert.equal(baseline.passed,fileCount*cases);assert.equal(prepared,3);
  const source=normalizePath(path.join(library,'Feature0.cs'));await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('Shared.Offset(value) + 0','Shared.Offset(value) + 1'));
  const save=engine.cache.save.bind(engine.cache),writtenTraces=[];
  engine.cache.save=async(delta,...args)=>{writtenTraces.push(...delta.traces.map(trace=>trace.groupId));return save(delta,...args);};
  await engine.markChanged([source]);
  const affected=await engine.run({files:[source],full:false},signal);assert.equal(affected.tests,cases);assert.equal(affected.failed,cases);
  const affectedTraceWrites=writtenTraces.length;assert.equal(affectedTraceWrites,1);engine.cache.save=save;
  const aggregates=engine.coverage.summarize(engine.hashes);let start=performance.now();
  for(let i=0;i<10000;i++) assert.equal(engine.coverage.summarize(engine.hashes),aggregates);
  const cachedAggregateMicroseconds=(performance.now()-start)*1000/10000;
  let cacheBytes=0;async function size(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory()) await size(file);else cacheBytes+=(await fs.stat(file)).size;}}
  await size(path.join(root,'state','coverage-v2'));
  config.mode='all';prepared=0;
  const all=await engine.run({files:[],full:true},signal);assert.equal(all.tests,fileCount*cases);assert.equal(prepared,3);
  console.log(JSON.stringify({kind:'real-mtp',platform:process.platform,architecture:process.arch,projects:4,testFiles:fileCount,cases:fileCount*cases,baselineMs:baseline.duration,affectedMs:affected.duration,affectedCases:affected.tests,affectedTraceWrites,runAllMs:all.duration,cacheBytes,cachedAggregateMicroseconds,peakNodeHeapMiB:peakHeap/1048576,peakNodeRssMiB:peakRss/1048576}));
 } finally {clearInterval(sample);await fs.rm(root,{recursive:true,force:true});}

 const store=new CoverageStore(), hashes=new Map(), ids=new Set(Array.from({length:100},(_,i)=>`test${i}`));
 for(let i=0;i<200;i++) hashes.set(`/source${i}.cs`,'v1');
 for(let test=0;test<100;test++) {
  const coverage=[...hashes].map(([file,hash],source)=>({file,hash,lines:Array.from({length:100},(_,line)=>({line:line+1,hits:source===test*2 && line<10 ? 1:0}))}));
  store.replace([{groupId:`test${test}`,dependencies:[`/source${test*2}.cs`],coverage,reliable:true,timestamp:1}],ids);
 }
 let start=performance.now();store.summarize(hashes);const firstAggregateMs=performance.now()-start;
 start=performance.now();const packed=JSON.stringify(store.takeDelta());const serializeMs=performance.now()-start;
 const projects=Array.from({length:20},(_,i)=>({file:`/p${i}/p.csproj`,sourceFiles:Array.from({length:250},(_,n)=>`/p${i}/f${n}.cs`),references:[]}));
 const index=new ProjectIndex(projects);start=performance.now();for(let i=0;i<10000;i++) index.affected(['/p10/f100.cs']);const indexedLookupMicroseconds=(performance.now()-start)*1000/10000;
 console.log(JSON.stringify({kind:'synthetic',equivalentDenseLines:2000000,firstAggregateMs,serializeMs,packedBytes:Buffer.byteLength(packed),indexedLookupMicroseconds}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
