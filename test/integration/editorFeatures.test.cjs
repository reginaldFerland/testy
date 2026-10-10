const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {TestEngine} = require('../../out/services/engine');
const {normalizePath} = require('../../out/core/paths');

/** @typedef {import('../../out/core/model').TestResult} TestResult */
/** @typedef {import('../../out/core/selection').Selection} Selection */
/** @typedef {{-readonly [K in keyof import('../../out/core/model').EngineConfiguration]: import('../../out/core/model').EngineConfiguration[K]}} MutableConfiguration */

/**
 * @param {import('node:test').TestContext} t
 * @param {Partial<MutableConfiguration>} [overrides]
 */
async function fixture(t, overrides={}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy editor features '));
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {MutableConfiguration} */
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL,...overrides};
 /** @type {(TestResult & {file: string})[]} */ const results=[];
 /** @type {Selection[]} */ const selections=[];
 /** @type {string[]} */ const output=[];
 /** @type {{debug?: (processId: number) => Promise<void>}} */ const state={};
 const engine=new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
  output:text=>output.push(text),phase:()=>{},discovered:()=>{},selected:value=>selections.push(value),result:(group,result)=>results.push({file:path.basename(group.file??''),...result}),
  started:()=>{},coverage:()=>{},invalidated:()=>{},debug:processId=>/** @type {Promise<void>} */ (state.debug?.(processId))
 }});
 t.after(async()=>{try{await engine.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}});
 return {root,engine,config,results,selections,output,state,run:(/** @type {import('../../out/core/scheduler').ChangeBatch} */ batch,signal=t.signal,/** @type {[import('../../out/services/engine').ManualSelection?, boolean?, import('../../out/services/engine').RunScope?, boolean?]} */ ...rest)=>engine.run(batch,signal,...rest)};
}

test('refresh discovers without running, then failures report assertion values and stack frames',{timeout:240000},async t=>{
 const f=await fixture(t);
 const discovered=await f.run({files:[],full:false},t.signal,{all:true,groups:new Set(),discoverOnly:true});
 assert.equal(discovered.tests,0);assert.equal(f.results.length,0);assert.equal(f.engine.groups.length,2);
 assert.equal(f.engine.coverage.traces.size,0,'discovery learns no coverage');
 assert.equal(/** @type {Selection} */ (f.selections.at(-1)).reason,'Discovery only');
 const arithmetic=normalizePath(path.join(f.root,'ImpactDemo/Arithmetic.cs')),old=await fs.readFile(arithmetic,'utf8');
 await fs.writeFile(arithmetic,old.replace('a + b','a + b + 1'));
 const failing=await f.run({files:[],full:true});
 assert.equal(failing.failed,2);
 const failure=/** @type {TestResult} */ (f.results.find(result=>result.outcome==='failed'));
 assert.match(failure.stack??'',/CalculatorTests\.cs/,'the stack names the failing test source');
 // MSTest sends empty assert.expected/actual properties; no empty diff is offered.
 assert.equal(failure.expected,undefined);
});

test('a solution filter limits entry points, and reset forgets learned coverage',{timeout:240000},async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.root,'Only.slnf'),JSON.stringify({solution:{path:'All.slnx',projects:['ImpactDemo.Tests/ImpactDemo.Tests.csproj']}}));
 await fs.writeFile(path.join(f.root,'All.slnx'),'<Solution><Project Path="ImpactDemo/ImpactDemo.csproj" /><Project Path="ImpactDemo.Tests/ImpactDemo.Tests.csproj" /></Solution>');
 f.config.solution=path.join(f.root,'Only.slnf');
 const baseline=await f.run({files:[],full:true});
 assert.equal(baseline.passed,3,'the test project still builds its referenced library');
 assert.ok(f.engine.knownFiles.includes(normalizePath(path.join(f.root,'Only.slnf'))),'the filter is a watched input');
 f.config.projects={include:['**/ImpactDemo.csproj'],exclude:[]};
 await assert.rejects(f.run({files:[],full:true}),/exclude every project/);
 f.config.projects=undefined;f.config.solution=undefined;
 assert.ok(f.engine.coverage.traces.size>0);
 await f.engine.reset(t.signal);
 assert.equal(f.engine.coverage.traces.size,0);assert.equal(f.engine.coverage.summarize(f.engine.hashes).length,0);
 const fresh=await f.run({files:[],full:false});
 assert.equal(fresh.passed,3);assert.match(/** @type {Selection} */ (f.selections.at(-1)).reason,/Baseline/,'reset establishes a new baseline');
});

test('a debug run starts the test host waiting for a debugger and reports its process',{timeout:240000},async t=>{
 const f=await fixture(t);
 await f.run({files:[],full:true},t.signal,{all:true,groups:new Set(),discoverOnly:true});
 const controller=new AbortController();
 /** @type {number[]} */ const processes=[];
 f.state.debug=async (/** @type {number} */ processId)=>{processes.push(processId);controller.abort();};
 await assert.rejects(f.run({files:[],full:false},AbortSignal.any([t.signal,controller.signal]),{all:true,groups:new Set(),debug:true}),(/** @type {Error} */ error)=>error.name==='AbortError'||/cancel/i.test(error.message));
 assert.equal(processes.length,1);assert.ok(Number.isSafeInteger(processes[0])&&processes[0]>0);
});
