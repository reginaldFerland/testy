const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');

const summary={files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};
const token=()=>{
 /** @type {(() => void)[]} */ const listeners=[];return{isCancellationRequested:false,onCancellationRequested:(/** @type {() => void} */ listener)=>{listeners.push(listener);return{dispose(){}};},cancel:()=>listeners.forEach(listener=>listener())};};

function fixture(configuration={}) {
 const f=createTesty({configuration});
 /** @type {any[]} Recorded configuration snapshots (any: `.at(-1)` is read directly). */ const configs=[];
 f.testy.engine.run=async(/** @type {unknown} */ _batch,/** @type {unknown} */ _signal,/** @type {unknown} */ _manual,/** @type {unknown} */ _operation,/** @type {unknown} */ _scope,/** @type {boolean|undefined} */ coverage)=>{const configured=f.testy.engine.options.configuration();configs.push({...configured,coverage:coverage??configured.coverage});return summary;};
 const run=(/** @type {import('../../out/core/scheduler').ChangeBatch} */ batch,/** @type {any[]} */ ...rest)=>f.testy.execute(batch,new AbortController().signal,...rest);
 return{...f,configs,run};
}

test('automatic runs are named by their trigger and files; discovery-only runs are not persisted',async()=>{
 const f=fixture();
 await f.run({files:['/workspace/src/Foo.cs'],full:false});
 await f.run({files:['/workspace/src/Foo.cs','/workspace/src/Bar.cs','/workspace/src/Baz.cs'],full:false});
 await f.run({files:[],full:true});
 await f.run({files:[],full:false},{manual:{all:true,groups:new Set(),discoverOnly:true}});
 await f.testy.runAffected();
 await f.testy.runFiles([{scheme:'file',fsPath:'/workspace/src/Qux.cs'}]);
 f.testy.config.trigger='fileSystem';
 await f.run({files:['/workspace/src/Foo.cs'],full:false});
 assert.deepEqual(f.runs.map(run=>[run.name,run.persist]),[
  ['Testy · on save: Foo.cs',true],['Testy · on save: Foo.cs and 2 more',true],['Testy · baseline',true],['Testy · discover tests',false],
  ['Testy · run affected',true],['Testy · run file: Qux.cs',true],['Testy · on change: Foo.cs',true]]);
 await f.testy.dispose();
});

test('the coverage profile supports continuous runs, and automatic runs during one collect coverage and report into it',async()=>{
 const f=fixture({coverage:false});
 const profile=(/** @type {string} */ label)=>f.profiles.find(item=>item.label===label);
 assert.equal(profile('Run').supportsContinuousRun,true);
 assert.equal(profile('Run with coverage').supportsContinuousRun,true);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false);assert.equal(f.runs.at(-1).request.profile,profile('Run'));

 const plain=token();
 const plainRequest={include:undefined,exclude:undefined,continuous:true,profile:profile('Run')};
 const running=profile('Run').handler(plainRequest,plain);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false,'a continuous Run keeps the configured collection');
 assert.equal(f.runs.at(-1).request,plainRequest,'automatic results are tied to the continuous run');

 const covered=token();
 const coverageRequest={include:undefined,exclude:undefined,continuous:true,profile:profile('Run with coverage')};
 const coverageRun=profile('Run with coverage').handler(coverageRequest,covered);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,true,'a continuous coverage run collects coverage');
 assert.equal(f.runs.at(-1).request,coverageRequest,'the continuous run of the matching profile receives the results');
 assert.equal(f.testy.engine.options.configuration().coverage,false,'only while the run is active');

 covered.cancel();await coverageRun;
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false,'ending the coverage run restores the configured collection');
 assert.equal(f.runs.at(-1).request,plainRequest);
 plain.cancel();await running;
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.runs.at(-1).request.continuous,undefined,'without a continuous run, automatic runs get their own request');
 await f.testy.dispose();
});
