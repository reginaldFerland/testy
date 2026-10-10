const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');

const plain=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

/** A controller whose startup only records baseline requests and prompts. */
function fixture({answer,state={},traces=0,configuration={}}={}) {
 const prompts=[];
 const f=createTesty({configuration,api:{extensions:{getExtension:()=>undefined}},window:{showInformationMessage:async(message,...actions)=>{prompts.push({message,actions});return answer?.(actions);}}});
 const requested=[];
 f.testy.engine.restore=async()=>undefined;
 if(traces)Object.defineProperty(f.testy.engine.coverage,'traces',{value:new Map(Array.from({length:traces},(_,i)=>[`g${i}`,{}]))});
 f.testy.scheduler.request=(...args)=>requested.push(args);
 const workspaceState=f.testy.context.workspaceState;
 for(const [key,value] of Object.entries(state))void workspaceState.update(key,value);
 return{...f,prompts,requested,workspaceState};
}

test('the first open of a workspace asks before building the baseline; Run Now starts it and is remembered',async()=>{
 const f=fixture({answer:actions=>actions[0]});
 await f.testy.start();await tick();await tick();
 assert.equal(f.prompts.length,1);
 assert.deepEqual([...f.prompts[0].actions],['Run Now','Not Now','Don\'t Ask Again']);
 assert.deepEqual(plain(f.requested),[[[],true]]);
 assert.equal(f.workspaceState.get('testy.baselineConsent'),'always');
 assert.equal(f.testy.snapshot().awaitingBaseline,false);
 await f.testy.dispose();
});

test('Not Now waits for a save or a manual run and asks again next time; Don\'t Ask Again stops asking',async()=>{
 const later=fixture({answer:actions=>actions[1]});
 await later.testy.start();await tick();await tick();
 assert.deepEqual(later.requested,[]);
 assert.equal(later.workspaceState.get('testy.baselineConsent'),undefined);
 assert.equal(later.testy.snapshot().awaitingBaseline,true);
 await later.testy.dispose();

 const never=fixture({answer:actions=>actions[2]});
 await never.testy.start();await tick();await tick();
 assert.deepEqual(never.requested,[]);
 assert.equal(never.workspaceState.get('testy.baselineConsent'),'manual');
 await never.testy.dispose();

 const quiet=fixture({state:{'testy.baselineConsent':'manual'}});
 await quiet.testy.start();await tick();
 assert.equal(quiet.prompts.length,0);assert.deepEqual(quiet.requested,[]);
 await quiet.testy.dispose();
});

test('workspaces with retained coverage, earlier consent or a paused state start as before without asking',async()=>{
 for(const options of [{traces:2},{state:{'testy.baselineConsent':'always'}},{configuration:{enabled:false}}]) {
  const f=fixture(options);
  await f.testy.start();await tick();
  assert.equal(f.prompts.length,0,JSON.stringify(options));
  assert.deepEqual(plain(f.requested),[[[],true]],JSON.stringify(options));
  await f.testy.dispose();
 }
});

test('a run that starts while the question is open settles it, so a late answer does not start a second baseline',async()=>{
 let answer;
 const f=fixture({answer:actions=>new Promise(resolve=>{answer=()=>resolve(actions[0]);})});
 f.testy.engine.run=async()=>({files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:false});
 await f.testy.start();await tick();
 assert.equal(f.testy.snapshot().awaitingBaseline,true);
 await f.testy.execute({files:['/workspace/A.cs'],full:false},new AbortController().signal);
 assert.equal(f.testy.snapshot().awaitingBaseline,false);
 answer();await tick();await tick();
 assert.deepEqual(f.requested,[]);
 await f.testy.dispose();
});

test('setting changes do not start a baseline the user has not agreed to',async()=>{
 let changed;
 const f=createTesty({api:{extensions:{getExtension:()=>undefined}},window:{showInformationMessage:async()=>undefined},
  workspace:{onDidChangeConfiguration:handler=>{changed=handler;return{dispose(){}};}}});
 const requested=[];
 f.testy.engine.restore=async()=>undefined;f.testy.scheduler.request=(...args)=>requested.push(args);
 await f.testy.start();await tick();
 changed({affectsConfiguration:key=>key==='testy'||key==='testy.solution'});
 assert.deepEqual(requested,[]);
 f.testy.engine.run=async()=>({files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:false});
 await f.testy.execute({files:['/workspace/A.cs'],full:false},new AbortController().signal);
 changed({affectsConfiguration:key=>key==='testy'||key==='testy.solution'});
 assert.equal(requested.length,1,'after the first run, setting changes rerun as before');
 await f.testy.dispose();
});
