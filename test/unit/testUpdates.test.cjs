const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mergeTestUpdate}=require('../../out/core/testUpdates');
const {testResult}=require('../../out/services/mtp');
const failed={uid:'rows','execution-state':'failed','error.message':'row one failed'};
test('a subsequent passing row cannot turn a failed shared UID green',()=>{
 const result=mergeTestUpdate(failed,{uid:'rows','execution-state':'passed'});
 assert.equal(testResult(result).outcome,'failed');
 assert.equal(testResult(result).message,'row one failed');
});
test('explicit retry attempts replace superseded failures and clear their errors',()=>{
 const superseded=mergeTestUpdate(failed,{uid:'rows','retry.attempt':1,'retry.is-superseded':true});
 assert.equal(testResult(superseded),undefined);
 const passed=mergeTestUpdate(superseded,{uid:'rows','retry.attempt':2,'retry.is-superseded':false,'execution-state':'passed'});
 assert.equal(testResult(passed).outcome,'passed');assert.equal(testResult(passed).message,undefined);
 assert.deepEqual(mergeTestUpdate(passed,{...failed,'retry.attempt':1}),passed);
});
test('metadata-only updates retain the terminal outcome',()=>{
 assert.equal(testResult(mergeTestUpdate(failed,{uid:'rows','time.duration-ms':12})).outcome,'failed');
});
