// A protocol peer for transport, retry, and runtime-identity edge cases.
const net=require('node:net');
const {createMessageConnection}=require('vscode-jsonrpc/node');
const port=Number(process.argv[process.argv.indexOf('--client-port')+1]);
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
