// Regression scenarios: parallel workers, cancellation, collectors and private run outputs. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const {toolsDirectory}=require('./support/tools.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {defined,fixture,parallelFixture}=require('./support/regressions.cjs');

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
   const trace=defined(f.engine.coverage.traces.get(group.id));assert.equal(trace.reliable,true);assert.ok(trace.dependencies.includes(shared));
   const index=defined(/Feature(\d+)Tests/.exec(defined(group.file)))[1];assert.ok(trace.dependencies.includes(f.file(`Web/Feature${index}.cs`)));
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
 const f=await parallelFixture(t),mtp=require('../../out/services/mtp'),request=mtp.requestTests,save=f.internal.cache.save.bind(f.internal.cache),abort=new AbortController();
 let admitted=0,active=0,peak=0;
 /** @type {(value?: unknown) => void} */ let release=()=>{};
 /** @type {NodeJS.Timeout | undefined} */ let timeout;const bothAdmitted=new Promise(resolve=>release=resolve);
 t.after(()=>clearTimeout(timeout));
 mtp.requestTests=/** @type {typeof request} */ (async(...args)=>{
  if(args[1]!=='run')return request(...args);
  peak=Math.max(peak,++active);const index=admitted++;
  timeout??=setTimeout(()=>abort.abort(),60000);
  try{
   const signal=/** @type {AbortSignal} */ (args[0].signal);signal.throwIfAborted();
   /** @type {() => void} */ let interrupted=()=>{};
   const cancelled=new Promise((resolve,reject)=>{interrupted=()=>reject(Object.assign(new Error('Controlled cancellation'),{name:'AbortError'}));signal.addEventListener('abort',interrupted,{once:true});});
   try{
    if(index===0){await Promise.race([bothAdmitted,cancelled]);return await request(...args);}
    release();await cancelled;return undefined;
   }finally{signal.removeEventListener('abort',interrupted);}
  }finally{active--;}
 });
 // Cancel as soon as the first file commits; its save is still waiting for the coalescing window.
 const schedule=f.engine.scheduleSave.bind(f.engine);
 f.engine.scheduleSave=()=>{schedule();if(f.engine.coverage.traces.size)abort.abort();};
 try{
  await assert.rejects(f.engine.run({files:[],full:true,generation:902},abort.signal),{name:'AbortError'});
  assert.equal(peak,2);assert.equal(active,0);assert.equal(admitted,2,'no later batches start after cancellation');
  assert.deepEqual(f.engine.baselineProgress,{completed:1,total:6});assert.equal(f.engine.coverage.traces.size,1);
  await f.engine.save();
  const {CoverageCache}=require('../../out/services/cache'),{CoverageStore}=require('../../out/core/coverage'),persisted=new CoverageStore();
  await new CoverageCache(path.join(f.temp,'state'),()=>{}).restore(persisted);
  assert.deepEqual([...persisted.traces.keys()],[...f.engine.coverage.traces.keys()],'the cancelled run still persisted its committed file');
 }finally{clearTimeout(timeout);mtp.requestTests=request;f.internal.cache.save=save;delete f.internal.scheduleSave;}
 const completed=[...f.engine.coverage.traces.values()][0],resumed=await f.engine.run({files:[],full:true,generation:902},new AbortController().signal);
 assert.equal(resumed.files,5);assert.equal(resumed.passed,5);assert.equal(defined(f.engine.coverage.traces.get(completed.groupId)).timestamp,completed.timestamp);
 assert.equal(f.engine.coverage.traces.size,6);assert.equal(f.engine.baselineProgress,undefined);assert.deepEqual(await fs.readdir(path.join(f.temp,'state/runs')),[]);
});

test('real collector cleans detached children after completion, cancellation and host death',{timeout:90000,skip:process.platform==='win32'},async t=>{
 const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises'),{once}=require('node:events');
 const f=await fixture(t),marker=path.join(f.temp,'owned-pids.json'),launcher=path.join(f.temp,'launch.cjs');
 /** @type {Set<number>} */ const pids=new Set();t.after(()=>{for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}});
 await fs.writeFile(launcher,`const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.ppid,c.pid]));c.unref();`);
 /** @param {string} value */ const literal=value=>'@"'+value.replaceAll('"','""')+'"';
 /** @param {number} pid */ const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 for(const mode of ['completion','cancellation','host-death']){
  await fs.rm(marker,{force:true});
  await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class CalculatorTests { [TestMethod] public void Launch() { var p=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(${literal(process.execPath)}) { ArgumentList = { ${literal(launcher)} }, UseShellExecute=false }); p!.WaitForExit(); ${mode==='completion'?'':'System.Threading.Thread.Sleep(60000);'} } }`);
  const abort=new AbortController();
  /** @type {import('node:child_process').ChildProcess | undefined} */ let host;
  /** @type {Promise<import('../../out/services/engine').RunSummary> | undefined} */ let pending;
  /** @type {Promise<unknown[]> | undefined} */ let exit;
  if(mode==='host-death'){
   const script=`const {TestEngine}=require(${JSON.stringify(path.resolve('out/services/engine'))});const engine=new TestEngine({roots:[${JSON.stringify(f.root)}],storage:${JSON.stringify(path.join(f.temp,'crash-state'))},tools:${JSON.stringify(toolsDirectory(f.temp))},analyzer:${JSON.stringify(path.resolve('dist/analyzer/Testy.Analysis.dll'))},configuration:()=>(${JSON.stringify(f.config)}),events:{output(){},phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});engine.run({files:[],full:true},new AbortController().signal).catch(()=>process.exitCode=1);`;
   host=spawn(process.execPath,['-e',script],{stdio:'ignore'});pids.add(/** @type {number} */ (host.pid));exit=once(host,'exit');
  }else{pending=f.engine.run({files:[],full:true},abort.signal);void pending.catch(()=>{});}
  try{
   /** @type {number[] | undefined} */ let owned;for(let i=0;i<1200;i++){try{owned=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{await delay(25);}}
   assert.ok(owned,`${mode}: test must start`);owned.forEach(pid=>pids.add(pid));
   if(mode==='cancellation'){await delay(100);abort.abort();await assert.rejects(defined(pending),{name:'AbortError'});}
   else if(mode==='host-death'){defined(host).kill('SIGKILL');await exit;}
   else{assert.equal((await defined(pending)).coverageAvailable,true);}
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
 for(const [mode,coverage] of /** @type {['affected' | 'all', boolean][]} */ ([['affected',true],['all',true],['affected',false]])) {
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

test('a fresh engine reclaims private MTP output after its previous host dies',{timeout:90000},async t=>{
 const {spawn}=require('node:child_process'),{setTimeout:delay}=require('node:timers/promises');
 const f=await fixture(t);f.config.coverage=false;
 const source=f.file('ImpactDemo/Arithmetic.cs'),ready=path.join(f.temp,'started'),storage=path.join(f.temp,'state');
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('=> a + b;',
  '{ if (System.Environment.GetEnvironmentVariable("TESTY_CRASH_SLOW") == "1") System.Threading.Thread.Sleep(30000); return a + b; }'));
 const script=`const fs=require('node:fs');const {TestEngine}=require(${JSON.stringify(path.resolve('out/services/engine.js'))});const engine=new TestEngine({roots:[${JSON.stringify(f.root)}],storage:${JSON.stringify(storage)},tools:${JSON.stringify(toolsDirectory(f.temp))},analyzer:${JSON.stringify(path.resolve('dist/analyzer/Testy.Analysis.dll'))},configuration:()=>(${JSON.stringify(f.config)}),events:{output:()=>{},phase:()=>{},discovered:()=>{},selected:()=>{},result:()=>{},coverage:()=>{},invalidated:()=>{},started:()=>fs.writeFileSync(${JSON.stringify(ready)},'started')}});engine.run({files:[],full:true},new AbortController().signal).catch(error=>{console.error(error);process.exitCode=1;});`;
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
