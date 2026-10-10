// An MTP peer for host shutdown and connection edge cases.
const net=require('node:net');
const {createMessageConnection}=require('vscode-jsonrpc/node');
const port=Number(process.argv[process.argv.indexOf('--client-port')+1]);
// A second connection stands in for another local process racing the real host.
if(process.env.TESTY_EXTRA_CONNECTION==='1'){const extra=net.connect(port,'127.0.0.1');extra.on('error',()=>undefined);}
const socket=net.connect(port,'127.0.0.1');
const rpc=createMessageConnection(socket,socket);
const updates=JSON.parse(process.env.TESTY_UPDATES||'[]');
rpc.onRequest('initialize',()=>({capabilities:{testing:{supportsDiscovery:true}}}));
for(const method of ['testing/runTests','testing/discoverTests']) {
 rpc.onRequest(method,async({runId})=>{
  for(const node of updates) await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:[{node}]});
  await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:null});return {};
 });
}
rpc.onNotification('exit',()=>{
 rpc.dispose();socket.end();
 // A lingering foreground thread keeps the host alive after every result was sent.
 if(process.env.TESTY_LINGER==='1') setInterval(()=>undefined,1000);
});
rpc.listen();
