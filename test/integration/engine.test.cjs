const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {TestEngine} = require('../../out/services/engine');
const {normalizePath} = require('../../out/core/paths');

test('MTP baseline, affected-file rerun, failure details, retained coverage and new-file fallback', {timeout:120000}, async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy integration '));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const observed=[];let selection;const phases=[];let cancelOnStart;
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:60000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 const engine=new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
   output:text=>{if(/error/i.test(text)) console.log(text);},phase:phase=>phases.push(phase),discovered:()=>{},selected:value=>{selection=value;},
   result:(group,result)=>observed.push({file:path.basename(group.file),...result}),started:()=>cancelOnStart?.abort(),coverage:()=>{},invalidated:()=>{}
 }});
 const signal=new AbortController().signal;
 const baseline=await engine.run({files:[],full:true},signal);
 assert.equal(baseline.tests,3);assert.equal(baseline.passed,3);assert.equal(baseline.coverageAvailable,true);
 assert.equal(engine.groups.length,2);assert.equal(engine.coverage.traces.size,2);
 const arithmetic=normalizePath(path.join(root,'ImpactDemo/Arithmetic.cs'));
 const greeting=normalizePath(path.join(root,'ImpactDemo/Greeting.cs'));
 const greetingBefore=engine.coverage.summarize(engine.hashes).find(file=>file.file===greeting);
 assert.ok(greetingBefore.covered>0);assert.equal(greetingBefore.stale,false);
 const old=await fs.readFile(arithmetic,'utf8');
 await fs.writeFile(arithmetic,old.replace('a + b','a + b + 1'));
 await engine.markChanged();
 assert.equal(engine.coverage.summarize(engine.hashes).find(file=>file.file===arithmetic).stale,true);
 observed.length=0;
 const changed=await engine.run({files:[arithmetic],full:false},signal);
 assert.equal(changed.files,1);assert.equal(changed.tests,2);assert.equal(changed.failed,2);
 assert.deepEqual(selection.groups.map(group=>path.basename(group.file)),['CalculatorTests.cs']);
 assert.ok(observed.every(result=>result.file==='CalculatorTests.cs'));
 assert.ok(observed.some(result=>result.message?.includes('Assert.AreEqual')));
 assert.deepEqual(engine.coverage.summarize(engine.hashes).find(file=>file.file===greeting),greetingBefore);
 await fs.writeFile(arithmetic,old);
 const fixed=await engine.run({files:[arithmetic],full:false},signal);
 assert.equal(fixed.passed,2);assert.equal(fixed.failed,0);
 const greetingTrace=engine.coverage.traces.get(engine.groups.find(group=>group.file.endsWith('/GreetingTests.cs')).id);
 assert.ok(!greetingTrace.dependencies.includes(arithmetic),'inlined constants are invisible to runtime tracing');
 await fs.writeFile(arithmetic,old.replace('const int Expected = 3','const int Expected = 4'));
 const constantChange=await engine.run({files:[arithmetic],full:false},signal);
 assert.equal(constantChange.files,2);assert.equal(constantChange.failed,1);assert.equal(selection.fallback,true);
 await fs.writeFile(arithmetic,old);
 assert.equal((await engine.run({files:[arithmetic],full:false},signal)).passed,3);
 const added=normalizePath(path.join(root,'ImpactDemo/NewFeature.cs'));
 await fs.writeFile(added,'namespace ImpactDemo; public class NewFeature { public int Value => 42; }');
 const fallback=await engine.run({files:[added],full:false},signal);
 assert.equal(fallback.tests,3);assert.equal(selection.fallback,true);
 const snapshot=JSON.parse(await fs.readFile(path.join(directory,'state/coverage.json'),'utf8'));
 assert.equal(snapshot.version,1);assert.equal(snapshot.traces.length,2);
 const calculatorGroup=engine.groups.find(group=>group.file.endsWith('/CalculatorTests.cs'));
 const beforeManual=JSON.stringify([...engine.coverage.traces.values()]);
 const manual=await engine.run({files:[],full:false},signal,{
   groups:new Set([calculatorGroup.id]),tests:new Map([[calculatorGroup.id,new Set([calculatorGroup.tests[0].id])]]),coverage:true
 });
 assert.equal(manual.tests,1);
 assert.equal(JSON.stringify([...engine.coverage.traces.values()]),beforeManual,'a partial manual run must retain its sibling coverage');
 const testFile=calculatorGroup.file;
 const testSource=await fs.readFile(testFile,'utf8');
 await fs.writeFile(testFile,testSource.replace('=> Assert.AreEqual(expected, Calculator.Add(a, b));','{ System.Threading.Thread.Sleep(30000); Assert.AreEqual(expected, Calculator.Add(a, b)); }'));
 cancelOnStart=new AbortController();
 const cancellationStarted=Date.now();
 await assert.rejects(engine.run({files:[testFile],full:false},cancelOnStart.signal),()=>cancelOnStart.signal.aborted);
 assert.ok(Date.now()-cancellationStarted<8000,'cancelled test processes should exit promptly');
 assert.equal(JSON.stringify([...engine.coverage.traces.values()]),beforeManual,'cancellation must not replace dependency or coverage data');
 cancelOnStart=undefined;
 await fs.writeFile(testFile,testSource);
 console.log(JSON.stringify({baselineMs:baseline.duration,affectedMs:changed.duration,baselineTests:baseline.tests,affectedTests:changed.tests}));
});
