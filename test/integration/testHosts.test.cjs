const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {defined,fixture}=require('./support/regressions.cjs');

const calculator='namespace ImpactDemo; public static class Calculator {\n    public static int Add(int a, int b)\n    {\n        return Arithmetic.Sum(a, b);\n    }\n    public static int Mul(int a, int b)\n    {\n        return a * b;\n    }\n}\n';
const tests='using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class CalculatorTests {\n [TestMethod] public void AddsOne() => Assert.AreEqual(2, Calculator.Add(1, 1));\n [TestMethod] public void Multiplies() => Assert.AreEqual(6, Calculator.Mul(2, 3));\n [TestMethod] public void Both() => Assert.AreEqual(7, Calculator.Add(Calculator.Mul(2, 3), 1));\n}\n';

test('test granularity runs only the tests whose own coverage executed the edited body, and keeps the file current',{timeout:240000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs');
 f.config.granularity='test';
 await fs.writeFile(source,calculator);await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),tests);
 const baseline=await f.run([],true);
 assert.equal(baseline.failed,0,f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('CalculatorTests.cs')));
 assert.equal(f.engine.testCoverage.get(group.id),undefined,'a baseline does not take a snapshot per test');
 const edit=async(/** @type {string} */ from,/** @type {string} */ to)=>{
  f.state.results.length=0;
  await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace(from,to));
  await f.engine.markChanged([source]);return f.run([source]);
 };
 // The first edit that selects the file runs it whole and learns each test's own coverage.
 await edit('return a * b;','return b * a;');
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['AddsOne','Both','Multiplies'],f.state.output.join(''));
 assert.equal(f.engine.testCoverage.get(group.id)?.size,3,'every test of the file has its own coverage');
 const summary=await edit('return b * a;','return a * b;');
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['Both','Multiplies'],f.state.output.join(''));
 assert.equal(summary.failed,0);
 assert.ok(f.state.output.some(line=>/Narrowed CalculatorTests\.cs to 2 of 3 tests/.test(line)));
 const trace=defined(f.engine.coverage.traces.get(group.id));
 assert.equal(trace.stale??false,false,'the file\'s coverage is complete and current after a partial run');
 assert.equal(trace.coverage.find(entry=>entry.file===source)?.hash,f.engine.hashes.get(source));
 assert.equal(f.engine.testCoverage.get(group.id)?.size,3);
 await edit('return Arithmetic.Sum(a, b);','return Arithmetic.Sum(b, a);');
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['AddsOne','Both'],'the moved coverage of the test that did not run still narrows');
 const broken=await edit('return a * b;','return a * b + 1;');
 assert.deepEqual(f.state.results.filter(result=>result.outcome==='failed').map(result=>result.name).sort(),['Both','Multiplies']);
 assert.equal(broken.failed,2);
});

test('reused test hosts run several files in one process with each file\'s own coverage',{timeout:240000},async t=>{
 const f=await fixture(t);
 f.config.reuseTestHosts=true;f.config.maxParallelTestFiles=1;
 for(const [index,name] of ['Alpha','Beta','Gamma'].entries()){
  await fs.writeFile(f.file(`ImpactDemo/${name}.cs`),`namespace ImpactDemo; public static class ${name} {\n    public static int Value()\n    {\n        return ${index};\n    }\n}\n`);
  await fs.writeFile(f.file(`ImpactDemo.Tests/${name}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class ${name}Tests { [TestMethod] public void Value() { Assert.AreEqual(${index}, ${name}.Value()); System.IO.File.AppendAllText(System.IO.Path.Combine(System.IO.Path.GetTempPath(), "testy-host-" + System.Environment.ProcessId), "${name}"); } }`);
 }
 const baseline=await f.run([],true);
 assert.equal(baseline.failed,0,f.state.output.join(''));
 assert.ok(f.state.results.length>=5);
 for(const name of ['Alpha','Beta','Gamma']){
  const group=defined(f.engine.groups.find(item=>item.file?.endsWith(`${name}Tests.cs`)));
  const covered=defined(f.engine.coverage.traces.get(group.id)).coverage.filter(entry=>entry.lines.some(line=>line.hits>0)).map(entry=>entry.file.split(/[/\\]/).pop()).sort();
  assert.ok(covered.includes(`${name}.cs`),`${name} covers its own source`);
  for(const other of ['Alpha','Beta','Gamma'].filter(item=>item!==name)){assert.ok(!covered.includes(`${other}.cs`),`${name}Tests has no coverage of ${other}.cs: each file is snapshot separately`);}
 }
 // One process ran several files.
 const markers=(await fs.readdir(require('node:os').tmpdir())).filter(name=>name.startsWith('testy-host-'));
 const contents=await Promise.all(markers.map(name=>fs.readFile(require('node:path').join(require('node:os').tmpdir(),name),'utf8')));
 await Promise.all(markers.map(name=>fs.rm(require('node:path').join(require('node:os').tmpdir(),name),{force:true})));
 assert.ok(contents.some(text=>['Alpha','Beta','Gamma'].filter(name=>text.includes(name)).length>1),`some host ran more than one file: ${JSON.stringify(contents)}`);
 const beta=f.file('ImpactDemo/Beta.cs');
 f.state.results.length=0;
 await fs.writeFile(beta,(await fs.readFile(beta,'utf8')).replace('return 1;','return 1 + 0;'));
 await f.engine.markChanged([beta]);await f.run([beta]);
 assert.deepEqual(f.state.results.map(result=>result.name),['Value'],f.state.output.join(''));
 assert.ok(f.state.results.every(result=>result.file?.endsWith('BetaTests.cs')));
});

test('parallel workers reuse their own hosts, and test granularity works in a reused host',{timeout:240000},async t=>{
 const f=await fixture(t),source=f.file('ImpactDemo/Calculator.cs');
 f.config.reuseTestHosts=true;f.config.granularity='test';f.config.maxParallelTestFiles=2;
 await fs.writeFile(source,calculator);await fs.writeFile(f.file('ImpactDemo.Tests/CalculatorTests.cs'),tests);
 for(const name of ['Alpha','Beta']){
  await fs.writeFile(f.file(`ImpactDemo/${name}.cs`),`namespace ImpactDemo; public static class ${name} {\n    public static int Value()\n    {\n        return 1;\n    }\n}\n`);
  await fs.writeFile(f.file(`ImpactDemo.Tests/${name}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class ${name}Tests { [TestMethod] public void Value() => Assert.AreEqual(1, ${name}.Value()); }`);
 }
 const baseline=await f.run([],true);
 assert.equal(baseline.failed,0,f.state.output.join(''));
 const group=defined(f.engine.groups.find(item=>item.file?.endsWith('CalculatorTests.cs')));
 assert.equal(f.engine.testCoverage.get(group.id),undefined,'learned lazily, by the first edit that selects the file');
 f.state.results.length=0;
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('return a * b;','return b * a;'));
 await f.engine.markChanged([source]);await f.run([source]);
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['AddsOne','Both','Multiplies'],f.state.output.join(''));
 assert.equal(f.engine.testCoverage.get(group.id)?.size,3);
 for(const name of ['Alpha','Beta']){
  const other=defined(f.engine.groups.find(item=>item.file?.endsWith(`${name}Tests.cs`)));
  const covered=defined(f.engine.coverage.traces.get(other.id)).coverage.filter(entry=>entry.lines.some(line=>line.hits>0)).map(entry=>entry.file.split(/[/\\]/).pop());
  assert.ok(!covered.includes('Calculator.cs'),`${name}Tests does not inherit another file's coverage`);
 }
 f.state.results.length=0;
 await fs.writeFile(source,(await fs.readFile(source,'utf8')).replace('return b * a;','return a * b;'));
 await f.engine.markChanged([source]);await f.run([source]);
 assert.deepEqual(f.state.results.map(result=>result.name).sort(),['Both','Multiplies'],f.state.output.join(''));
});

/** Test files that write their process ID, so a test can tell which files shared a host. @param {Awaited<ReturnType<typeof fixture>>} f @param {string} tag */
async function hostMarkers(f,tag){
 const directory=await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(),`testy-hosts-${tag}-`));
 for(const [index,name] of ['Alpha','Beta','Gamma','Delta'].entries()){
  const category=name==='Beta'?' [TestCategory("Isolated")]':'';
  await fs.writeFile(f.file(`ImpactDemo/${name}.cs`),`namespace ImpactDemo; public static class ${name} {\n    public static int Value()\n    {\n        return ${index};\n    }\n}\n`);
  await fs.writeFile(f.file(`ImpactDemo.Tests/${name}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting; namespace ImpactDemo.Tests; [TestClass] public class ${name}Tests { [TestMethod]${category} public void Value() { Assert.AreEqual(${index}, ${name}.Value()); System.IO.File.AppendAllText(System.IO.Path.Combine(${JSON.stringify(directory)}, System.Environment.ProcessId.ToString()), "${name};"); } }`);
 }
 return {directory,hosts:async()=>Promise.all((await fs.readdir(directory)).map(async name=>(await fs.readFile(require('node:path').join(directory,name),'utf8')).split(';').filter(Boolean)))};
}

test('a file with an isolated trait runs in a process of its own while other files share a reused host',{timeout:240000},async t=>{
 const f=await fixture(t);
 f.config.reuseTestHosts=true;f.config.maxParallelTestFiles=1;f.config.isolatedTraits=['Isolated'];
 const markers=await hostMarkers(f,'isolated');t.after(()=>fs.rm(markers.directory,{recursive:true,force:true}));
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const hosts=await markers.hosts();
 assert.deepEqual(hosts.find(files=>files.includes('Beta')),['Beta'],JSON.stringify(hosts));
 // Beta can end one host early, but of three other files two still share one.
 assert.ok(hosts.some(files=>files.length>1&&!files.includes('Beta')),`the other files still share a host: ${JSON.stringify(hosts)}`);
});

test('a reused host over the memory limit is replaced after its file',{timeout:240000},async t=>{
 const f=await fixture(t);
 f.config.reuseTestHosts=true;f.config.maxParallelTestFiles=1;f.config.testProcessMemoryLimit=1024*1024;
 const markers=await hostMarkers(f,'memory');t.after(()=>fs.rm(markers.directory,{recursive:true,force:true}));
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const hosts=await markers.hosts();
 assert.ok(hosts.every(files=>files.length===1),`every file ran in a new host: ${JSON.stringify(hosts)}`);
 assert.ok(f.state.output.some(line=>/more than testy.testProcessMemoryLimit/.test(line)));
});

test('a run whose builds changed nothing reuses the previous run\'s test hosts; a rebuild starts new ones',{timeout:300000},async t=>{
 const f=await fixture(t);
 f.config.reuseTestHosts=true;f.config.maxParallelTestFiles=1;
 const markers=await hostMarkers(f,'retained');t.after(()=>fs.rm(markers.directory,{recursive:true,force:true}));
 assert.equal((await f.run([],true)).failed,0,f.state.output.join(''));
 const pids=async()=>new Set((await fs.readdir(markers.directory)));
 const first=await pids();
 f.state.output.length=0;
 assert.equal((await f.run([],false,{all:true,groups:new Set()})).failed,0,f.state.output.join(''));
 assert.ok(f.state.output.some(line=>/Reusing the test hosts, prepared outputs and discovery of the previous run/.test(line)),f.state.output.join(''));
 const second=await pids();
 assert.deepEqual([...second].sort(),[...first].sort(),'the same host processes ran the second run');
 const alpha=f.file('ImpactDemo/Alpha.cs');
 await fs.writeFile(alpha,(await fs.readFile(alpha,'utf8')).replace('return 0;','return 0 + 0;'));await f.engine.markChanged([alpha]);
 f.state.output.length=0;
 assert.equal((await f.run([alpha])).failed,0,f.state.output.join(''));
 assert.ok(!f.state.output.some(line=>/Reusing the test hosts/.test(line)),'a rebuilt output is not reused');
 const third=await pids();
 assert.ok([...third].some(pid=>!first.has(pid)),'the rebuilt output runs in a new host');
});
