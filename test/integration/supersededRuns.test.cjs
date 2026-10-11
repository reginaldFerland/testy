const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');
const {Superseded}=require('../../out/core/scheduler');

const slow='namespace ImpactDemo; public static class Slow {\n    public static int Value()\n    {\n        return 1;\n    }\n}\n';
const slowTests='using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class SlowTests {\n [TestMethod] public void Value() { System.Threading.Thread.Sleep(3000); Assert.AreEqual(1, Slow.Value()); }\n}\n';

/** @param {Awaited<ReturnType<typeof fixture>>} f @param {string} file @param {string} from @param {string} to */
async function edit(f,file,from,to){await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace(from,to));await f.engine.markChanged([file]);}

test('a run superseded by an unrelated save finishes its running file, and the next run does not repeat it',{timeout:240000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Slow.cs'),greeting=f.file('ImpactDemo/Greeting.cs');
 await fs.writeFile(source,slow);await fs.writeFile(f.file('ImpactDemo.Tests/SlowTests.cs'),slowTests);
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('SlowTests.cs')));
 // A declaration change selects the whole test project, which coverage cannot narrow later either.
 await edit(f,source,'return 1;','return 1;\n    }\n    public static int Other()\n    {\n        return 2;');
 f.state.results.length=0;
 const superseded=new AbortController();
 const started=new Promise(resolve=>{f.state.started=item=>{if(item.id===group.id)resolve(undefined);};});
 const run=f.engine.run({files:[source],full:false},new AbortController().signal,undefined,false,undefined,undefined,superseded.signal);
 await started;
 await edit(f,greeting,'"Hello, stranger"','"Hello, nobody"');
 superseded.abort(new Superseded([greeting]));
 await assert.rejects(run,{name:'AbortError'});
 assert.ok(f.state.results.some(result=>result.name==='Value'&&result.outcome==='passed'),'the running slow file finished');
 assert.ok(f.state.output.some(line=>/finishing \d+ running test batch/.test(line)));
 const trace=defined(f.engine.coverage.traces.get(group.id));
 assert.equal(trace.coverage.find(entry=>entry.file===source)?.hash,f.engine.hashes.get(source),'the finished file committed its coverage of the edit');
 f.state.results.length=0;
 const next=await f.run([source,greeting]);
 assert.equal(next.failed,0,f.state.output.join(''));
 assert.ok(!f.state.selected.includes('SlowTests.cs'),`${f.state.selected}`);
 assert.ok(f.state.selected.includes('GreetingTests.cs'),`${f.state.selected}`);
 assert.ok(f.state.output.some(line=>/selected test files? already ran against these changes/.test(line)),f.state.output.join(''));
 assert.equal(f.engine.coverage.traces.get(group.id)?.stale??false,false,'its coverage is current again');
});

test('a run superseded by a save its running file depends on stops at once',{timeout:240000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Slow.cs');
 await fs.writeFile(source,slow);await fs.writeFile(f.file('ImpactDemo.Tests/SlowTests.cs'),slowTests);
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('SlowTests.cs')));
 await edit(f,source,'return 1;','return 0 + 1;');
 f.state.results.length=0;
 const superseded=new AbortController();
 const started=new Promise(resolve=>{f.state.started=item=>{if(item.id===group.id)resolve(undefined);};});
 const run=f.engine.run({files:[source],full:false},new AbortController().signal,undefined,false,undefined,undefined,superseded.signal);
 await started;
 const stopped=Date.now();
 await edit(f,source,'return 0 + 1;','return 1 + 0;');
 superseded.abort(new Superseded([source]));
 await assert.rejects(run,{name:'AbortError'});
 assert.ok(Date.now()-stopped<2500,'it did not wait for the three-second test');
 assert.deepEqual(f.state.results,[]);
});
