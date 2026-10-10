// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {requestTests,mtpTiming}=require('../../out/services/mtp');
const base={dotnet:process.execPath,cwd:process.cwd(),timeoutMs:10_000};
const peer={...base,assembly:path.resolve('test/fixtures/mtp-peer.cjs')};
const silent={...base,assembly:path.resolve('test/fixtures/mtp-silent.cjs')};
const wrapper={command:process.execPath,args:[path.resolve('test/fixtures/mtp-wrapper.cjs')]};
const withTiming=async(/** @type {Record<string,number>} */changes,/** @type {() => Promise<unknown>} */work)=>{const saved={...mtpTiming};Object.assign(mtpTiming,changes);try{return await work();}finally{Object.assign(mtpTiming,saved);}};

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
  assert.ok(Date.now()-started<30_000);
 });
});

test('a debugged host that never reports its process ID fails after a bounded wait',async()=>{
 await withTiming({attachMs:200},async()=>{
  let attached=false;
  await assert.rejects(requestTests({...silent,debug:async()=>{attached=true;}},'run'),/did not report a process ID/);
  assert.equal(attached,false);
 });
});

test('attachment notifications are reported as output lines; the client reports the extension version',()=>{
 const {attachmentLines}=require('../../out/services/mtp'),{extensionVersion}=require('../../out/services/assets');
 const file=require('node:url').pathToFileURL(path.resolve('trx/results.trx')).href;
 assert.deepEqual(attachmentLines([{uri:file,'display-name':'Results',producer:'TrxReport',description:'TRX'},{uri:'https://x/y'},{description:'no uri'}]),
  [`Attachment Results: ${path.resolve('trx/results.trx')} (TrxReport: TRX)`,'Attachment: https://x/y']);
 assert.deepEqual(attachmentLines(null),[]);
 assert.equal(extensionVersion(),require('../../package.json').version);
});

test('only a closed connection is tolerated when saying goodbye after the final update',()=>{
 const {connectionClosed}=require('../../out/services/mtp'),{ConnectionError,ConnectionErrors}=require('vscode-jsonrpc/node');
 assert.equal(connectionClosed(new ConnectionError(ConnectionErrors.Closed,'closed')),true);
 assert.equal(connectionClosed(new ConnectionError(ConnectionErrors.Disposed,'disposed')),true);
 assert.equal(connectionClosed(new ConnectionError(ConnectionErrors.AlreadyListening,'listening')),false);
 assert.equal(connectionClosed(Object.assign(new Error('write'),{code:'EPIPE'})),true);
 assert.equal(connectionClosed(Object.assign(new Error('write'),{code:'ERR_STREAM_DESTROYED'})),true);
 assert.equal(connectionClosed(Object.assign(new Error('disk'),{code:'EACCES'})),false);
 assert.equal(connectionClosed(new Error('unrelated')),false);assert.equal(connectionClosed(undefined),false);
});

test('commands are resolved once each and the connect allowance starts only afterwards',async()=>{
 const executable=require('../../out/services/executable'),original=executable.resolveOwnedCommand,resolved=/** @type {string[]} */ ([]);
 /** @type {any} */ (executable).resolveOwnedCommand=async(/** @type {string} */ command,/** @type {any} */ env,/** @type {string} */ cwd)=>{resolved.push(command);await new Promise(done=>setTimeout(done,2000));return original(command,env,cwd);};
 try{
  // The allowance is shorter than the (deliberately slow) resolution, which it must not include,
  // yet long enough for a loaded machine to start the peer.
  await withTiming({connectMs:1500},async()=>{
   const nodes=await requestTests({...peer,dotnetHost:process.execPath,env:{TESTY_UPDATES:JSON.stringify([{uid:'a','execution-state':'passed'}])}},'run');
   assert.equal(nodes.length,1);
  });
  assert.deepEqual(resolved,[process.execPath]);
 }finally{/** @type {any} */ (executable).resolveOwnedCommand=original;}
});
