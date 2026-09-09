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
 const state={selected:[],results:[],prepared:0,started:()=>{},inputsChanged:()=>{},output:[]};
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
  output:text=>state.output.push(text),phase:()=>{},inputsChanged:()=>state.inputsChanged(),discovered:()=>{},selected:s=>state.selected=s.groups.map(group=>path.basename(group.file||group.project)),
  result:(group,result)=>state.results.push({file:group.file,...result}),started:(...args)=>state.started(...args),coverage:()=>{},invalidated:()=>{},prepared:()=>state.prepared++
 }});
 return {root,temp,config,state,engine,file:relative=>normalizePath(path.join(root,relative)),run:(files=[],full=false,manual)=>engine.run({files,full},new AbortController().signal,manual)};
}

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

test('parallel files in one target keep private output and coverage attribution through a deep build graph',{timeout:180000},async t=>{
 const f=await parallelFixture(t),mtp=require('../../out/services/mtp'),request=mtp.requestTests;
 let active=0,peak=0;
 mtp.requestTests=async(...args)=>{
  if(args[1]!=='run')return request(...args);
  peak=Math.max(peak,++active);try{return await request(...args);}finally{active--;}
 };
 try{
  const baseline=await f.run([],true);assert.equal(baseline.passed,6);assert.equal(baseline.failed,0);assert.equal(peak,2);assert.equal(active,0);
  assert.equal(f.state.prepared,1,'worker copies do not repeat primary target preparation events');
  assert.equal(f.engine.coverage.traces.size,6);
  const shared=f.file('ImpactDemo/Arithmetic.cs');
  for(const group of f.engine.groups){
   const trace=f.engine.coverage.traces.get(group.id);assert.equal(trace.reliable,true);assert.ok(trace.dependencies.includes(shared));
   const index=/Feature(\d+)Tests/.exec(group.file)[1];assert.ok(trace.dependencies.includes(f.file(`Web/Feature${index}.cs`)));
   assert.equal(trace.dependencies.filter(file=>/\/Web\/Feature\d+\.cs$/.test(file)).length,1,'concurrent collectors retain individual file ownership');
  }
  const source=f.file('Web/Feature0.cs');await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace(' + 0',' + 1'));
  const affected=await f.run([source]);assert.equal(affected.tests,1);assert.equal(affected.failed,1);assert.deepEqual(f.state.selected,['Feature0Tests.cs']);
  await fs.writeFile(shared,(await fs.readFile(shared,'utf8')).replace('a + b','a + b + 1'));
  const callers=await f.run([shared]);assert.equal(callers.tests,6);assert.equal(callers.failed,6);
  assert.deepEqual(await fs.readdir(path.join(f.temp,'state/runs')),[],'all private worker outputs are removed');
 }finally{mtp.requestTests=request;}
});

test('parallel cancellation drains active work and resumes only files without completed checkpoints',{timeout:180000},async t=>{
 const f=await parallelFixture(t),mtp=require('../../out/services/mtp'),request=mtp.requestTests,save=f.engine.cache.save.bind(f.engine.cache),abort=new AbortController();
 let admitted=0,active=0,peak=0,release,timeout;const bothAdmitted=new Promise(resolve=>release=resolve);
 t.after(()=>clearTimeout(timeout));
 mtp.requestTests=async(...args)=>{
  if(args[1]!=='run')return request(...args);
  peak=Math.max(peak,++active);const index=admitted++;
  timeout??=setTimeout(()=>abort.abort(),60000);
  try{
   const signal=args[0].signal;signal.throwIfAborted();
   let interrupted;
   const cancelled=new Promise((resolve,reject)=>{interrupted=()=>reject(Object.assign(new Error('Controlled cancellation'),{name:'AbortError'}));signal.addEventListener('abort',interrupted,{once:true});});
   try{
    if(index===0){await Promise.race([bothAdmitted,cancelled]);return await request(...args);}
    release();await cancelled;
   }finally{signal.removeEventListener('abort',interrupted);}
  }finally{active--;}
 };
 f.engine.cache.save=async(delta,signal)=>{await save(delta,signal);if(delta.traces.length)abort.abort();};
 try{
  await assert.rejects(f.engine.run({files:[],full:true,generation:902},abort.signal),{name:'AbortError'});
  assert.equal(peak,2);assert.equal(active,0);assert.equal(admitted,2,'no later batches start after cancellation');
  assert.deepEqual(f.engine.baselineProgress,{completed:1,total:6});assert.equal(f.engine.coverage.traces.size,1);
 }finally{clearTimeout(timeout);mtp.requestTests=request;f.engine.cache.save=save;}
 const completed=[...f.engine.coverage.traces.values()][0],resumed=await f.engine.run({files:[],full:true,generation:902},new AbortController().signal);
 assert.equal(resumed.files,5);assert.equal(resumed.passed,5);assert.equal(f.engine.coverage.traces.get(completed.groupId).timestamp,completed.timestamp);
 assert.equal(f.engine.coverage.traces.size,6);assert.equal(f.engine.baselineProgress,undefined);assert.deepEqual(await fs.readdir(path.join(f.temp,'state/runs')),[]);
});

test('failed discovery preserves the previous inventory and collected coverage, then recovers',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp');
 assert.equal((await f.run([],true)).coverageAvailable,true);
 const groups=f.engine.groups,traces=new Map(f.engine.coverage.traces),original=mtp.requestTests;
 assert.ok([...traces.values()].some(trace=>trace.coverage.length));
 try{
  for(const code of [0,2]){
   mtp.requestTests=(options,operation,tests)=>operation==='discover'?original({dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),
    cwd:f.root,timeoutMs:5000,env:{TESTY_EXIT:String(code),TESTY_UPDATES:JSON.stringify([{uid:'suite','node-type':'group','execution-state':'error','error.message':'controlled discovery failure'}])}},'discover'):original(options,operation,tests);
   await assert.rejects(f.run([],true),/failed/);
   assert.equal(f.engine.groups,groups);assert.deepEqual(new Map(f.engine.coverage.traces),traces);
   assert.ok(f.engine.baselineProgress,'failed refresh must leave its baseline unfinished');
  }
 }finally{mtp.requestTests=original;}
 assert.equal((await f.run([],true)).passed,3);assert.equal(f.engine.baselineProgress,undefined);
});

test('unmapped runtime rows survive rediscovery, honor project exclusions and move to an identified file',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp');f.config.coverage=false;
 const original=mtp.requestTests,sent=[];
 try{
  mtp.requestTests=(options,operation,tests)=>{
   if(operation==='discover')return original(options,operation,tests);
   const nodes=tests??options.expectedTests;sent.push(nodes);
   return original({...options,dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:f.root,wrapper:undefined,
    env:{TESTY_UPDATES:JSON.stringify([...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'unmapped-row','display-name':'Runtime row','execution-state':'failed'}])}},operation,tests);
  };
  await f.run([],true);
  const unknown=f.engine.displayGroups.find(group=>group.runtimeOnly);assert.ok(unknown);assert.equal(unknown.file,undefined);
  const rerun=await f.run([],false,{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['unmapped-row'])]])});
  assert.equal(rerun.files,2,'the summary counts the actual project files executed by fallback');
  const greeting=f.engine.groups.find(group=>group.file.endsWith('GreetingTests.cs'));
  await f.run([],false,{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['unmapped-row'])]]),exclude:{groups:new Set([greeting.id])}});
  assert.ok(sent[2].every(node=>!String(node['location.file']).endsWith('GreetingTests.cs')));
  assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),false,'the single-file run identifies the row and removes its project placeholder');
  const calculator=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
  assert.ok(f.engine.knownTests(calculator).some(test=>test.id==='unmapped-row'));
 }finally{mtp.requestTests=original;}
});

test('real collector cleans detached children after completion, cancellation and host death',{timeout:90000,skip:process.platform==='win32'},async t=>{
 const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises'),{once}=require('node:events');
 const f=await fixture(t),marker=path.join(f.temp,'owned-pids.json'),launcher=path.join(f.temp,'launch.cjs');
 const pids=new Set();t.after(()=>{for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}});
 await fs.writeFile(launcher,`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.ppid,c.pid]));c.unref();`);
 const literal=value=>'@"'+value.replaceAll('"','""')+'"';
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 for(const mode of ['completion','cancellation','host-death']){
  await fs.rm(marker,{force:true});
  await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class CalculatorTests { [TestMethod] public void Launch() { var p=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(${literal(process.execPath)}) { ArgumentList = { ${literal(launcher)} }, UseShellExecute=false }); p!.WaitForExit(); ${mode==='completion'?'':'System.Threading.Thread.Sleep(60000);'} } }`);
  const abort=new AbortController();let host,pending,exit;
  if(mode==='host-death'){
   const script=`const {TestEngine}=require(${JSON.stringify(path.resolve('out/services/engine'))});const engine=new TestEngine({roots:[${JSON.stringify(f.root)}],storage:${JSON.stringify(path.join(f.temp,'crash-state'))},tools:${JSON.stringify(path.join(f.temp,'tools'))},analyzer:${JSON.stringify(path.resolve('dist/analyzer/Testy.Analysis.dll'))},configuration:()=>(${JSON.stringify(f.config)}),events:{output(){},phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});engine.run({files:[],full:true},new AbortController().signal).catch(()=>process.exitCode=1);`;
   host=spawn(process.execPath,['-e',script],{stdio:'ignore'});pids.add(host.pid);exit=once(host,'exit');
  }else{pending=f.engine.run({files:[],full:true},abort.signal);void pending.catch(()=>{});}
  try{
   let owned;for(let i=0;i<1200;i++){try{owned=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{await delay(25);}}
   assert.ok(owned,`${mode}: test must start`);owned.forEach(pid=>pids.add(pid));
   if(mode==='cancellation'){await delay(100);abort.abort();await assert.rejects(pending,{name:'AbortError'});}
   else if(mode==='host-death'){host.kill('SIGKILL');await exit;}
   else{assert.equal((await pending).coverageAvailable,true);}
   // Allow exited orphan processes to be reaped; none may still be running.
   for(let i=0;i<200&&owned.some(alive);i++){await delay(10);}
   const remaining=owned.filter(alive),states=remaining.map(pid=>{try{return require('node:child_process').execFileSync('ps',['-p',String(pid),'-o','pid=,ppid=,stat=,comm='],{encoding:'utf8'}).trim();}catch{return 'exited';}});
   assert.deepEqual(remaining,[],`${mode}: all owned processes must exit (${states.join('; ')})`);
  }finally{abort.abort();await pending?.catch(()=>{});if(host&&host.exitCode===null&&host.signalCode===null){host.kill('SIGKILL');await exit;}}
 }
});

test('shared target output paths preserve each framework through discovery and batching',{timeout:180000},async t=>{
 const f=await fixture(t), project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'), greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('<TargetFramework>net10.0</TargetFramework>',
  '<TargetFrameworks>net10.0;net10.0-windows</TargetFrameworks><AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>'));
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);',
  'Assert.AreEqual(3, Arithmetic.Expected);\n#if WINDOWS\nAssert.Fail("Windows-specific failure");\n#endif\n'));
 for(const [mode,coverage] of [['affected',true],['all',true],['affected',false]]) {
  f.config.mode=mode;f.config.coverage=coverage;f.state.results=[];
  const result=await f.run([],true);
  assert.equal(result.tests,6);assert.equal(result.passed,5);assert.equal(result.failed,1,`${mode}, coverage=${coverage}`);
  assert.equal(f.engine.groups.length,4);assert.equal(f.state.prepared%2,0);
  assert.deepEqual(await fs.readdir(path.join(f.temp,'state/runs')),[],'normal completion removes snapshots and owner metadata');
 }
});

test('referenced test contexts cannot overwrite the workspace entry-point binary',{timeout:180000},async t=>{
 const f=await fixture(t),project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',
  '<PropertyGroup Condition="\'$(Referenced)\' == \'true\'"><DefineConstants>$(DefineConstants);REFERENCED</DefineConstants></PropertyGroup></Project>'));
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);',
  'Assert.AreEqual(3, Arithmetic.Expected);\n#if !REFERENCED\nAssert.Fail("Workspace context must fail");\n#endif\n'));
 const other=f.file('ZConsumer');await fs.mkdir(other);
 await fs.writeFile(path.join(other,'ZConsumer.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><EnableMSTestRunner>true</EnableMSTestRunner><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><PackageReference Include="MSTest" Version="4.3.3"/><ProjectReference Include="../ImpactDemo.Tests/ImpactDemo.Tests.csproj" AdditionalProperties="Referenced=true" /></ItemGroup></Project>');
 await fs.writeFile(path.join(other,'ConsumerTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class ConsumerTests { [TestMethod] public void Pass()=>Assert.IsTrue(true); }');
 for(const coverage of [false,true]) {
  f.config.coverage=coverage;const result=await f.run([],true);
  assert.equal(result.tests,4);assert.equal(result.passed,3);assert.equal(result.failed,1,`coverage=${coverage}`);
  assert.deepEqual(await fs.readdir(path.join(f.temp,'state/runs')),[]);
 }
});

for(const [name,fileName,header,excludes] of [
 ['generated suffix','Hidden.Attributes.g.cs','',[]],
 ['generated header','Hidden.Attributes.cs','// <auto-generated/>\n',[]],
 ['configured exclusion','Hidden.Attributes.cs','',['**/Hidden.Attributes.cs']]
]) test(`partial exclusion metadata in a ${name} preserves affected callers`,{timeout:90000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Arithmetic.cs'),greeting=f.file('ImpactDemo.Tests/GreetingTests.cs'),metadata=f.file(`ImpactDemo/${fileName}`);
 f.config.excludes=excludes;
 await fs.appendFile(source,'\npublic static partial class Hidden { public static int Value(int value)=>value; }');
 await fs.writeFile(metadata,header+'namespace ImpactDemo; [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public static partial class Hidden {}');
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);','Assert.AreEqual(3, Arithmetic.Expected); Assert.AreEqual(7, Hidden.Value(7));'));
 assert.equal((await f.run([],true)).passed,3);assert.equal(f.engine.hashes.has(metadata),false);
 assert.ok(f.engine.sources.analysisHashes.has(metadata));
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('Value(int value)=>value;','Value(int value)=>value+1;'));
 await f.engine.markChanged([source]);const result=await f.run([source]);assert.equal(result.tests,3);assert.equal(result.failed,1);
 assert.ok(f.state.selected.includes('GreetingTests.cs'));
});

test('ordinary save invalidation persists only the newly executed file contribution',{timeout:90000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Arithmetic.cs');assert.equal((await f.run([],true)).passed,3);
 const writes=[],save=f.engine.cache.save.bind(f.engine.cache);
 f.engine.cache.save=async(delta,...args)=>{writes.push(...delta.traces.map(t=>t.groupId));return save(delta,...args);};
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('a + b','a + b + 0'));
 await f.engine.markChanged([source]);const result=await f.run([source]);assert.equal(result.passed,2);assert.deepEqual(f.state.selected,['CalculatorTests.cs']);
 const selected=f.engine.groups.find(group=>group.file.endsWith('CalculatorTests.cs'));
 assert.deepEqual(writes,[selected.id]);assert.ok([...f.engine.coverage.traces.values()].every(trace=>!trace.stale));
});

for(const [name,alias,declaration,fileName] of [
 ['commented','Blind','global /* comment */ using Blind /* alias */ = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;','Aliases.cs'],
 ['unicode','隠す','global using 隠す = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;','Aliases.cs'],
 ['generated','Blind','global using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;','Aliases.g.cs']
]) test(`${name} global exclusion aliases preserve affected callers`,{timeout:90000},async t=>{
 const f=await fixture(t), arithmetic=f.file('ImpactDemo/Arithmetic.cs'),greeting=f.file('ImpactDemo.Tests/GreetingTests.cs');
 await fs.writeFile(f.file(`ImpactDemo/${fileName}`),declaration);
 const source=(await fs.readFile(arithmetic,'utf8')).replace('    public static int Sum',`    [${alias}] public static int Hidden(int x) => x;\n    public static int Sum`);
 await fs.writeFile(arithmetic,source);
 await fs.writeFile(greeting,(await fs.readFile(greeting,'utf8')).replace('Assert.AreEqual(3, Arithmetic.Expected);','Assert.AreEqual(3, Arithmetic.Expected); Assert.AreEqual(7, Arithmetic.Hidden(7));'));
 assert.equal((await f.run([],true)).passed,3);
 await fs.writeFile(arithmetic,source.replace('Hidden(int x) => x;','Hidden(int x) => x + 1;'));
 const affected=await f.run([arithmetic]);assert.equal(affected.tests,3);assert.equal(affected.failed,1);
 assert.ok(f.state.selected.includes('GreetingTests.cs'));
});

test('configured exclusions omit build-generated timestamps from freshness checks',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;f.config.excludes=['**/Stamped.cs'];
 const file=f.file('ImpactDemo/Stamped.cs'),project=f.file('ImpactDemo/ImpactDemo.csproj');
 await fs.writeFile(file,'// initial stamp');
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',
  '<Target Name="GeneratedStamp" BeforeTargets="CoreCompile"><PropertyGroup><GeneratedStamp>$([System.DateTime]::UtcNow.Ticks)</GeneratedStamp></PropertyGroup><WriteLinesToFile File="$(MSBuildProjectDirectory)/Stamped.cs" Lines="// $(GeneratedStamp)" Overwrite="true" /></Target></Project>'));
 const invalidated=[];f.engine.options.events.invalidated=files=>invalidated.push(...files);
 for(let i=0;i<2;i++) {assert.equal((await f.run([],true)).passed,3);assert.equal(f.engine.hashes.has(file),false);}
 assert.deepEqual(invalidated,[]);assert.ok(f.engine.hashes.has(f.file('ImpactDemo/Arithmetic.cs')));
});

test('a fresh engine reclaims private MTP output after its previous host dies',{timeout:90000},async t=>{
 const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
 const f=await fixture(t);f.config.coverage=false;
 const source=f.file('ImpactDemo/Arithmetic.cs'),ready=path.join(f.temp,'started'),storage=path.join(f.temp,'state');
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('=> a + b;',
  '{ if (System.Environment.GetEnvironmentVariable("TESTY_CRASH_SLOW") == "1") System.Threading.Thread.Sleep(30000); return a + b; }'));
 const script=`const fs=require('node:fs');const {TestEngine}=require(${JSON.stringify(path.resolve('out/services/engine.js'))});const engine=new TestEngine({roots:[${JSON.stringify(f.root)}],storage:${JSON.stringify(storage)},tools:${JSON.stringify(path.join(f.temp,'tools'))},analyzer:${JSON.stringify(path.resolve('dist/analyzer/Testy.Analysis.dll'))},configuration:()=>(${JSON.stringify(f.config)}),events:{output:()=>{},phase:()=>{},discovered:()=>{},selected:()=>{},result:()=>{},coverage:()=>{},invalidated:()=>{},started:()=>fs.writeFileSync(${JSON.stringify(ready)},'started')}});engine.run({files:[],full:true},new AbortController().signal).catch(error=>{console.error(error);process.exitCode=1;});`;
 const child=spawn(process.execPath,['-e',script],{stdio:['ignore','ignore','pipe'],env:{...process.env,TESTY_CRASH_SLOW:'1'}});
 let error='';child.stderr.on('data',text=>error+=text);const closed=new Promise(resolve=>child.once('close',resolve));
 try {
  let started=false;
  for(let i=0;i<1200;i++){try{await fs.access(ready);started=true;break;}catch{if(child.exitCode!==null||child.signalCode!==null)break;await delay(25);}}
  assert.ok(started,error||'MTP never started');
  assert.ok((await fs.readdir(path.join(storage,'runs'))).some(name=>name.endsWith('.owner.json')));
  child.kill('SIGKILL');await closed;
  assert.equal((await f.run([],true)).passed,3);assert.deepEqual(await fs.readdir(path.join(storage,'runs')),[]);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
});

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
 await assert.rejects(f.run(),error=>{
  assert.match(error.message,/Building.*failed/);assert.match(error.message,/Other\.csproj/);return true;
 },'an unrelated edit consumed during the manual refresh must stay pending');
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
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
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
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
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
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
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

test('manual workspace discovery removes deleted test projects',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 assert.equal((await f.run([],true)).passed,3);
 await fs.rm(f.file('ImpactDemo.Tests'),{recursive:true,force:true});
 assert.equal((await f.run([],false,{all:true,groups:new Set(),coverage:false})).tests,0);
 assert.equal(f.engine.groups.length,0);assert.equal(f.engine.projects.some(project=>project.isTestProject),false);
});

test('manual file discovery replaces reversed dependency edges and obsolete inputs',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 const project=reference=>`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${reference?`<ItemGroup><ProjectReference Include="${reference}"/></ItemGroup>`:''}</Project>`;
 await fs.mkdir(f.file('A'));await fs.mkdir(f.file('B'));
 await fs.writeFile(f.file('A/A.csproj'),project('../B/B.csproj'));await fs.writeFile(f.file('B/B.csproj'),project());
 const tests=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(tests,(await fs.readFile(tests,'utf8')).replace('</ItemGroup>','<ProjectReference Include="../A/A.csproj"/></ItemGroup>'));
 assert.equal((await f.run([],true)).passed,3);const group=f.engine.groups[0];
 await fs.writeFile(f.file('A/A.csproj'),project());await fs.writeFile(f.file('B/B.csproj'),project('../A/A.csproj'));
 await fs.writeFile(tests,(await fs.readFile(tests,'utf8')).replace('../A/A.csproj','../B/B.csproj'));
 assert.equal((await f.run([],false,{groups:new Set([group.id]),coverage:false})).passed,group.tests.length);
 assert.deepEqual(f.engine.projects.find(project=>project.file===f.file('A/A.csproj')).references,[]);
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

test('build-generated header rewrites do not cancel baselines and generator data stays tracked',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 const generated=f.file('ImpactDemo/Stamped.cs'),project=f.file('ImpactDemo/ImpactDemo.csproj'),input=f.file('ImpactDemo/generator.data');
 await fs.writeFile(generated,'// Placeholder: the build adds the generated header');await fs.writeFile(input,'initial generator input');
 const target='<ItemGroup><AdditionalFiles Include="generator.data"/></ItemGroup><Target Name="GeneratedStamp" BeforeTargets="CoreCompile"><PropertyGroup><GeneratedStamp>$([System.DateTime]::UtcNow.Ticks)</GeneratedStamp></PropertyGroup><WriteLinesToFile File="$(MSBuildProjectDirectory)/Stamped.cs" Lines="// &lt;auto-generated/&gt; $(GeneratedStamp)" Overwrite="true" /></Target>';
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',target+'</Project>'));
 const invalidated=[];f.engine.options.events.invalidated=files=>invalidated.push(...files);
 assert.equal((await f.run([],true)).passed,3);assert.equal((await f.run([],true)).passed,3);
 assert.deepEqual(invalidated,[]);assert.equal(f.engine.hashes.has(generated),false);assert.equal(f.engine.hashes.has(input),true);
 await fs.writeFile(input,'changed generator input');assert.equal((await f.run([input])).passed,3);
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
 const a=order.filter(project=>project.file===f.file('A/A.csproj'));assert.ok(a.length>=2);assert.ok(a.some(project=>project.properties.Flavor==='Leaf'));
});

test('an unchanged manual leaf reuses its validated evaluation in a shared solution',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 for(let i=1;i<4;i++){await fs.cp(f.file('ImpactDemo.Tests'),f.file(`Tests${i}`),{recursive:true});}
 assert.equal((await f.run([],true)).passed,12);
 const group=f.engine.groups[0],projects=require('../../out/services/projects'),evaluate=projects.evaluateProjects,evaluated=[];
 projects.evaluateProjects=async(...args)=>{evaluated.push(...args[1]);return evaluate(...args);};
 try{
  const result=await f.run([],false,{groups:new Set([group.id]),tests:new Map([[group.id,new Set([group.tests[0].id])]]),coverage:false});
  assert.equal(result.tests,1);assert.deepEqual(evaluated,[]);
 }finally{projects.evaluateProjects=evaluate;}
});


test('dynamically loaded workspace code must select its calling test file',{timeout:90000},async t=>{
 const f=await fixture(t);
 const source=f.file('ImpactDemo/Calculator.cs'),originalAssembly=path.join(f.root,'ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll');
 await fs.writeFile(source,'namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>1; public static int OtherValue()=>2; }');
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests { [TestMethod] public void Dynamic() { var assembly=System.Reflection.Assembly.LoadFile(@"${originalAssembly.replaceAll('"','""')}"); Assert.AreEqual(1,(int)assembly.GetType("ImpactDemo.Calculator")!.GetMethod("DynamicValue")!.Invoke(null,null)!); } }`);
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class GreetingTests { [TestMethod] public void Direct() => Assert.AreEqual(2,Calculator.OtherValue()); }');
 assert.equal((await f.run([],true)).passed,2);
 const dynamic=f.engine.groups.find(g=>g.file.endsWith('CalculatorTests.cs'));
 assert.ok(f.engine.coverage.traces.get(dynamic.id).dependencies.includes(source));
 await fs.writeFile(source,'namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>3; public static int OtherValue()=>2; }');
 const affected=await f.run([source]);assert.deepEqual(new Set(f.state.selected),new Set(['CalculatorTests.cs','GreetingTests.cs']));
 assert.equal((await f.run([],true)).failed,1);
 assert.equal(affected.failed,1,'affected run must include the changed reflected method');
});


test('shared editorconfig saves must invalidate the projects they compile',{timeout:90000},async t=>{
 const f=await fixture(t); f.config.coverage=false;
 const config=f.file('.editorconfig');
 await fs.writeFile(config,'root = true\n[*.cs]\ndotnet_diagnostic.CS0168.severity = none\n');
 await fs.appendFile(f.file('ImpactDemo/Calculator.cs'),'\ninternal class W { public void M() { int unused; } }');
 const baseline=await f.run([],true);assert.equal(baseline.passed,3);assert.ok(f.engine.knownFiles.includes(config));
 const contents='root = true\n[*.cs]\ndotnet_diagnostic.CS0168.severity = error\n';
 await fs.writeFile(config,contents);
 const file=path.resolve('out/extension.js'),exports={},realRequire=require('node:module').createRequire(file);
 require('node:vm').runInNewContext((await fs.readFile(file,'utf8'))+'\nexports.Testy=Testy;',{
  exports,require:name=>name==='vscode'?{}:name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
 });
 const requests=[],context={roots:[normalizePath(f.root)],disposed:false,engine:f.engine,scheduler:{request:(...args)=>requests.push(args)},
  config:{excludes:[],pattern:'**/*.{cs,csproj,sln,slnx,props,targets,runsettings,json,config,resx}'}};
 await exports.Testy.prototype.changed.call(context,{scheme:'file',fsPath:config},contents);
 let actualBuildError='';try {await f.run([],true);}catch(e){actualBuildError=e.message;}
 assert.match(actualBuildError,/CS0168/);
 assert.equal(requests.length,1,'the saved compiler configuration should trigger a run');
});


test('full per-file refresh should retire a disappeared unmapped runtime failure',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp');
 f.config.coverage=false;
 const original=mtp.requestTests;
 try {
  mtp.requestTests=(options,operation,tests)=>operation==='discover'?original(options,operation,tests):original({...options,dotnet:process.execPath,
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'obsolete-row','display-name':'Obsolete runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 } finally {mtp.requestTests=original;}
 assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),true);
 f.config.coverage=true;
 const abort=new AbortController();let first;
 f.state.started=group=>{if(first&&first!==group.id)abort.abort();first??=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:901},abort.signal),{name:'AbortError'});
 assert.equal(f.engine.baselineProgress.completed,1);assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),true,'partial refresh retains unknown rows');
 f.state.started=()=>{};
 const summary=await f.engine.run({files:[],full:true,generation:901},new AbortController().signal);
 assert.equal(summary.files,1,'resuming reconciles the first checkpoint without rerunning it');
 assert.equal(summary.failed,0);
 assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),false,'full refresh must remove disappeared rows');
});


test('overlapping manual runtime fallback must execute discovered tests only once',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp');
 f.config.coverage=false;
 const original=mtp.requestTests;
 try {
  mtp.requestTests=(options,operation,tests)=>operation==='discover'?original(options,operation,tests):original({...options,dotnet:process.execPath,
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'obsolete-row','display-name':'Obsolete runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 } finally {mtp.requestTests=original;}
 const unknown=f.engine.displayGroups.find(group=>group.runtimeOnly),greeting=f.engine.groups.find(group=>group.file.endsWith('GreetingTests.cs'));
 f.config.coverage=true;
 const summary=await f.run([],false,{groups:new Set([unknown.id,greeting.id])});
 assert.equal(summary.tests,3,'the overlapping file should not execute twice');
 assert.equal(f.engine.coverage.traces.get(greeting.id).reliable,true,'fallback still collects a separate file contribution');
});

test('in-memory loads and managed child processes retain workspace module dependencies',{timeout:120000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs'),tests=f.file('ImpactDemo.Tests/CalculatorTests.cs');
 const library=path.join(f.root,'ImpactDemo/bin/Debug/net10.0/ImpactDemo.dll');
 await fs.mkdir(f.file('Child'));
 await fs.writeFile(f.file('Child/Child.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup><ItemGroup><ProjectReference Include="../ImpactDemo/ImpactDemo.csproj"/></ItemGroup></Project>');
 await fs.writeFile(f.file('Child/Program.cs'),'System.Console.WriteLine(ImpactDemo.Calculator.DynamicValue());');
 await fs.writeFile(f.file('ImpactDemo.Tests/GreetingTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class GreetingTests { [TestMethod] public void Direct() => Assert.AreEqual(2,Calculator.OtherValue()); }');
 const value=n=>`namespace ImpactDemo; public static class Calculator { public static int DynamicValue()=>${n}; public static int OtherValue()=>2; }`;
 for(const kind of ['memory','child']){
  await fs.writeFile(source,value(1));
  const body=kind==='memory'?`var assembly=System.Reflection.Assembly.Load(System.IO.File.ReadAllBytes(@"${library}")); Assert.AreEqual(1,(int)assembly.GetType("ImpactDemo.Calculator")!.GetMethod("DynamicValue")!.Invoke(null,null)!);`
   :`var p=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("dotnet") { ArgumentList={ @"${path.join(f.root,'Child/bin/Debug/net10.0/Child.dll')}" }, UseShellExecute=false, RedirectStandardOutput=true }); var output=p!.StandardOutput.ReadToEnd(); p.WaitForExit(); Assert.AreEqual("1",output.Trim());`;
  await fs.writeFile(tests,`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests { [TestMethod] public void Dynamic() { ${body} } }`);
  assert.equal((await f.run([],true)).passed,2,kind);
  const group=f.engine.groups.find(g=>g.file===tests),trace=f.engine.coverage.traces.get(group.id);
  assert.equal(trace.reliable,true,kind);assert.ok(trace.moduleProjects.includes(f.file('ImpactDemo/ImpactDemo.csproj')),kind);
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

test('missing observer reports keep coverage visible and selection conservative',{timeout:90000},async t=>{
 const f=await fixture(t),{RuntimeObservation}=require('../../out/services/runtimeObservation'),original=RuntimeObservation.prototype.dependencies;
 RuntimeObservation.prototype.dependencies=async()=>{throw new Error('controlled missing observation');};
 try {
  const result=await f.run([],true);assert.equal(result.passed,3);assert.equal(result.coverageAvailable,true);
  assert.ok([...f.engine.coverage.traces.values()].every(trace=>!trace.reliable));
  assert.ok(f.engine.coverage.summarize(f.engine.hashes).some(source=>source.covered>0));
  assert.equal(f.engine.select([f.file('ImpactDemo/Calculator.cs')]).groups.length,2);
 }finally{RuntimeObservation.prototype.dependencies=original;}
});

test('creating and deleting compiler configuration during tests prevents obsolete checkpoints',{timeout:90000},async t=>{
 const f=await fixture(t),config=f.file('.editorconfig');
 await f.run([],true);assert.ok(f.engine.knownFiles.includes(config));
 for(const action of ['create','delete']){
  const before=new Map(f.engine.coverage.traces);let changed=false;
  f.state.started=()=>{if(changed)return;changed=true;if(action==='create')require('node:fs').writeFileSync(config,'root = true\n[*.cs]\ndotnet_diagnostic.CS0168.severity = none\n');else require('node:fs').unlinkSync(config);};
  await assert.rejects(f.run([],true),{name:'AbortError'});assert.equal(changed,true);
  for(const [id,trace] of before){assert.equal(f.engine.coverage.traces.get(id).timestamp,trace.timestamp,'obsolete contribution did not replace the checkpoint');}
  f.state.started=()=>{};assert.equal((await f.run([],true)).passed,3);
 }
});

test('symbol-less workspace modules retain affected callers without selecting unrelated tests',{timeout:90000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs');
 const content=n=>`namespace ImpactDemo; public static class Calculator { public static int Blind(int value) => value + ${n}; public static int Visible(int value) => value + 1; }`;
 await fs.writeFile(source,content(1));
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),'using ImpactDemo; using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class CalculatorTests { [TestMethod] public void C() => Assert.AreEqual(2,Calculator.Visible(1)); }');
 await fs.mkdir(f.file('BlindLibrary'));await fs.writeFile(f.file('BlindLibrary/BlindLibrary.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><DebugType>none</DebugType></PropertyGroup><ItemGroup><Compile Include="../ImpactDemo/Calculator.cs" Link="Calculator.cs" /></ItemGroup></Project>');
 await fs.mkdir(f.file('BlindTests'));await fs.writeFile(f.file('BlindTests/BlindTests.csproj'),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../BlindLibrary/BlindLibrary.csproj" /></ItemGroup></Project>');
 await fs.writeFile(f.file('BlindTests/BlindTests.cs'),'using ImpactDemo; using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class BlindCases { [TestMethod] public void C() => Assert.AreEqual(2,Calculator.Blind(1)); }');
 assert.equal((await f.run([],true)).passed,3);
 const caller=f.engine.groups.find(group=>group.file.endsWith('/BlindTests.cs')),trace=f.engine.coverage.traces.get(caller.id);
 assert.equal(trace.reliable,true);assert.ok(trace.dependencies.includes(source));assert.ok(trace.moduleProjects.includes(f.file('BlindLibrary/BlindLibrary.csproj')));
 assert.ok(f.state.output.some(text=>text.includes('No instrumentation change in BlindLibrary.dll')));
 await fs.writeFile(source,content(2));const affected=await f.run([source]);
 assert.equal(affected.failed,1);assert.equal(affected.tests,2);assert.deepEqual(new Set(f.state.selected),new Set(['BlindTests.cs','CalculatorTests.cs']));
 const all=await f.run([],true);assert.equal(all.tests,3);assert.equal(affected.failed,all.failed);
});

test('converting a test target to a library retires checkpoints and cached coverage before build failure',{timeout:90000},async t=>{
 const f=await fixture(t),project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),original=await fs.readFile(project,'utf8');
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
 await f.run([],true);
 const abort=new AbortController();let first;
 f.state.started=group=>{if(first&&first!==group.id)abort.abort();first??=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:910},abort.signal),{name:'AbortError'});
 assert.equal(f.engine.baselineProgress.completed,1);assert.equal(f.engine.coverage.traces.size,2);f.state.started=()=>{};
 const library='<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>';
 await fs.writeFile(project,library.replace('</Project>','<Target Name="ControlledFailure" BeforeTargets="BeforeBuild"><Error Text="controlled library build failure" /></Target></Project>'));
 await assert.rejects(f.run([project]),/controlled library build failure/);
 assert.equal(f.engine.groups.length,0);assert.equal(f.engine.displayGroups.length,0);assert.equal(f.engine.baselineProgress.completed,0);assert.equal(f.engine.baseline.runtimeResults.size,0);
 assert.equal(f.engine.coverage.traces.size,0);
 const {CoverageStore}=require('../../out/core/coverage'),{CoverageCache}=require('../../out/services/cache'),restored=new CoverageStore();
 await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(restored);assert.equal(restored.traces.size,0,'removed target contributions stay removed after reopening');
 await fs.writeFile(project,library);assert.equal((await f.run([project])).tests,0);
 await fs.writeFile(project,original);assert.equal((await f.run([project])).passed,3,'a target that becomes eligible again is discovered afresh');
});

test('retiring a test target also removes unmapped runtime rows and remembered identities',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp'),request=mtp.requestTests;f.config.coverage=false;
 try{
  mtp.requestTests=(options,operation,tests)=>operation==='discover'?request(options,operation,tests):request({...options,dotnet:process.execPath,
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'retired-row','display-name':'Runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 }finally{mtp.requestTests=request;}
 const runtime=f.engine.displayGroups.find(group=>group.runtimeOnly);assert.ok(runtime);assert.ok(f.engine.knownTests(runtime).length);
 const project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>');
 assert.equal((await f.run([project])).tests,0);assert.equal(f.engine.displayGroups.length,0);assert.equal(f.engine.runtime.size,0);assert.equal(f.engine.knownCache.size,0);assert.equal(f.engine.coverage.traces.size,0);
});

test('removing a workspace test folder stops execution while its referenced project still builds',{timeout:90000},async t=>{
 const f=await fixture(t);await fs.mkdir(f.file('Consumer'));
 await fs.writeFile(f.file('Consumer/Consumer.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../ImpactDemo.Tests/ImpactDemo.Tests.csproj" /></ItemGroup></Project>');
 assert.equal((await f.run([],true)).passed,3);const prepared=f.state.prepared;
 f.engine.setRoots([f.file('Consumer')]);await fs.rm(f.file('ImpactDemo.Tests/bin'),{recursive:true,force:true});
 const result=await f.run([],true);assert.equal(result.tests,0);assert.equal(f.engine.groups.length,0);assert.equal(f.engine.coverage.traces.size,0);assert.equal(f.state.prepared,prepared);
 const reference=f.engine.projects.find(project=>project.isTestProject);assert.equal(reference.entryPoint,false);await fs.access(reference.assembly);
 f.engine.setRoots([f.root]);assert.equal((await f.run([],true)).passed,3);
});

async function editorInputs(f,trigger='fileSystem') {
 const file=path.resolve('out/extension.js'),exports={},real=require('node:module').createRequire(file),patterns=[],requests=[];
 const vscode={RelativePattern:class {constructor(base,pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher:pattern=>{
  patterns.push(pattern);return {dispose(){},onDidChange(){},onDidCreate(){},onDidDelete(){}};
 }}};
 require('node:vm').runInNewContext((await fs.readFile(file,'utf8'))+'\nexports.Testy=Testy;',{
  exports,require:name=>name==='vscode'?vscode:name==='./configuration'?{}:real(name),Buffer,setTimeout,clearTimeout
 });
 const ui={roots:[normalizePath(f.root)],watchers:[],engine:f.engine,scheduler:{request:(...args)=>requests.push(args)},
  config:{trigger,excludes:[],pattern:require('../../package.json').contributes.configuration.properties['testy.fileWatcherPattern'].default}};
 const watch=()=>exports.Testy.prototype.watch.call(ui);f.state.inputsChanged=watch;watch();
 return {patterns,requests,changed:file=>exports.Testy.prototype.changed.call(ui,{scheme:'file',fsPath:file})};
}

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

test('SDK candidate creation and deletion during execution discard obsolete checkpoints',{timeout:90000},async t=>{
 const f=await fixture(t);await fs.rm(f.file('global.json'));const global=normalizePath(path.join(f.temp,'global.json'));
 await f.run([],true);assert.ok(f.engine.knownFiles.includes(global));
 for(const action of ['create','delete']){
  const before=new Map(f.engine.coverage.traces);let changed=false;
  f.state.started=()=>{if(changed)return;changed=true;if(action==='create')require('node:fs').writeFileSync(global,'{}');else require('node:fs').unlinkSync(global);};
  await assert.rejects(f.run([],true),{name:'AbortError'});assert.equal(changed,true);
  for(const [id,trace] of before)assert.equal(f.engine.coverage.traces.get(id).timestamp,trace.timestamp);
  f.state.started=()=>{};assert.equal((await f.run([],true)).passed,3);assert.equal(f.engine.hashes.has(global),action==='create');
 }
});

test('UTF-16 generated build outputs do not invalidate the initial baseline',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;const project=f.file('ImpactDemo/ImpactDemo.csproj'),original=await fs.readFile(project,'utf8');
 const generated=f.file('ImpactDemo/UnicodeOutput.cs');
 for(const [encoding,bom] of [['Unicode',[0xff,0xfe]],['unicodeFFFE',[0xfe,0xff]]]){
  const content=Buffer.from('// <auto-generated/> initial\n','utf16le');if(encoding==='unicodeFFFE')content.swap16();
  await fs.writeFile(generated,Buffer.concat([Buffer.from(bom),content]));
  await fs.writeFile(project,original.replace('</Project>',`<Target Name="EmitUnicode" BeforeTargets="CoreCompile"><PropertyGroup><GeneratedStamp>$([System.DateTime]::UtcNow.Ticks)</GeneratedStamp></PropertyGroup><WriteLinesToFile File="$(MSBuildProjectDirectory)/UnicodeOutput.cs" Lines="// &lt;auto-generated/&gt; $(GeneratedStamp)" Encoding="${encoding}" Overwrite="true" /></Target></Project>`));
  for(let attempt=0;attempt<2;attempt++)assert.equal((await f.run([],true)).passed,3,encoding);
  assert.equal(f.engine.hashes.has(generated),false);assert.equal(f.engine.sources.isGenerated(generated),true);
 }
});
