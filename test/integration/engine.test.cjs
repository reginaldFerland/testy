const {test} = require('node:test');
const {toolsDirectory}=require('./support/tools.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {TestEngine} = require('../../out/services/engine');
const {normalizePath} = require('../../out/core/paths');

/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/core/selection').Selection} Selection */
/** @typedef {import('../../out/core/coverage').CoverageSummary} CoverageSummary */
/** @typedef {import('../../out/core/model').Trace} Trace */

test('MTP baseline, affected-file rerun, failure details, retained coverage and new-file fallback', {timeout:120000}, async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy integration '));
 const control=new AbortController(),signal=AbortSignal.any([t.signal,control.signal]),operations=new Set();
 /** @type {import('../../out/services/engine').TestEngine} assigned below, before anything can dispose it; the `?.` in cleanup covers an early failure */
 let engine;
 t.after(async()=>{
  control.abort();
  await Promise.allSettled([...operations]);
  try{await engine?.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}
 });
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {(import('../../out/core/model').TestResult&{file:string})[]} */
 const observed=[];
 /** @type {Selection|undefined} */
 let selection;
 /** @type {import('../../out/services/engine').RunPhase[]} */
 const phases=[];
 /** @type {AbortController|undefined} */
 let cancelOnStart;
 /** @type {number|undefined} */
 let cancellationStarted;
  /** @type {import('../../out/core/model').EngineConfiguration} */
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 engine=new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:toolsDirectory(directory),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
   output:text=>{if(/error/i.test(text)) console.log(text);},phase:phase=>phases.push(phase),discovered:()=>{},selected:value=>{selection=value;},
   result:(group,result)=>observed.push({file:path.basename(/** @type {string} */ (group.file)),...result}),started:()=>{
    if(cancelOnStart&&!cancelOnStart.signal.aborted){cancellationStarted=Date.now();cancelOnStart.abort();}
   },coverage:()=>{},invalidated:()=>{}
 }});
 /** @param {import('../../out/core/scheduler').ChangeBatch} batch @param {AbortSignal} [operationSignal] @param {[import('../../out/services/engine').ManualSelection?,boolean?,import('../../out/services/engine').RunScope?,boolean?]} rest */
 const run=(batch,operationSignal=signal,...rest)=>{
  const operation=engine.run(batch,AbortSignal.any([signal,operationSignal]),...rest);operations.add(operation);
  void operation.then(()=>operations.delete(operation),()=>operations.delete(operation));
  return operation;
 };
 const baseline=await run({files:[],full:true},signal);
 assert.equal(baseline.tests,3);assert.equal(baseline.passed,3);assert.equal(baseline.coverageAvailable,true);
 assert.equal(engine.groups.length,2);assert.equal(engine.coverage.traces.size,2);
 const arithmetic=normalizePath(path.join(root,'ImpactDemo/Arithmetic.cs'));
 const greeting=normalizePath(path.join(root,'ImpactDemo/Greeting.cs'));
 const greetingBefore=/** @type {CoverageSummary} */ (engine.coverage.summarize(engine.hashes).find(file=>file.file===greeting));
 assert.ok(greetingBefore.covered>0);assert.equal(greetingBefore.stale,false);
 assert.deepEqual(greetingBefore.declarations?.map(({name,start})=>[name,start]),[['For(string)',6]],'Cobertura method spans reach the coverage summary');
 const old=await fs.readFile(arithmetic,'utf8');
 await fs.writeFile(arithmetic,old.replace('a + b','a + b + 1'));
 await engine.markChanged();
 assert.equal(/** @type {CoverageSummary} */ (engine.coverage.summarize(engine.hashes).find(file=>file.file===arithmetic)).stale,true);
 observed.length=0;
 const changed=await run({files:[arithmetic],full:false},signal);
 assert.equal(changed.files,1);assert.equal(changed.tests,2);assert.equal(changed.failed,2);
 assert.deepEqual(/** @type {Selection} */ (selection).groups.map(group=>path.basename(/** @type {string} */ (group.file))),['CalculatorTests.cs']);
 assert.ok(observed.every(result=>result.file==='CalculatorTests.cs'));
 assert.ok(observed.some(result=>result.message?.includes('Assert.AreEqual')));
 assert.deepEqual(engine.coverage.summarize(engine.hashes).find(file=>file.file===greeting),greetingBefore);
 await fs.writeFile(arithmetic,old);
 const fixed=await run({files:[arithmetic],full:false},signal);
 assert.equal(fixed.passed,2);assert.equal(fixed.failed,0);
 const greetingTrace=/** @type {Trace} */ (engine.coverage.traces.get(/** @type {TestFile} */ (engine.groups.find(group=>/** @type {string} */ (group.file).endsWith('/GreetingTests.cs'))).id));
 assert.ok(!greetingTrace.dependencies.includes(arithmetic),'inlined constants are invisible to runtime tracing');
 await fs.writeFile(arithmetic,old.replace('const int Expected = 3','const int Expected = 4'));
 const constantChange=await run({files:[arithmetic],full:false},signal);
 assert.equal(constantChange.files,2);assert.equal(constantChange.failed,1);assert.equal(/** @type {Selection} */ (selection).fallback,true);
 await fs.writeFile(arithmetic,old);
 assert.equal((await run({files:[arithmetic],full:false},signal)).passed,3);
 const added=normalizePath(path.join(root,'ImpactDemo/NewFeature.cs'));
 await fs.writeFile(added,'namespace ImpactDemo; public class NewFeature { public int Value => 42; }');
 const fallback=await run({files:[added],full:false},signal);
 assert.equal(fallback.tests,3);assert.equal(/** @type {Selection} */ (selection).fallback,true);
 const snapshot=await fs.readdir(path.join(directory,'state/coverage-v3/traces'));
 assert.equal(snapshot.length,2);
 const calculatorGroup=/** @type {TestFile} */ (engine.groups.find(group=>/** @type {string} */ (group.file).endsWith('/CalculatorTests.cs')));
 const beforeManual=JSON.stringify([...engine.coverage.traces.values()]);
 const manual=await run({files:[],full:false},signal,{
   groups:new Set([calculatorGroup.id]),tests:new Map([[calculatorGroup.id,new Set([calculatorGroup.tests[0].id])]]),coverage:true
 });
 assert.equal(manual.tests,1);
 assert.equal(JSON.stringify([...engine.coverage.traces.values()]),beforeManual,'a partial manual run must retain its sibling coverage');
 const testFile=/** @type {string} */ (calculatorGroup.file);
 const testSource=await fs.readFile(testFile,'utf8');
 await fs.writeFile(testFile,testSource.replace('=> Assert.AreEqual(expected, Calculator.Add(a, b));','{ System.Threading.Thread.Sleep(30000); Assert.AreEqual(expected, Calculator.Add(a, b)); }'));
 cancelOnStart=new AbortController();
 await assert.rejects(run({files:[testFile],full:false},cancelOnStart.signal),(/** @type {Error} */ error)=>error.name==='AbortError'&&/** @type {AbortController} */ (cancelOnStart).signal.aborted);
 assert.ok(cancellationStarted!==undefined,'cancellation is triggered by the real test-start notification');
 assert.ok(Date.now()-/** @type {number} */ (cancellationStarted)<8000,'cancelled test processes should exit promptly');
 assert.deepEqual([...engine.coverage.traces.values()].map(({stale,...trace})=>trace),JSON.parse(beforeManual).map((/** @type {{stale?:unknown}} */ {stale,...trace})=>trace),'cancellation must not replace dependency or coverage data');
 assert.equal(/** @type {CoverageSummary} */ (engine.coverage.summarize(engine.hashes).find(file=>file.file===arithmetic)).stale,true,'cancelled test inputs leave retained production coverage stale');
 cancelOnStart=undefined;
 await fs.writeFile(testFile,testSource);
 console.log(JSON.stringify({baselineMs:baseline.duration,affectedMs:changed.duration,baselineTests:baseline.tests,affectedTests:changed.tests}));
});
