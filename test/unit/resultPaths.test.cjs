const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');


test('terminal result classification never resolves source paths',()=>{
 const {testResult,isTerminal,assertComplete}=require('../../out/services/mtp');
 const original=fs.realpathSync.native;let calls=0;fs.realpathSync.native=(...args)=>{calls++;return original(...args);};
 try {
  const nodes=Array.from({length:1000},(_,i)=>({uid:`t${i}`,'execution-state':'passed','location.file':__filename,'location.type':'Tests','location.method':`Case${i}`}));
  for(const node of nodes){assert.ok(isTerminal(node));assert.equal(testResult(node).fullyQualifiedName,`Tests.Case${node.uid.slice(1)}`);}
  assertComplete(nodes,nodes);assert.equal(calls,0);
 }finally{fs.realpathSync.native=original;}
});
