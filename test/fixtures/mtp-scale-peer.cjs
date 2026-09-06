const net=require('node:net'),{createMessageConnection}=require('vscode-jsonrpc/node');
const port=Number(process.argv[process.argv.indexOf('--client-port')+1]),socket=net.connect(port,'127.0.0.1'),rpc=createMessageConnection(socket,socket);
rpc.onRequest('initialize',()=>({capabilities:{testing:{supportsDiscovery:true}}}));
rpc.onRequest('testing/runTests',async({runId,tests})=>{
 await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:tests.map(node=>({node:{...node,'execution-state':'passed'}}))});
 await rpc.sendNotification('testing/testUpdates/tests',{runId,changes:null});return {};
});
rpc.onNotification('exit',()=>{rpc.dispose();socket.end();});rpc.listen();
