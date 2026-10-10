const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');

test('runs report typed phases while timing lines keep their English names',{timeout:120000},async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-run-phases-')),workspace=path.join(temp,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),workspace,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {import('../../out/services/engine').RunPhase[]} */
 const phases=[];
 /** @type {string[]} */
 const output=[];
 /** @type {import('../../out/core/model').EngineConfiguration} */
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000};
 const engine=new TestEngine({roots:[workspace],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase:phase=>phases.push(phase),discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 t.after(async()=>{await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 await engine.run({files:[],full:true},t.signal);
 assert.ok(phases.every(phase=>typeof phase==='object'&&typeof phase.kind==='string'),'phases are payloads, not display text');
 const kinds=[...new Set(phases.map(phase=>phase.kind))];
 assert.deepEqual(kinds,['preparingProjects','building','preparingTests','testing']);
 const progress=phases.filter(phase=>phase.kind==='testing'&&phase.total!==undefined);
 assert.ok(progress.length>0&&progress.every(phase=>Number.isInteger(phase.completed)&&Number.isInteger(phase.total)&&Number.isInteger(phase.active)));
 assert.ok(progress.some(phase=>phase.learned!==undefined&&phase.learnedTotal===2),'baseline runs report learned files');
 assert.ok(phases.some(phase=>phase.kind==='preparingTests'&&phase.total!==undefined));
 const timing=/** @type {RegExpMatchArray} */ (output.join('').match(/Testy timing: (.+?) \d+ms/g)).map(line=>/** @type {RegExpExecArray} */ (/Testy timing: (.+?) \d+ms/.exec(line))[1]);
 for(const name of ['Preparing projects','Building','Preparing tests','Testing'])assert.ok(timing.includes(name),`${name} timing line`);
});
