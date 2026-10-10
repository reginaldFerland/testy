const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');

const summary={files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};
const token=()=>{const listeners=[];return{isCancellationRequested:false,onCancellationRequested:listener=>{listeners.push(listener);return{dispose(){}};},cancel:()=>listeners.forEach(listener=>listener())};};

function fixture(configuration={}) {
 const f=createTesty({configuration});
 const configs=[];
 f.testy.engine.run=async()=>{configs.push(f.testy.engine.options.configuration());return summary;};
 const run=(batch,...rest)=>f.testy.execute(batch,new AbortController().signal,...rest);
 return{...f,configs,run};
}

test('automatic runs are named by their trigger and files; discovery-only runs are not persisted',async()=>{
 const f=fixture();
 await f.run({files:['/workspace/src/Foo.cs'],full:false});
 await f.run({files:['/workspace/src/Foo.cs','/workspace/src/Bar.cs','/workspace/src/Baz.cs'],full:false});
 await f.run({files:[],full:true});
 await f.run({files:[],full:false},undefined,{all:true,groups:new Set(),discoverOnly:true});
 await f.testy.runAffected();
 await f.testy.runFiles([{scheme:'file',fsPath:'/workspace/src/Qux.cs'}]);
 f.testy.config.trigger='fileSystem';
 await f.run({files:['/workspace/src/Foo.cs'],full:false});
 assert.deepEqual(f.runs.map(run=>[run.name,run.persist]),[
  ['Testy · on save: Foo.cs',true],['Testy · on save: Foo.cs and 2 more',true],['Testy · baseline',true],['Testy · discover tests',false],
  ['Testy · run affected',true],['Testy · run file: Qux.cs',true],['Testy · on change: Foo.cs',true]]);
 await f.testy.dispose();
});

test('the coverage profile supports continuous runs, and automatic runs during one collect and show coverage',async()=>{
 const f=fixture({coverage:false});
 const profile=label=>f.profiles.find(item=>item.label===label);
 assert.equal(profile('Run').supportsContinuousRun,true);
 assert.equal(profile('Run with coverage').supportsContinuousRun,true);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false);assert.equal(f.runs.at(-1).request.profile,profile('Run'));

 const plain=token();
 const running=profile('Run').handler({include:undefined,exclude:undefined,continuous:true},plain);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false,'a continuous Run keeps the configured collection');

 const covered=token();
 const coverageRun=profile('Run with coverage').handler({include:undefined,exclude:undefined,continuous:true},covered);
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,true,'a continuous coverage run collects coverage');
 assert.equal(f.runs.at(-1).request.profile,profile('Run with coverage'));
 assert.equal(f.testy.engine.options.configuration().coverage,false,'only while the run is active');

 covered.cancel();await coverageRun;
 await f.run({files:['/workspace/A.cs'],full:false});
 assert.equal(f.configs.at(-1).coverage,false,'ending the coverage run restores the configured collection');
 plain.cancel();await running;
 await f.testy.dispose();
});
