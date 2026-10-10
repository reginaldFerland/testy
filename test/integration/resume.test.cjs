const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

/** @typedef {import('../../out/core/selection').Selection} Selection */

test('reopening after a baseline runs only what changed while closed, detects files edited meanwhile, and distrusts other settings',{timeout:300000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy resume '));
 const control=new AbortController(),signal=AbortSignal.any([t.signal,control.signal]);
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {{-readonly [K in keyof import('../../out/core/model').EngineConfiguration]: import('../../out/core/model').EngineConfiguration[K]}} */ // mutable: the last reopen changes a setting
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 /** @type {Selection|undefined} */ let selection;
 /** @type {string[]} */ const output=[];
 const create=()=>new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected:value=>{selection=value;},result(){},started(){},coverage(){},invalidated(){}}});
 let engine=create();
 t.after(async()=>{control.abort();try{await engine.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}});
 /** Close the window and open it again, as startup does: restore, then the full request startup always makes. */
 const reopen=async()=>{await engine.dispose();engine=create();output.length=0;selection=undefined;await engine.restore(signal);return engine.run({files:[],full:true},signal);};
 const selected=()=>/** @type {Selection} */ (selection).groups.map(group=>path.basename(/** @type {string} */ (group.file))).sort();
 await engine.restore(signal);
 const baseline=await engine.run({files:[],full:true},signal);
 assert.equal(baseline.tests,3);assert.equal(baseline.coverageAvailable,true,output.join(''));

 const unchanged=await reopen();
 assert.ok([...engine.coverage.traces.values()].every(trace=>trace.reliable),'saved traces narrow selections again');
 assert.equal(unchanged.tests,0,output.join(''));assert.deepEqual(selected(),[]);
 assert.match(/** @type {Selection} */ (selection).reason,/Changes since the saved coverage \(2\/2 files current\)/);

 // A method body edited while the editor was closed reruns only the test file that covers it.
 const greeting=path.join(root,'ImpactDemo/Greeting.cs'),greetingSource=await fs.readFile(greeting,'utf8');
 await fs.writeFile(greeting,greetingSource.replace('return $"Hello, {name}";','return $"Hello, {name}" + string.Empty;'));
 const edited=await reopen();
 assert.ok(output.some(text=>text.includes('1 file changed since the coverage was saved')),output.join(''));
 assert.deepEqual(selected(),['GreetingTests.cs']);assert.equal(edited.tests,1);assert.equal(edited.passed,1);
 // That run consumed the change.
 assert.equal((await reopen()).tests,0,output.join(''));

 // A declaration change made while closed is conservative: the constant is inlined, so no trace shows it.
 const arithmetic=path.join(root,'ImpactDemo/Arithmetic.cs'),arithmeticSource=await fs.readFile(arithmetic,'utf8');
 await fs.writeFile(arithmetic,arithmeticSource.replace('const int Expected = 3','const int Expected = 4'));
 const constant=await reopen();
 assert.deepEqual(selected(),['CalculatorTests.cs','GreetingTests.cs']);assert.equal(constant.failed,1);
 await fs.writeFile(arithmetic,arithmeticSource);
 assert.equal((await reopen()).passed,3,'the failing file and the reverted change both run again');

 // Coverage learned under other settings is never trusted: another build configuration relearns everything.
 config.configuration='Release';
 const relearned=await reopen();
 assert.equal(relearned.tests,3);assert.match(/** @type {Selection} */ (selection).reason,/^Baseline/);
});

/** A copy of ImpactDemo with a shared data directory beside its projects, and an engine that can be closed and opened again.
 * @param {import('node:test').TestContext} t */
async function reopenable(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy resume '));
 const control=new AbortController(),signal=AbortSignal.any([t.signal,control.signal]);
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const data=path.join(root,'TestData','cases.json');await fs.mkdir(path.dirname(data));await fs.writeFile(data,'[1, 2]');
 /** @type {import('../../out/core/model').EngineConfiguration} */
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 /** @type {{selection: Selection|undefined, output: string[]}} */ const state={selection:undefined,output:[]};
 const create=()=>new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>state.output.push(text),phase(){},discovered(){},selected:value=>{state.selection=value;},result(){},started(){},coverage(){},invalidated(){}}});
 const f={root,data,signal,state,engine:create(),
  /** Close the window and open it again, as startup does: restore, then the full request startup always makes. */
  reopen:async()=>{await f.engine.dispose();f.engine=create();state.output.length=0;state.selection=undefined;await f.engine.restore(signal);return f.engine.run({files:[],full:true},signal);},
  selected:()=>/** @type {Selection} */ (state.selection).groups.map(group=>path.basename(/** @type {string} */ (group.file))).sort()};
 t.after(async()=>{control.abort();try{await f.engine.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}});
 await f.engine.restore(signal);
 const baseline=await f.engine.run({files:[],full:true},signal);
 assert.equal(baseline.tests,3);assert.equal(baseline.coverageAvailable,true,state.output.join(''));
 assert.equal((await f.reopen()).tests,0,state.output.join(''));
 return f;
}

test('an unowned data file edited, removed or added while closed reruns every test project on reopen',{timeout:300000},async t=>{
 const f=await reopenable(t);
 await fs.writeFile(f.data,'[1, 2, 3]');
 const edited=await f.reopen();
 assert.ok(f.state.output.some(text=>text.includes('1 file changed since the coverage was saved')),f.state.output.join(''));
 assert.deepEqual(f.selected(),['CalculatorTests.cs','GreetingTests.cs']);assert.equal(edited.tests,3);
 assert.equal((await f.reopen()).tests,0,'that run consumed the change');
 await fs.rm(f.data);
 assert.equal((await f.reopen()).tests,3,'a deleted data file is a change too');
 await fs.writeFile(path.join(f.root,'test.runsettings'),'<RunSettings />');
 assert.equal((await f.reopen()).tests,3,'and so is new configuration above every project');
 assert.equal((await f.reopen()).tests,0);
});

test('a trace stale at shutdown, or a change no run consumed, reruns on reopen',{timeout:300000},async t=>{
 const f=await reopenable(t);
 // A change marked a trace stale, then the window closed before any run consumed it.
 const greeting=f.engine.groups.find(group=>path.basename(/** @type {string} */ (group.file))==='GreetingTests.cs');
 assert.ok(greeting);
 f.engine.coverage.markStale(new Set([greeting.id]));
 const stale=await f.reopen();
 assert.deepEqual(f.selected(),['GreetingTests.cs']);assert.equal(stale.tests,1);
 assert.match(/** @type {Selection} */ (f.state.selection).reason,/1\/2 files current/);
 assert.equal((await f.reopen()).tests,0);
 // With automatic runs paused, shared test data changes: the watcher reports it (with its canonical path), no run consumes it.
 await fs.writeFile(f.data,'[2]');await f.engine.markChanged([normalizePath(f.data)]);
 assert.ok([...f.engine.coverage.traces.values()].every(trace=>trace.stale),'every trace is stale at shutdown');
 const pending=await f.reopen();
 assert.deepEqual(f.selected(),['CalculatorTests.cs','GreetingTests.cs']);assert.equal(pending.tests,3);
 assert.equal((await f.reopen()).tests,0,'that run consumed the change');
});
