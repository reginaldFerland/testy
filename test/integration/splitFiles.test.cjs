const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');

test('a long test file is split into parts that run side by side in a throughput run, and commits as one complete run',{timeout:300000},async t=>{
 const f=await fixture(t);
 f.config.maxParallelTestFiles=4;
 await fs.writeFile(f.file('ImpactDemo/Long.cs'),'namespace ImpactDemo; public static class Long {\n    public static int A() { return 1; }\n    public static int B() { return 2; }\n    public static int C() { return 3; }\n    public static int D() { return 4; }\n}\n');
 const methods=['A','B','C','D'].map((name,index)=>`[TestMethod] public void ${name}() { System.Threading.Thread.Sleep(1500); Assert.AreEqual(${index+1}, Long.${name}()); }`).join('\n ');
 await fs.writeFile(f.file('ImpactDemo.Tests/LongTests.cs'),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class LongTests {\n ${methods}\n}\n`);
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('LongTests.cs')));
 assert.ok((f.engine.elapsed(group.id)??0)>=5000,`learned ${f.engine.elapsed(group.id)}`);
 assert.ok(group.tests.every(item=>(f.engine.testDuration(group.id,item.id)??0)>=1000),'each test has its own duration');
 f.state.results.length=0;f.state.output.length=0;
 const started=Date.now();
 const summary=await f.run([],false,{all:true,groups:new Set()});
 const wall=Date.now()-started;
 assert.equal(summary.failed,0,f.state.output.join(''));
 assert.ok(f.state.output.some(line=>/Testy split 1 long test file into [2-4] parts that run side by side: LongTests\.cs/.test(line)),f.state.output.join(''));
 assert.deepEqual(f.state.results.filter(result=>result.file?.endsWith('LongTests.cs')).map(result=>result.name).sort(),['A','B','C','D']);
 const trace=defined(f.engine.coverage.traces.get(group.id));
 assert.equal(trace.reliable,true);assert.equal(trace.stale??false,false);
 const long=defined(trace.coverage.find(entry=>entry.file.endsWith('Long.cs')));
 assert.equal(long.lines.filter(line=>line.hits>0).length,4,'every part\'s coverage is merged into the file\'s');
 assert.ok(wall<6000+8000,`the run took ${wall} ms`);
});
