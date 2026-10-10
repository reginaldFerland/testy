// Regression scenarios: workspace roots and test targets that are converted, retired or removed. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {defined,fixture}=require('./support/regressions.cjs');

test('workspace roots can change and each nested SDK context is checked',{timeout:90000},async t=>{
 const f=await fixture(t);f.config.coverage=false;
 const empty=path.join(f.temp,'empty');await fs.mkdir(empty);
 f.engine.setRoots([empty,f.root]);assert.equal((await f.run([],true)).passed,3);
 f.engine.setRoots([empty]);assert.equal((await f.run([],true)).tests,0);assert.equal(f.engine.groups.length,0);
 await fs.writeFile(f.file('ImpactDemo.Tests/global.json'),JSON.stringify({sdk:{version:'9.0.100',rollForward:'disable'}}));
 f.engine.setRoots([f.root]);await assert.rejects(f.run([],true),/SDK|sdk|9\.0\.100/);
});

test('converting a test target to a library retires checkpoints and cached coverage before build failure',{timeout:90000},async t=>{
 const f=await fixture(t),project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj'),original=await fs.readFile(project,'utf8');
 f.config.maxParallelTestFiles=1; // This scenario deliberately cancels between serial checkpoints.
 await f.run([],true);
 const abort=new AbortController();
 /** @type {string | undefined} */ let first;
 f.state.started=group=>{if(first&&first!==group.id)abort.abort();first??=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:910},abort.signal),{name:'AbortError'});
 assert.equal(defined(f.engine.baselineProgress).completed,1);assert.equal(f.engine.coverage.traces.size,2);f.state.started=()=>{};
 const library='<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>';
 await fs.writeFile(project,library.replace('</Project>','<Target Name="ControlledFailure" BeforeTargets="BeforeBuild"><Error Text="controlled library build failure" /></Target></Project>'));
 await assert.rejects(f.run([project]),/controlled library build failure/);
 assert.equal(f.engine.groups.length,0);assert.equal(f.engine.displayGroups.length,0);assert.equal(defined(f.engine.baselineProgress).completed,0);assert.equal(f.internal.baseline.runtimeResults.size,0);
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
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...defined(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'retired-row','display-name':'Runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 }finally{mtp.requestTests=request;}
 const runtime=f.engine.displayGroups.find(group=>group.runtimeOnly);assert.ok(runtime);assert.ok(f.engine.knownTests(runtime).length);
 const project=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(project,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup></Project>');
 assert.equal((await f.run([project])).tests,0);assert.equal(f.engine.displayGroups.length,0);assert.equal(f.engine.runtime.rows.size,0);assert.equal(f.engine.runtime.known.size,0);assert.equal(f.engine.coverage.traces.size,0);
});

test('removing a workspace test folder stops execution while its referenced project still builds',{timeout:90000},async t=>{
 const f=await fixture(t);await fs.mkdir(f.file('Consumer'));
 await fs.writeFile(f.file('Consumer/Consumer.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../ImpactDemo.Tests/ImpactDemo.Tests.csproj" /></ItemGroup></Project>');
 assert.equal((await f.run([],true)).passed,3);const prepared=f.state.prepared;
 f.engine.setRoots([f.file('Consumer')]);await fs.rm(f.file('ImpactDemo.Tests/bin'),{recursive:true,force:true});
 const result=await f.run([],true);assert.equal(result.tests,0);assert.equal(f.engine.groups.length,0);assert.equal(f.engine.coverage.traces.size,0);assert.equal(f.state.prepared,prepared);
 const reference=defined(f.engine.projects.find(project=>project.isTestProject));assert.equal(reference.entryPoint,false);await fs.access(reference.assembly);
 f.engine.setRoots([f.root]);assert.equal((await f.run([],true)).passed,3);
});
