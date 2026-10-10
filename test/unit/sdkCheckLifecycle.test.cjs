const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {ensureCoverageTool}=require('../../out/services/engine/prepare');

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(condition,message)=>{for(let index=0;index<400;index++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail(message);};

/** A `dotnet` whose `--version` hangs after recording its process ID. */
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-sdk-check-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dotnet=path.join(root,'dotnet'),pidFile=path.join(root,'pid');
 await fs.writeFile(dotnet,`#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,{mode:0o755});
 const engine=new TestEngine({roots:[root],storage:path.join(root,'storage'),tools:root,analyzer:root,events:{output(){},phase(){},coverage(){}},configuration:()=>({})});
 const caller=new AbortController();
 const checking=engine.sdk.ensure(dotnet,{cwd:root,signal:caller.signal,cleanupDescendants:false,timeoutMs:60_000},'context');
 const rejected=assert.rejects(checking,{name:'AbortError'});
 let pid;await until(async()=>{try{pid=Number(await fs.readFile(pidFile,'utf8'));return pid>0;}catch{return false;}},'the SDK check did not start');
 // The caller stops waiting; the shared check keeps running for other callers.
 caller.abort();await rejected;assert.ok(alive(pid));assert.equal(engine.sdk.running.size,1);
 return{engine,pid};
}

test('disposal stops shared SDK checks and waits for their processes',{skip:process.platform==='win32',timeout:20_000},async t=>{
 const {engine,pid}=await fixture(t);
 await engine.dispose();
 assert.equal(alive(pid),false,'the check process was stopped before disposal finished');
 assert.equal(engine.sdk.running.size,0);assert.equal(engine.sdk.contexts.size,0);
});

test('reset stops shared SDK checks so none can establish a context afterwards',{skip:process.platform==='win32',timeout:20_000},async t=>{
 const {engine,pid}=await fixture(t);t.after(()=>engine.dispose());
 await engine.reset();
 assert.equal(alive(pid),false);assert.equal(engine.sdk.running.size,0);assert.equal(engine.sdk.checks.size,0);assert.equal(engine.sdk.contexts.size,0);
 assert.equal(engine.sdk.controller.signal.aborted,false,'later checks receive a fresh controller');
});

test('a configured coverage tool must be an absolute path',async t=>{
 const engine=new TestEngine({roots:[],storage:'/unused/testy-state',tools:'/unused',analyzer:'/unused',events:{output(){},phase(){}},configuration:()=>({})});
 await assert.rejects(ensureCoverageTool(engine,{coverageTool:path.join('tools','dotnet-coverage')},{cwd:os.tmpdir()}),/testy\.coverageToolPath must be an absolute path/);
 await assert.rejects(ensureCoverageTool(engine,{coverageTool:path.join(os.tmpdir(),'testy-missing-collector')},{cwd:os.tmpdir()}),{code:'ENOENT'});
 assert.equal(await ensureCoverageTool(engine,{coverageTool:process.execPath},{cwd:os.tmpdir()}),process.execPath);
 t.after(()=>engine.dispose());
});
