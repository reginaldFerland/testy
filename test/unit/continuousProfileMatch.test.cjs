const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');

const summary={files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};
const token=()=>{const listeners=/** @type {(() => void)[]} */ ([]);return{isCancellationRequested:false,onCancellationRequested:(/** @type {() => void} */ listener)=>{listeners.push(listener);return{dispose(){}};},cancel:()=>{listeners.forEach(listener=>{listener();});}};};

test('with testy.runWithCoverage, a continuous Run does not receive automatic coverage runs, which keep the coverage profile',async()=>{
 const f=/** @type {any} */ (createTesty({configuration:{coverage:true}}));
 const collected=/** @type {(boolean | undefined)[]} */ ([]);
 f.testy.engine.run=async(/** @type {unknown[]} */ ...args)=>{collected.push(/** @type {boolean | undefined} */ (args[5]));return summary;};
 const run=(/** @type {unknown} */ batch)=>f.testy.execute(batch,new AbortController().signal);
 const profile=(/** @type {string} */ label)=>f.profiles.find((/** @type {{label: string}} */ item)=>item.label===label);

 const plain=token(),plainRequest={include:undefined,exclude:undefined,continuous:true,profile:profile('Run')};
 const running=profile('Run').handler(plainRequest,plain);
 await run({files:['/workspace/A.cs'],full:false});
 assert.equal(collected.at(-1),true,'the automatic run still collects the configured coverage');
 assert.notEqual(f.runs.at(-1).request,plainRequest,'coverage is not published into the Run profile, which cannot load line detail');
 assert.equal(f.runs.at(-1).request.profile,profile('Run with coverage'),'the run uses the coverage profile, which loads detailed coverage');

 const covered=token(),coverageRequest={include:undefined,exclude:undefined,continuous:true,profile:profile('Run with coverage')};
 const coverageRun=profile('Run with coverage').handler(coverageRequest,covered);
 await run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.runs.at(-1).request,coverageRequest,'a continuous coverage run receives the automatic coverage run');
 covered.cancel();await coverageRun;plain.cancel();await running;
 await f.testy.dispose();
});

test('without coverage, a continuous coverage run collects for automatic runs and a continuous Run receives them otherwise',async()=>{
 const f=/** @type {any} */ (createTesty({configuration:{coverage:false}}));
 const collected=/** @type {(boolean | undefined)[]} */ ([]);
 f.testy.engine.run=async(/** @type {unknown[]} */ ...args)=>{collected.push(/** @type {boolean | undefined} */ (args[5]));return summary;};
 const run=(/** @type {unknown} */ batch)=>f.testy.execute(batch,new AbortController().signal);
 const profile=(/** @type {string} */ label)=>f.profiles.find((/** @type {{label: string}} */ item)=>item.label===label);
 const plain=token(),plainRequest={include:undefined,exclude:undefined,continuous:true,profile:profile('Run')};
 const running=profile('Run').handler(plainRequest,plain);
 await run({files:['/workspace/A.cs'],full:false});
 assert.equal(collected.at(-1),false);assert.equal(f.runs.at(-1).request,plainRequest);
 plain.cancel();await running;
 await f.testy.dispose();
});
