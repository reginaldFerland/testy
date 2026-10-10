const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {TestEngine} = require('../../out/services/engine');
const {normalizePath} = require('../../out/core/paths');

const exists=async(/** @type {string} */ file)=>fs.access(file).then(()=>true,()=>false);

test('a manual run can build with another configuration without affecting automatic runs', {timeout:300000}, async(t)=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy configuration '));
 /** @type {TestEngine | undefined} */ let engine;
 t.after(async()=>{try{await engine?.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}});
 const root=path.join(directory,'workspace');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:(/** @type {string} */ file)=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 /** @type {Required<import('../../out/core/selection').Selection>} */ let selection=/** @type {any} */ (undefined); // assigned by the selected event
 /** @type {string[]} */ const output=[];
 /** @type {import('../../out/core/model').EngineConfiguration} */ const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:120000,coverageTool:process.env.TESTY_COVERAGE_TOOL};
 engine=new TestEngine({roots:[root],storage:path.join(directory,'state'),tools:path.join(directory,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,events:{
  output:(/** @type {string} */ text)=>output.push(text),phase:()=>{},discovered:()=>{},selected:(/** @type {import('../../out/core/selection').Selection} */ value)=>{selection=/** @type {typeof selection} */ (value);},result:()=>{},started:()=>{},coverage:()=>{},invalidated:()=>{}
 }});
 const tests=path.join(root,'ImpactDemo.Tests');
 const baseline=await engine.run({files:[],full:true},t.signal);
 assert.equal(baseline.passed,3);assert.equal(baseline.coverageAvailable,true);
 assert.ok([...selection.causes.values()].every(cause=>cause.kind==='baseline'));
 assert.equal(await exists(path.join(tests,'bin','Release')),false,'the default configuration builds Debug only');
 assert.ok([...engine.coverage.traces.values()].every(trace=>trace.reliable));

 output.length=0;
 const release=await engine.run({files:[],full:false},t.signal,{all:true,groups:new Set(),coverage:true,configuration:'Release'});
 assert.equal(release.passed,3);assert.equal(release.failed,0);
 assert.equal(await exists(path.join(tests,'bin','Release')),true,'the manual run built the requested configuration');
 assert.match(output.join(''),/build configuration for this run: Release/);
 assert.ok([...selection.causes.values()].length>0&&[...selection.causes.values()].every(cause=>cause.kind==='manual'));
 assert.ok([...engine.coverage.traces.values()].every(trace=>!trace.reliable),'coverage learned under another configuration cannot narrow selection');
 assert.equal(config.configuration,'Debug','the setting is untouched');

 const arithmetic=normalizePath(path.join(root,'ImpactDemo/Arithmetic.cs'));
 output.length=0;
 const debugBin=path.join(tests,'bin','Debug');
 await fs.rm(path.join(tests,'bin','Release'),{recursive:true,force:true});
 const automatic=await engine.run({files:[arithmetic],full:false},t.signal);
 assert.equal(automatic.failed,0);
 assert.doesNotMatch(output.join(''),/build configuration for this run/);
 assert.equal(selection.groups.length,2,'unreliable traces select conservatively');
 assert.equal(await exists(path.join(tests,'bin','Release')),false,'automatic runs use testy.buildConfiguration');
 assert.equal(await exists(debugBin),true);
 assert.ok([...engine.coverage.traces.values()].every(trace=>trace.reliable),'the automatic run relearned reliable traces');
});
