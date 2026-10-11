const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {fixture}=require('./support/regressions.cjs');

for(const reuse of [false,true]){
 test(`a test that exceeds the per-test time limit stops its process and is reported with the reason${reuse?' (reused hosts)':''}`,{timeout:240000},async t=>{
  const f=await fixture(t);
  f.config.testTimeout=1500;f.config.reuseTestHosts=reuse;
  await fs.writeFile(f.file('ImpactDemo.Tests/HangTests.cs'),'using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class HangTests {\n [TestMethod] public void Hangs() { System.Threading.Thread.Sleep(20000); }\n}\n');
  const started=Date.now();
  const summary=await f.run([],true);
  const hang=f.state.results.find(result=>result.name==='Hangs');
  assert.equal(hang?.outcome,'errored',f.state.output.join(''));
  assert.match(String(hang?.message),/ran longer than the per-test time limit/);
  assert.ok(f.state.results.some(result=>result.name==='GreetsByName'&&result.outcome==='passed'),'other files still run');
  assert.ok(Date.now()-started<20000,'the run did not wait for the hanging test');
  assert.ok(summary.failed>=1);
 });
}
