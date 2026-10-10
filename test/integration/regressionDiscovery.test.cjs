// Regression scenarios: discovery failures, runtime-only rows and manual discovery. Fixtures are shared through support/regressions.cjs.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {defined,fixture}=require('./support/regressions.cjs');

/** @typedef {import('../../out/services/mtp').TestNode} TestNode */

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
 const original=mtp.requestTests,/** @type {(readonly TestNode[])[]} */ sent=[];
 try{
  mtp.requestTests=(options,operation,tests)=>{
   if(operation==='discover')return original(options,operation,tests);
   const nodes=defined(tests??options.expectedTests);sent.push(nodes);
   return original({...options,dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:f.root,wrapper:undefined,
    env:{TESTY_UPDATES:JSON.stringify([...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'unmapped-row','display-name':'Runtime row','execution-state':'failed'}])}},operation,tests);
  };
  await f.run([],true);
  const unknown=defined(f.engine.displayGroups.find(group=>group.runtimeOnly));assert.ok(unknown);assert.equal(unknown.file,undefined);
  const rerun=await f.run([],false,{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['unmapped-row'])]])});
  assert.equal(rerun.files,2,'the summary counts the actual project files executed by fallback');
  const greeting=defined(f.engine.groups.find(group=>defined(group.file).endsWith('GreetingTests.cs')));
  await f.run([],false,{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['unmapped-row'])]]),exclude:{groups:new Set([defined(greeting).id])}});
  assert.ok(sent[2].every(node=>!String(node['location.file']).endsWith('GreetingTests.cs')));
  assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),false,'the single-file run identifies the row and removes its project placeholder');
  const calculator=defined(f.engine.groups.find(group=>defined(group.file).endsWith('CalculatorTests.cs')));
  assert.ok(f.engine.knownTests(calculator).some(test=>test.id==='unmapped-row'));
 }finally{mtp.requestTests=original;}
});

test('manual file and project containers discover new tests and files while automation is idle',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.run([],true)).passed,3);
 const source=f.file('ImpactDemo.Tests/CalculatorTests.cs'),group=defined(f.engine.groups.find(group=>group.file===source)),original=await fs.readFile(source,'utf8');
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
 /** @param {string} [reference] */
 const project=reference=>`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>${reference?`<ItemGroup><ProjectReference Include="${reference}"/></ItemGroup>`:''}</Project>`;
 await fs.mkdir(f.file('A'));await fs.mkdir(f.file('B'));
 await fs.writeFile(f.file('A/A.csproj'),project('../B/B.csproj'));await fs.writeFile(f.file('B/B.csproj'),project());
 const tests=f.file('ImpactDemo.Tests/ImpactDemo.Tests.csproj');
 await fs.writeFile(tests,(await fs.readFile(tests,'utf8')).replace('</ItemGroup>','<ProjectReference Include="../A/A.csproj"/></ItemGroup>'));
 assert.equal((await f.run([],true)).passed,3);const group=f.engine.groups[0];
 await fs.writeFile(f.file('A/A.csproj'),project());await fs.writeFile(f.file('B/B.csproj'),project('../A/A.csproj'));
 await fs.writeFile(tests,(await fs.readFile(tests,'utf8')).replace('../A/A.csproj','../B/B.csproj'));
 assert.equal((await f.run([],false,{groups:new Set([group.id]),coverage:false})).passed,group.tests.length);
 assert.deepEqual(defined(f.engine.projects.find(project=>project.file===f.file('A/A.csproj'))).references,[]);
});

test('full per-file refresh should retire a disappeared unmapped runtime failure',{timeout:90000},async t=>{
 const f=await fixture(t),mtp=require('../../out/services/mtp');
 f.config.coverage=false;
 const original=mtp.requestTests;
 try {
  mtp.requestTests=(options,operation,tests)=>operation==='discover'?original(options,operation,tests):original({...options,dotnet:process.execPath,
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...defined(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'obsolete-row','display-name':'Obsolete runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 } finally {mtp.requestTests=original;}
 assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),true);
 f.config.coverage=true;
 const abort=new AbortController();
 /** @type {string | undefined} */ let first;
 f.state.started=group=>{if(first&&first!==group.id)abort.abort();first??=group.id;};
 await assert.rejects(f.engine.run({files:[],full:true,generation:901},abort.signal),{name:'AbortError'});
 assert.equal(defined(f.engine.baselineProgress).completed,1);assert.equal(f.engine.displayGroups.some(group=>group.runtimeOnly),true,'partial refresh retains unknown rows');
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
   assembly:path.resolve('test/fixtures/mtp-peer.cjs'),wrapper:undefined,env:{TESTY_UPDATES:JSON.stringify([...defined(tests??options.expectedTests).map(node=>({...node,'execution-state':'passed'})),
    {uid:'obsolete-row','display-name':'Obsolete runtime failure','execution-state':'failed'}])}},operation,tests);
  await f.run([],true);
 } finally {mtp.requestTests=original;}
 const unknown=defined(f.engine.displayGroups.find(group=>group.runtimeOnly)),greeting=defined(f.engine.groups.find(group=>defined(group.file).endsWith('GreetingTests.cs')));
 f.config.coverage=true;
 const summary=await f.run([],false,{groups:new Set([unknown.id,greeting.id])});
 assert.equal(summary.tests,3,'the overlapping file should not execute twice');
 assert.equal(defined(f.engine.coverage.traces.get(greeting.id)).reliable,true,'fallback still collects a separate file contribution');
});
