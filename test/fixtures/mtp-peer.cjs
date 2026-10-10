// A protocol peer for transport, retry, and runtime-identity edge cases.
const net=require('node:net');
const {createMessageConnection}=require('vscode-jsonrpc/node');
const port=Number(process.argv[process.argv.indexOf('--client-port')+1]);
// Like MTP with TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1: report the PID, then wait for
// the "debugger" (here, a marker file written by the test) before connecting.
if(process.env.TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER==='1'){
 console.log(`Waiting for debugger to attach... Process Id: ${process.pid}, Name: testhost`);
 const fs=require('node:fs'),started=Date.now();
 while(!fs.existsSync(process.env.TESTY_ATTACHED_FILE)&&Date.now()-started<10000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
}
const socket=net.connect(port,'127.0.0.1');
const rpc=createMessageConnection(socket,socket);
const updates=JSON.parse(process.env.TESTY_UPDATES||'[]');
rpc.onRequest('initialize',()=>({capabilities:{testing:{supportsDiscovery:true}}}));
for(const method of ['testing/runTests','testing/discoverTests']) {
 rpc.onRequest(method,async({runId})=>{
  if(process.env.TESTY_HANG==='1') await new Promise(()=>{});
  if(process.env.TESTY_EXIT_DURING){console.error('controlled process failure');process.exit(Number(process.env.TESTY_EXIT_DURING));}
  for(const node of updates) await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:[{node}]});
  await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:null});return {};
 });
}
rpc.onNotification('exit',()=>{rpc.dispose();socket.end();process.exitCode=Number(process.env.TESTY_EXIT||0);});
rpc.listen();
