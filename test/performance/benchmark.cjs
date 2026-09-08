// Defaults: two layouts, 240 files, 20 cases/file, three alternating serial/auto pairs.
// Smoke: TESTY_BENCH_FILES=8 TESTY_BENCH_CASES=2 TESTY_BENCH_TRIALS=1 TESTY_BENCH_LAYOUTS=multiple npm run benchmark
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {performance}=require('node:perf_hooks'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {TestEngine}=require('../../out/services/engine');
const {CoverageStore}=require('../../out/core/coverage'),{ProjectIndex}=require('../../out/core/selection');
const {normalizePath}=require('../../out/core/paths'),{resolveConcurrency}=require('../../out/core/concurrency');
const projects=require('../../out/services/projects'),mtp=require('../../out/services/mtp'),processes=require('../../out/services/process');
const {installCoverageTool}=require('../../out/services/coverageTool');
const execute=promisify(execFile);

function integer(name,fallback){const value=Number(process.env[name]??fallback);assert.ok(Number.isSafeInteger(value)&&value>0,`${name} must be a positive integer`);return value;}
const fileCount=integer('TESTY_BENCH_FILES',240),cases=integer('TESTY_BENCH_CASES',20),trials=integer('TESTY_BENCH_TRIALS',3);
const layouts=(process.env.TESTY_BENCH_LAYOUTS||'multiple,single').split(',');
assert.ok(layouts.length&&layouts.every(layout=>['multiple','single'].includes(layout)),'TESTY_BENCH_LAYOUTS must contain multiple and/or single');
const automatic=resolveConcurrency();

async function createWorkspace(workspace,projectCount){
 const layers=['Core','App','Infra','Web'];
 for(const [index,layer] of layers.entries()){
  const directory=path.join(workspace,layer);await fs.mkdir(directory,{recursive:true});
  const reference=index?`<ItemGroup><ProjectReference Include="../${layers[index-1]}/${layers[index-1]}.csproj"/></ItemGroup>`:'';
  await fs.writeFile(path.join(directory,`${layer}.csproj`),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${reference}</Project>`);
  for(let file=0;file<fileCount;file++){
   const value=index?`Scale.${layers[index-1]}.Feature${file}.Value(value)`:`Shared.Offset(value) + ${file}`;
   await fs.writeFile(path.join(directory,`Feature${file}.cs`),`namespace Scale.${layer}; public static class Feature${file} { public static int Value(int value) => ${value}; }`);
  }
 }
 await fs.writeFile(path.join(workspace,'Core','Shared.cs'),'namespace Scale.Core; public static class Shared { public static int Offset(int value) => value + 1; }');
 for(let project=0;project<projectCount;project++){
  const directory=path.join(workspace,`Tests${project}`);await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,`Tests${project}.csproj`),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Web/Web.csproj"/></ItemGroup></Project>');
 }
 const rows=Array.from({length:cases},(_,value)=>`[DataRow(${value})]`).join('');
 for(let file=0;file<fileCount;file++)await fs.writeFile(path.join(workspace,`Tests${file%projectCount}`,`Feature${file}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class Feature${file}Tests { [TestMethod]${rows} public void Value(int value) { Assert.AreEqual(value + 1 + ${file}, Scale.Web.Feature${file}.Value(value)); } }`);
}

// Wrap actual process boundaries, avoiding double counting runner worker delegation.
function workProbe(){
 const active={evaluation:0,restore:0,build:0,discovery:0,test:0},peak={...active},slots={...active},peakWorkerBudgets={...active},originals=[];
 const batches={evaluation:0,restore:0,build:0};
 for(const [name,kind] of [['evaluateProjects','evaluation'],['restoreProjects','restore'],['buildProjects','build']]){
  const original=projects[name];originals.push(()=>projects[name]=original);projects[name]=function(...args){batches[kind]++;return original.apply(this,args);};
 }
 function wrap(object,key,classify){const original=object[key];originals.push(()=>object[key]=original);object[key]=async function(...args){
  const operation=classify(args);if(!operation)return original.apply(this,args);const [kind,budget]=operation;
  peak[kind]=Math.max(peak[kind],++active[kind]);slots[kind]+=budget;peakWorkerBudgets[kind]=Math.max(peakWorkerBudgets[kind],slots[kind]);
  try{return await original.apply(this,args);}finally{active[kind]--;slots[kind]-=budget;}
 };}
 wrap(processes,'runProcess',args=>{
  const kind=args[1].includes('-target:Inspect')?'evaluation':args[1].includes('-target:Restore')?'restore':args[1].includes('-target:Build')?'build':undefined;
  return kind?[kind,Number(args[1].find(value=>value.startsWith('-maxcpucount:'))?.split(':')[1]||1)]:undefined;
 });
 wrap(mtp,'requestTests',args=>[args[1]==='discover'?'discovery':'test',1]);
 return{peak,peakWorkerBudgets,batches,restore(){originals.reverse().forEach(restore=>restore());assert.ok(Object.values(active).every(value=>value===0),'all workers settle before cleanup');}};
}

function resources(){
 let peakHeap=0,peakRss=0,peakTreeRss=0,last=performance.now(),maxTimerGapMs=0,pending;
 const sample=setInterval(()=>{const now=performance.now(),memory=process.memoryUsage();maxTimerGapMs=Math.max(maxTimerGapMs,now-last);last=now;peakHeap=Math.max(peakHeap,memory.heapUsed);peakRss=Math.max(peakRss,memory.rss);},20);
 const tree=setInterval(()=>{
  if(process.platform==='win32'||pending)return;
  pending=execute('ps',['-axo','pid=,ppid=,rss=']).then(({stdout})=>{
   const rows=stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),children=new Set([process.pid]);
   let changed=true;while(changed){changed=false;for(const [pid,parent] of rows)if(children.has(parent)&&!children.has(pid)){children.add(pid);changed=true;}}
   peakTreeRss=Math.max(peakTreeRss,rows.filter(([pid])=>children.has(pid)).reduce((sum,row)=>sum+row[2],0)*1024);
  }).catch(()=>{}).finally(()=>pending=undefined);
 },500);
 return async()=>{clearInterval(sample);clearInterval(tree);await pending;return{maxTimerGapMs,peakNodeHeapMiB:peakHeap/1048576,peakNodeRssMiB:peakRss/1048576,peakParentAndDescendantRssMiB:peakTreeRss?peakTreeRss/1048576:null};};
}

async function fingerprint(engine,workspace){
 workspace=normalizePath(workspace);
 const relative=file=>path.relative(workspace,file).replaceAll('\\','/'),hash=createHash('sha256');
 for(const group of [...engine.groups].sort((a,b)=>relative(a.file).localeCompare(relative(b.file)))){
  const trace=engine.coverage.traces.get(group.id);assert.ok(trace?.reliable,`${relative(group.file)} has a reliable per-file trace`);
  const dependencies=trace.dependencies.filter(file=>file.startsWith(workspace+'/')).map(relative).sort();
  for(const layer of ['Core','App','Infra','Web'])assert.ok(dependencies.some(file=>file.startsWith(layer+'/')),`${relative(group.file)} records ${layer} callers`);
  hash.update(JSON.stringify({file:relative(group.file),framework:group.framework,tests:group.tests.map(test=>test.name).sort(),dependencies,
   coverage:trace.coverage.map(source=>({file:relative(source.file),lines:source.lines.map(line=>[line.line,line.hits])})).sort((a,b)=>a.file.localeCompare(b.file))}));
  await new Promise(resolve=>setImmediate(resolve));
 }
 return hash.digest('hex');
}

async function runTrial(directory,template,coverageTool,layout,projectCount,trial,mode){
 const workspace=path.join(directory,'workspace');await fs.cp(template,workspace,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:120000,coverageTool,
  maxParallelProjects:mode==='serial'?1:0,maxParallelTestFiles:mode==='serial'?1:0};
 let prepared=0,firstDiscoveryMs,firstResultMs,started,phaseTimings={},currentPhase='Preparing benchmark';
 const progress=setInterval(()=>console.error(`Benchmark ${layout} pair ${trial}/${trials} ${mode}: ${currentPhase}`),30000);
 const probe=workProbe(),finishResources=resources();
 try{
  const engine=new TestEngine({roots:[workspace],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
   events:{output:text=>{const timing=/Testy timing: (.+) ([\d.]+)ms/.exec(text);if(timing)phaseTimings[timing[1]]=Number(timing[2]);},phase:message=>currentPhase=message,
    discovered:groups=>{if(groups.length)firstDiscoveryMs??=performance.now()-started;},selected:()=>{},result:()=>firstResultMs??=performance.now()-started,
    started:()=>{},coverage:()=>{},invalidated:()=>{},prepared:()=>prepared++}});
  const signal=new AbortController().signal;started=performance.now();
  const baseline=await engine.run({files:[],full:true},signal),baselinePhases=phaseTimings;phaseTimings={};
  assert.equal(baseline.passed,fileCount*cases);assert.equal(baseline.failed,0);assert.equal(prepared,projectCount);assert.equal(engine.coverage.traces.size,fileCount);
  const baselineFingerprint=await fingerprint(engine,workspace),baselinePeak={...probe.peak},baselinePeakWorkerBudgets={...probe.peakWorkerBudgets},baselineBatches={...probe.batches};
  const limit=mode==='serial'?1:automatic;
  for(const [kind,value] of Object.entries(baselinePeak))assert.ok(value<=limit,`${kind} peak ${value} exceeds ${limit}`);
  for(const [kind,value] of Object.entries(baselinePeakWorkerBudgets))assert.ok(value<=limit,`${kind} worker budget ${value} exceeds ${limit}`);
  for(const kind of ['evaluation','restore','build'])assert.ok(baselineBatches[kind]>0&&baselinePeak[kind]>0,`${kind} executes a measured batch`);
  if(limit>1&&fileCount>1)assert.ok(baselinePeak.test>1,'file execution overlaps, including within one project');
  if(limit>1&&projectCount>1)assert.ok(baselinePeak.discovery>1,'independent target discovery overlaps');
  const source=normalizePath(path.join(workspace,'Web','Feature0.cs'));await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('Scale.Infra.Feature0.Value(value)','Scale.Infra.Feature0.Value(value) + 1'));
  const save=engine.cache.save.bind(engine.cache),writtenTraces=[];
  engine.cache.save=async(delta,...args)=>{writtenTraces.push(...delta.traces.map(trace=>trace.groupId));return save(delta,...args);};
  await engine.markChanged([source]);const affected=await engine.run({files:[source],full:false},signal),affectedPhases=phaseTimings;phaseTimings={};
  assert.equal(affected.tests,cases);assert.equal(affected.failed,cases);assert.equal(writtenTraces.length,1);engine.cache.save=save;
  const aggregates=engine.coverage.summarize(engine.hashes);let start=performance.now();
  for(let i=0;i<10000;i++)assert.equal(engine.coverage.summarize(engine.hashes),aggregates);
  const cachedAggregateMicroseconds=(performance.now()-start)*1000/10000;
  let cacheBytes=0;async function size(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await size(file);else cacheBytes+=(await fs.stat(file)).size;}}
  await size(path.join(directory,'state','coverage-v2'));
  const shared=normalizePath(path.join(workspace,'Core','Shared.cs'));await fs.writeFile(shared,(await fs.readFile(shared,'utf8')).replace('value + 1','value + 2'));
  await engine.markChanged([shared]);const sharedCore=engine.select([shared]),sharedCoreSelectedCases=sharedCore.groups.reduce((count,group)=>count+group.tests.length,0);
  assert.equal(sharedCore.groups.length,fileCount,'a shared Core edit selects callers through all four production layers');
  assert.equal(sharedCoreSelectedCases,fileCount*cases);
  config.mode='all';prepared=0;const all=await engine.run({files:[],full:true},signal);
  assert.equal(all.tests,fileCount*cases);assert.equal(all.failed,fileCount*cases);assert.equal(prepared,projectCount);
  assert.deepEqual(await fs.readdir(path.join(directory,'state','runs')),[],'private output is reclaimed');
  const measurements=await finishResources();
  const result={kind:'real-mtp',platform:process.platform,architecture:process.arch,availableCpus:os.availableParallelism(),layout,trial,concurrencyMode:mode,concurrency:limit,
   projects:4+projectCount,testFiles:fileCount,cases:fileCount*cases,baselineMs:baseline.duration,firstDiscoveryMs,firstResultMs,baselinePhases,baselinePeak,baselinePeakWorkerBudgets,baselineBatches,
   affectedMs:affected.duration,affectedPhases,affectedCases:affected.tests,affectedTraceWrites:writtenTraces.length,
   sharedCoreSelectedCases,runAllMs:all.duration,runAllPhases:phaseTimings,
   cacheBytes,cachedAggregateMicroseconds,baselineFingerprint,...measurements};
  console.log(JSON.stringify(result));return result;
 }finally{clearInterval(progress);probe.restore();await finishResources();}
}

async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy scale '));
 try{
  // Exclude first-use NuGet and collector downloads from the paired measurements.
  const coverageTool=process.env.TESTY_COVERAGE_TOOL||await installCoverageTool('dotnet',path.join(root,'tools'),{cwd:root});
  for(const layout of layouts){
   const projectCount=layout==='single'?1:Math.min(4,fileCount),template=path.join(root,layout,'template');await createWorkspace(template,projectCount);
   for(let project=0;project<projectCount;project++)processes.requireSuccess(await processes.runProcess('dotnet',['restore',path.join(template,`Tests${project}`,`Tests${project}.csproj`),'--nologo'],{cwd:template}), 'Warming package restore');
   const pairs=[];
   for(let trial=1;trial<=trials;trial++){
    const pair={};
    for(const mode of trial%2?['serial','auto']:['auto','serial']){
     const directory=path.join(root,layout,`${trial}-${mode}`);pair[mode]=await runTrial(directory,template,coverageTool,layout,projectCount,trial,mode);await fs.rm(directory,{recursive:true,force:true});
    }
    assert.equal(pair.auto.baselineFingerprint,pair.serial.baselineFingerprint,'parallel and serial inventories, coverage and dependency attribution agree');
    pairs.push(pair);
   }
   const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
   const serialBaselineMs=median(pairs.map(pair=>pair.serial.baselineMs)),autoBaselineMs=median(pairs.map(pair=>pair.auto.baselineMs));
   const measurements=['baselineMs','firstDiscoveryMs','firstResultMs','affectedMs','runAllMs','peakNodeHeapMiB','peakNodeRssMiB','peakParentAndDescendantRssMiB','maxTimerGapMs'];
   const summarize=mode=>({...Object.fromEntries(measurements.map(key=>[key,pairs.every(pair=>pair[mode][key]!==null)?median(pairs.map(pair=>pair[mode][key])):null])),
    baselinePhases:Object.fromEntries(Object.keys(pairs[0][mode].baselinePhases).map(key=>[key,median(pairs.map(pair=>pair[mode].baselinePhases[key]))]))});
   console.log(JSON.stringify({kind:'comparison',layout,trials,serialBaselineMs,autoBaselineMs,speedup:serialBaselineMs/autoBaselineMs,medianSerial:summarize('serial'),medianAuto:summarize('auto'),timingAssertion:false}));
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
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
