const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');


test('terminal result classification never resolves source paths',()=>{
 const {testResult,isTerminal,assertComplete}=require('../../out/services/mtp');
 /** @type {any} */ const realpathSync=fs.realpathSync; // widened: native is a typed overload set and the spy forwards arbitrary arguments
 const original=realpathSync.native;let calls=0;realpathSync.native=(/** @type {any[]} */ ...args)=>{calls++;return original(...args);};
 try {
  const nodes=Array.from({length:1000},(_,i)=>({uid:`t${i}`,'execution-state':'passed','location.file':__filename,'location.type':'Tests','location.method':`Case${i}`}));
  for(const node of nodes){assert.ok(isTerminal(node));assert.equal(/** @type {import('../../out/core/model').TestResult} */ (testResult(node)).fullyQualifiedName,`Tests.Case${node.uid.slice(1)}`);}
  assertComplete(nodes,nodes);assert.equal(calls,0);
 }finally{realpathSync.native=original;}
});
