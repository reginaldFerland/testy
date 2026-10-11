const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');

const hot='namespace ImpactDemo;\npublic static class Hot\n{\n    // testy: no coverage\n    public static long Loop(int n)\n    {\n        long sum = 0;\n        for (var i = 0; i < n; i++) { sum += i % 7; }\n        return sum;\n    }\n    public static int Kept()\n    {\n        return 1;\n    }\n}\n';

test('a member marked // testy: no coverage stays uninstrumented, and edits of its file select conservatively',{timeout:300000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Hot.cs');
 await fs.writeFile(source,hot);
 await fs.writeFile(f.file('ImpactDemo.Tests/HotTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class HotTests {\n [TestMethod] public void Loops() { Assert.IsTrue(Hot.Loop(1000) > 0); Assert.AreEqual(1, Hot.Kept()); }\n}\n');
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 assert.ok(f.state.output.some(line=>/1 function pattern from `\/\/ testy: no coverage` stay uninstrumented/.test(line)),f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('HotTests.cs')));
 const lines=defined(defined(f.engine.coverage.traces.get(group.id)).coverage.find(entry=>entry.file===source)).lines.map(line=>line.line);
 assert.ok(lines.includes(13),`Kept is instrumented: ${lines}`);
 assert.ok(!lines.some(line=>line>=6&&line<=9),`Loop is not: ${lines}`);
 // A body edit in a file with suppressed code cannot be narrowed by coverage.
 await fs.writeFile(source,hot.replace('i % 7','i % 5'));await f.engine.markChanged([source]);
 f.state.output.length=0;
 await f.run([source]);
 assert.ok(f.state.selected.includes('HotTests.cs'),`${f.state.selected}`);
 assert.ok(f.state.selected.includes('CalculatorTests.cs'),`the whole project runs: ${f.state.selected}`);
});
