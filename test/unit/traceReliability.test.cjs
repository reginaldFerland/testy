const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isReliableTrace}=require('../../out/core/traceReliability');

/** @typedef {import('../../out/core/traceReliability').TraceEvidence} TraceEvidence */
/** @type {NonNullable<TraceEvidence['file']>} */
const file={file:'/w/Tests.cs',tests:/** @type {any} */ ([{id:'a'},{id:'b'}])}; // partial mock: only the ids are read
/** @type {TraceEvidence['coverage']} */
const hit=[{lines:[{line:1,hits:0},{line:2,hits:3}]}];
/** @param {Partial<TraceEvidence>} [changes]
 * @returns {TraceEvidence} */
const evidence=(changes={})=>({file,coverageAvailable:true,observed:true,coverage:hit,results:[{id:'a',outcome:'passed'},{id:'b',outcome:'passed'}],...changes});

test('a passing, fully reported and covered file run is a reliable trace',()=>{
 assert.equal(isReliableTrace(evidence()),true);
});

test('skipped tests do not make a file run unreliable',()=>{
 assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'passed'},{id:'b',outcome:'skipped'}]})),true);
 assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'skipped'},{id:'b',outcome:'skipped'}]})),true,'coverage hits still exist');
 assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'skipped'},{id:'b',outcome:'skipped'}],coverage:[{lines:[{line:1,hits:0}]}]})),false);
});

test('failed and errored (including timed-out) results stay unreliable',()=>{
 for(const outcome of /** @type {const} */ (['failed','errored'])){
  assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'passed'},{id:'b',outcome}]})),false,outcome);
  assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'skipped'},{id:'b',outcome}]})),false,outcome);
 }
});

test('every expected test must be reported and coverage, observation and a source file are required',()=>{
 assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'passed'}]})),false,'a missing expected result');
 assert.equal(isReliableTrace(evidence({results:[{id:'a',outcome:'passed'},{id:'b',outcome:'passed'},{id:'runtime-row',outcome:'skipped'}]})),true,'extra runtime rows are allowed');
 assert.equal(isReliableTrace(evidence({coverageAvailable:false})),false);
 assert.equal(isReliableTrace(evidence({observed:false})),false);
 assert.equal(isReliableTrace(evidence({coverage:[]})),false);
 assert.equal(isReliableTrace(evidence({file:undefined})),false,'a batch of several files or a project');
 assert.equal(isReliableTrace(evidence({file:{...file,file:undefined}})),false,'runtime-only rows');
});
