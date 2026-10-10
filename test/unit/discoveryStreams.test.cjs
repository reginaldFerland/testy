const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const mtp=require('../../out/services/mtp');
const {normalizePath}=require('../../out/core/paths');


test('discovery distinguishes successful empty projects from failed streams and exits',async()=>{
 const options={dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),timeoutMs:5000};
 assert.deepEqual(await mtp.requestTests({...options,env:{TESTY_UPDATES:'[]'}},'discover'),[]);
 for(const [code,updates] of [[2,[]],[2,[{uid:'one'}]],[0,[{uid:'suite','node-type':'group','execution-state':'error','error.message':'broken discovery'}]],
  [0,[{uid:'one','execution-state':'failed'}]],[0,[{uid:'one','execution-state':'unknown-error'}]]]){
  await assert.rejects(mtp.requestTests({...options,env:{TESTY_EXIT:String(code),TESTY_UPDATES:JSON.stringify(updates)}},'discover'),/failed/);
 }
});

test('large discovery normalizes shared source paths once and yields for cancellation',async()=>{
 const {discover}=require('../../out/services/runner');
 const file=normalizePath(path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/CalculatorTests.cs'));
 const project={file:path.join(path.dirname(file),'ImpactDemo.Tests.csproj'),framework:'net10.0',assembly:'/unused/Tests.dll',sourceFiles:[file]};
 const nodes=Array.from({length:20000},(_,i)=>({uid:`row${i}`,'location.file':file}));
 const original=fs.realpathSync.native,nativeFile=path.dirname(path.resolve(file));let calls=0,ticked=false;
 fs.realpathSync.native=(...args)=>{if(args[0]===nativeFile)calls++;return original(...args);};
 try{
  setImmediate(()=>{ticked=true;});const groups=await discover(project,{},nodes);
  assert.equal(groups[0].tests.length,nodes.length);assert.equal(calls,1);assert.equal(ticked,true);
  const abort=new AbortController();setImmediate(()=>abort.abort());
  await assert.rejects(discover(project,{signal:abort.signal},nodes),{name:'AbortError'});
 }finally{fs.realpathSync.native=original;}
});
