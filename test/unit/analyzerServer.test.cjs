// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {AnalyzerServers,AnalyzerServerUnavailable,AnalyzerRequestFailed}=require('../../out/services/analyzerServer');
const {sourceAliases,disposeAnalyzerServers}=require('../../out/services/analysis');

const peer=path.resolve('test/fixtures/analyzer-server-peer.cjs'),node=process.execPath;
const alive=(/** @type {number} */pid)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const until=async(/** @type {() => unknown} */condition,/** @type {string} */message)=>{for(let index=0;index<200;index++){if(await condition())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail(message);};
const send=(/** @type {InstanceType<typeof AnalyzerServers>} */servers,/** @type {string} */mode,options={},extra={})=>servers.request(node,peer,JSON.stringify({mode,...extra}),{cwd:os.tmpdir(),...options}).then(JSON.parse);

test('one server answers concurrent requests by id, resolves relative paths from the request cwd and shares its process',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const results=await Promise.all([1,2,3,4].map(index=>send(servers,'echo',{},{index})));
 assert.deepEqual(results.map(result=>result.request.index),[1,2,3,4]);
 assert.equal(new Set(results.map(result=>result.pid)).size,1);
 assert.equal(servers.size,1);
 assert.equal(results[0].cwd,path.resolve(os.tmpdir()));
});

test('servers are keyed by working directory and environment, and replaced when the helper file changes',async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-server-key-')));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const helper=path.join(directory,'peer.cjs');await fs.copyFile(peer,helper);
 const ask=(options={},/** @type {string|undefined} */identity=undefined)=>servers.request(node,helper,JSON.stringify({mode:'echo'}),{cwd:directory,...options},identity).then(JSON.parse);
 const first=await ask(),again=await ask();
 assert.equal(first.pid,again.pid);
 const other=await ask({cwd:os.tmpdir()}),marked=await ask({env:{PEER_MARK:'a'}}),changed=await ask({env:{PEER_MARK:'b'}});
 // An outside identity, such as the SDK's Roslyn, separates servers too.
 const sdkA=await ask({},'sdk A'),sdkB=await ask({},'sdk B');
 assert.equal((await ask({},'sdk A')).pid,sdkA.pid);
 assert.equal(new Set([first.pid,other.pid,marked.pid,changed.pid,sdkA.pid,sdkB.pid]).size,6);
 assert.equal(marked.env,'a');assert.equal(changed.env,'b');
 await fs.appendFile(helper,'\n// rebuilt\n');
 const rebuilt=await ask();
 assert.notEqual(rebuilt.pid,first.pid);
});

test('an aborted request rejects at once, is cancelled in the server, and later requests use the same process',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 const abort=new AbortController(),slow=send(servers,'slow',{signal:abort.signal},{ms:30_000});
 await new Promise(resolve=>setTimeout(resolve,100));
 const started=Date.now();abort.abort();
 await assert.rejects(slow,{name:'AbortError'});
 // The slow request would take 30s; the bound only proves the abort did not wait for it.
 assert.ok(Date.now()-started<15_000);
 // The stale acknowledgement must not complete or confuse the next request.
 const next=await send(servers,'echo');
 assert.equal(next.pid,pid);
 assert.equal(servers.size,1);
 const before=new AbortController();before.abort();
 await assert.rejects(send(servers,'echo',{signal:before.signal}),{name:'AbortError'});
 assert.equal((await send(servers,'echo')).pid,pid);
});

test('a server that ignores a cancel is replaced instead of poisoning the next request',async t=>{
 const servers=new AnalyzerServers({cancelMs:150});t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 const abort=new AbortController(),stubborn=send(servers,'slow',{signal:abort.signal},{ms:30_000,stubborn:true});
 await new Promise(resolve=>setTimeout(resolve,100));abort.abort();
 await assert.rejects(stubborn,{name:'AbortError'});
 await until(()=>!alive(pid),'the unresponsive server was not stopped');
 const next=await send(servers,'echo');
 assert.notEqual(next.pid,pid);
 // The old server's late answer cannot be attributed to the new one.
 assert.equal(next.request.mode,'echo');
});

test('an abort while the server is starting rejects without sending the request',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const abort=new AbortController(),pending=send(servers,'echo',{signal:abort.signal});
 abort.abort();
 await assert.rejects(pending,{name:'AbortError'});
 assert.equal((await send(servers,'echo')).request.mode,'echo');
});

test('a crash fails the request as unavailable and the next request starts a fresh server',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await assert.rejects(send(servers,'crash'),error=>error instanceof AnalyzerServerUnavailable&&/exited unexpectedly \(3\)/.test(error.message));
 await until(()=>servers.size===0,'the crashed server stayed registered');
 const next=await send(servers,'echo');
 assert.notEqual(next.pid,pid);
});

test('errors reported by the analyzer keep the server and its message',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await assert.rejects(send(servers,'fail'),error=>error instanceof AnalyzerRequestFailed&&error.message==='boom\nwith lines');
 assert.equal((await send(servers,'echo')).pid,pid);
});

test('protocol violations stop the server and report it unavailable',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await assert.rejects(send(servers,'garbage'),AnalyzerServerUnavailable);
 await until(()=>!alive(pid),'the misbehaving server kept running');
});

test('a response line beyond the length limit stops the server instead of buffering without bound',async t=>{
 const servers=new AnalyzerServers({maxLineLength:256*1024});t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await assert.rejects(send(servers,'unterminated'),error=>error instanceof AnalyzerServerUnavailable&&/longer than 262144 characters/.test(error.message));
 await until(()=>!alive(pid),'the overflowing server kept running');
 assert.equal(servers.size,0);
});

test('requests that cannot be one line are not sent',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 await assert.rejects(servers.request(node,peer,'{"mode":\n"echo"}',{cwd:os.tmpdir()}),AnalyzerServerUnavailable);
});

test('a request exceeding its time limit replaces the server',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await assert.rejects(send(servers,'hang',{timeoutMs:150}),/exceeded its time limit/);
 await until(()=>!alive(pid),'the stuck server kept running');
 assert.notEqual((await send(servers,'echo')).pid,pid);
});

test('start failures are reported, then not retried until the retry window passes',async t=>{
 const servers=new AnalyzerServers({retryMs:300,startupMs:200});t.after(()=>servers.dispose());
 for(const start of ['exit','noise','silent']){
  const env={PEER_START:start};
  await assert.rejects(send(servers,'echo',{env}),AnalyzerServerUnavailable,start);
  await assert.rejects(send(servers,'echo',{env}),/failed to start recently/,start);
 }
 await assert.rejects(servers.request('testy-missing-dotnet-host',peer,'{}',{cwd:os.tmpdir()}),AnalyzerServerUnavailable);
 // Poll until the retry window has passed instead of sleeping a fixed time.
 await until(async()=>{
  const error=await send(servers,'echo',{env:{PEER_START:'exit'}}).then(()=>undefined,reason=>reason);
  assert.ok(error,'the exiting host cannot answer');
  return /exited unexpectedly \(7\)/.test(error.message);
 },'a start was not retried after the retry window');
 assert.equal(servers.size,0);
});

test('an idle server shuts down by itself and the next request starts another',async t=>{
 const servers=new AnalyzerServers({idleMs:1000});t.after(()=>servers.dispose());
 const {pid}=await send(servers,'echo');
 await until(()=>servers.size===0&&!alive(pid),'the idle server was not stopped');
 const next=await send(servers,'echo');
 assert.notEqual(next.pid,pid);
 // Activity keeps it alive.
 for(let index=0;index<4;index++){await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await send(servers,'echo')).pid,next.pid);}
});

test('a request waiting on a server stopped on purpose is retried on a new one',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const pending=send(servers,'slow',{},{ms:1500});
 await until(()=>servers.size===1,'the server did not start');
 await new Promise(resolve=>setTimeout(resolve,100));
 await servers.dispose();
 assert.equal(await pending,'done');
 assert.equal(servers.size,1);
});

test('disposal stops every server and waits for the processes to exit',async t=>{
 const servers=new AnalyzerServers();t.after(()=>servers.dispose());
 const pids=(await Promise.all([{PEER_MARK:'1'},{PEER_MARK:'2'}].map(env=>send(servers,'echo',{env})))).map(result=>result.pid);
 assert.equal(servers.size,2);
 await servers.dispose();
 assert.equal(servers.size,0);
 assert.deepEqual(pids.map(alive),[false,false]);
 assert.notEqual((await send(servers,'echo')).pid,pids[0]);
});

test('the number of servers is bounded and the least recently used idle one is stopped',async t=>{
 const servers=new AnalyzerServers({limit:2});t.after(()=>servers.dispose());
 const first=await send(servers,'echo',{env:{PEER_MARK:'1'}});
 await send(servers,'echo',{env:{PEER_MARK:'2'}});
 await send(servers,'echo',{env:{PEER_MARK:'3'}});
 assert.equal(servers.size,2);
 await until(()=>!alive(first.pid),'the least recently used server was kept');
});

test('analysis falls back to a one-shot process when the server cannot start or breaks, and surfaces its failures',async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-server-fallback-')));
 t.after(async()=>{await disposeAnalyzerServers();await fs.rm(directory,{recursive:true,force:true});});
 const options={cwd:directory};
 // The server path answers first.
 assert.deepEqual(await sourceAliases(node,peer,['x'],directory,options),['server']);
 // A host that cannot serve falls back, and a short-lived process turns TieredPGO off.
 assert.deepEqual(await sourceAliases(node,peer,['x'],directory,{...options,env:{PEER_START:'exit'}}),['one-shot','0']);
 // A crash during a request falls back for that call, and the server recovers for the next.
 assert.deepEqual(await sourceAliases(node,peer,['crash'],directory,options),['one-shot','0']);
 assert.deepEqual(await sourceAliases(node,peer,['x'],directory,options),['server']);
 // The one-shot process still reports its own failures.
 await assert.rejects(sourceAliases(node,peer,['fallback-fail'],directory,{...options,env:{PEER_START:'exit'}}),/Analyzing global C# aliases failed \(exit 1\)[\s\S]*one-shot failed/);
 // Analyzer errors are not retried through another process.
 await assert.rejects(sourceAliases(node,peer,['fail'],directory,options),/Analyzing global C# aliases failed\.\nboom\nwith lines/);
 assert.deepEqual((await fs.readdir(directory)),[]);
 const abort=new AbortController();abort.abort();
 await assert.rejects(sourceAliases(node,peer,['x'],directory,{...options,signal:abort.signal}),{name:'AbortError'});
});
