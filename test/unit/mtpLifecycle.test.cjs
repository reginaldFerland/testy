const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {requestTests,mtpTiming}=require('../../out/services/mtp');
const base={dotnet:process.execPath,cwd:process.cwd(),timeoutMs:10_000};
const peer={...base,assembly:path.resolve('test/fixtures/mtp-peer.cjs')};
const silent={...base,assembly:path.resolve('test/fixtures/mtp-silent.cjs')};
const wrapper={command:process.execPath,args:[path.resolve('test/fixtures/mtp-wrapper.cjs')]};
const withTiming=async(changes,work)=>{const saved={...mtpTiming};Object.assign(mtpTiming,changes);try{return await work();}finally{Object.assign(mtpTiming,saved);}};

test('exit code 8 (zero tests ran) is not a host failure and reports no results',async()=>{
 const expectedTests=[{uid:'gone','display-name':'Gone'}];
 assert.deepEqual(await requestTests({...peer,expectedTests,env:{TESTY_UPDATES:'[]',TESTY_EXIT:'8'}},'run'),[]);
 await assert.rejects(requestTests({...peer,expectedTests,env:{TESTY_UPDATES:'[]',TESTY_EXIT:'7'}},'run'),/failed during run \(exit 7\)/);
 // Exit 8 does not excuse a stream that left a started test unfinished.
 await assert.rejects(requestTests({...peer,expectedTests,env:{TESTY_UPDATES:JSON.stringify([{uid:'gone','execution-state':'in-progress'}]),TESTY_EXIT:'8'}},'run'),/Incomplete test run/);
 await assert.rejects(requestTests({...peer,env:{TESTY_UPDATES:'[]',TESTY_EXIT:'8'}},'discover'),/failed during discover \(exit 8\)/);
});

test('a coverage-wrapped host gets a longer connect allowance than a plain one',async()=>{
 await withTiming({connectMs:150,wrappedConnectMs:5000},async()=>{
  await assert.rejects(requestTests({...silent},'run'),/did not connect/);
  const nodes=await requestTests({...peer,wrapper,env:{TESTY_WRAPPER_DELAY:'600',TESTY_UPDATES:JSON.stringify([{uid:'a','execution-state':'passed'}])}},'run');
  assert.equal(nodes.length,1);
 });
});

test('the connect allowance never exceeds the process timeout',async()=>{
 await withTiming({connectMs:60_000,wrappedConnectMs:60_000},async()=>{
  const started=Date.now();
  await assert.rejects(requestTests({...silent,timeoutMs:400},'run'),/did not connect|time limit/);
  assert.ok(Date.now()-started<5000);
 });
});

test('a debugged host that never reports its process ID fails after a bounded wait',async()=>{
 await withTiming({attachMs:200},async()=>{
  let attached=false;
  await assert.rejects(requestTests({...silent,debug:async()=>{attached=true;}},'run'),/did not report a process ID/);
  assert.equal(attached,false);
 });
});
