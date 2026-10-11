const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');

test('automatic runs also run pinned test items and, with alwaysRunFailing, failing files',{timeout:240000},async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.file('ImpactDemo.Tests/FlakyTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class FlakyTests {\n [TestMethod] public void Fails() => Assert.AreEqual("never", Greeting.For("Ada"));\n}\n');
 await f.run([],true);
 const greeting=defined(f.engine.groups.find(group=>group.file?.endsWith('GreetingTests.cs')));
 // An automatic run with nothing changed: only what always runs is selected. (A failing file's coverage is not trusted to
 // narrow, so any change to its project selects it anyway.)
 const edit=async()=>{f.state.results.length=0;f.state.selected=[];return f.run([]);};
 await edit();
 assert.equal(f.state.selected.length,0,`${f.state.selected}`);
 f.engine.pinned={groups:new Set([greeting.id])};
 await edit();
 assert.ok(f.state.selected.includes('GreetingTests.cs'),`${f.state.selected}`);
 assert.ok(f.state.results.some(result=>result.name==='GreetsByName'));
 f.engine.pinned=undefined;f.config.alwaysRunFailing=true;
 await edit();
 assert.ok(f.state.selected.includes('FlakyTests.cs'),`${f.state.selected}`);assert.ok(!f.state.selected.includes('GreetingTests.cs'));
});
