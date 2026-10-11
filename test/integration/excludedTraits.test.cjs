const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');

test('tests with an excluded trait stay out of automatic runs and still run on request',{timeout:120000},async t=>{
 const f=await fixture(t),calculator=f.file('ImpactDemo/Calculator.cs');
 f.config.excludeTraits=['Integration'];
 // A file mixing a unit and an integration test, and a file with only integration tests.
 await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests { [TestMethod] public void Unit() => Assert.AreEqual(3, Calculator.Add(1, 2)); [TestMethod, TestCategory("Integration")] public void Database() => Assert.AreEqual(3, Calculator.Add(1, 2)); }');
 await fs.writeFile(f.file('ImpactDemo.Tests/ApiTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass, TestCategory("Integration")] public class ApiTests { [TestMethod] public void Calls() => Assert.AreEqual(3, Calculator.Add(1, 2)); }');
 const baseline=await f.run([],true);
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['GreetsByName','Unit'],f.state.output.join(''));
 assert.equal(baseline.failed,0);
 assert.equal(f.engine.baselineProgress,undefined,'the baseline completes without the excluded tests');
 const api=defined(f.engine.displayGroups.find(group=>group.file?.endsWith('ApiTests.cs')));
 assert.ok(f.engine.displayGroups.some(group=>group.tests.some(test=>test.name==='Database')),'excluded tests stay discovered');
 assert.equal(f.engine.groups.some(group=>group.id===api.id),false);
 // An edit that only excluded tests reach selects nothing from them; the unit test runs.
 f.state.results.length=0;
 await fs.writeFile(calculator,(await fs.readFile(calculator,'utf8')).replace('Arithmetic.Sum(a, b)','Arithmetic.Sum(a, b) + 0'));
 await f.engine.markChanged([calculator]);await f.run([calculator]);
 assert.deepEqual(f.state.results.map(result=>result.name),['Unit']);
 // A manual run includes them.
 f.state.results.length=0;
 const manual=await f.run([],false,{groups:new Set([api.id])});
 assert.equal(manual.passed,1);assert.deepEqual(f.state.results.map(result=>result.name),['Calls']);
});
