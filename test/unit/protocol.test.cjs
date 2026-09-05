const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {requestTests,testResult}=require('../../out/services/mtp');

test('MTP transport preserves explicit retry outcomes and rejects inconsistent failure exits',async()=>{
 const options={dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),timeoutMs:5000};
 const updates=[{uid:'row','execution-state':'failed','error.message':'old','retry.attempt':1,'retry.is-superseded':true},
  {uid:'row','execution-state':'passed','retry.attempt':2,'retry.is-superseded':false}];
 const nodes=await requestTests({...options,env:{TESTY_UPDATES:JSON.stringify(updates)}},'run');
 assert.equal(testResult(nodes[0]).outcome,'passed');assert.equal(testResult(nodes[0]).message,undefined);
 await assert.rejects(requestTests({...options,env:{TESTY_UPDATES:JSON.stringify([{uid:'row','execution-state':'passed'}]),TESTY_EXIT:'2'}},'run'),/cannot be reported as passing/);
 await assert.rejects(requestTests({...options,env:{TESTY_UPDATES:JSON.stringify([{uid:'suite','node-type':'group','execution-state':'failed'}])}},'run'),/test group failed/);
 const runtime=await requestTests({...options,env:{TESTY_UPDATES:JSON.stringify([{uid:'only-at-runtime','execution-state':'passed','location.file':'/workspace/Test.cs'}])}},'run',[{uid:'parent'}]);
 assert.equal(runtime[0].uid,'only-at-runtime');assert.ok(testResult(runtime[0]).node);
});

function uiPrototype() {
 const file=path.resolve('out/extension.js'), realRequire=createRequire(file), exports={};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nexports.Testy=Testy;',{
  exports,require:name=>name==='vscode'||name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
 });
 return exports.Testy.prototype;
}

test('save-mode directory events expand known paths and trigger structural discovery',async()=>{
 const proto=uiPrototype(), requested=[], marked=[];
 const root=require('../../out/core/paths').normalizePath(path.resolve(require('node:os').tmpdir(),'testy-ui-workspace'));
 const context={disposed:false,roots:[root],config:{excludes:[],pattern:'**/*.{cs,csproj}',mode:'affected'},
  engine:{knownFiles:[`${root}/Tests/Feature/FeatureTests.cs`],select:()=>({groups:[]}),markChanged:async files=>marked.push([...files])},
  scheduler:{request:(files,full)=>requested.push({files:[...files],full})},controller:{invalidateTestResults:()=>{}},items:new Map()};
 await proto.changed.call(context,{scheme:'file',fsPath:`${root}/Tests/Feature`},undefined,true);
 assert.equal(requested.length,1);assert.equal(requested[0].full,true);
 assert.deepEqual(requested[0].files,[`${root}/Tests/Feature/FeatureTests.cs`,`${root}/Tests/Feature`]);
 assert.deepEqual(marked[0],requested[0].files);
});

test('runtime-only result IDs are registered and selected for manual reruns',async()=>{
 const proto=uiPrototype();let selected;
 const item={id:'file:runtime',children:{forEach:()=>{}}};
 const context={disposed:false,items:new Map([['file:runtime',item]]),testIds:new Map(),setOutcome:()=>{},updateStatus:()=>{},
  scheduler:{runManual:async callback=>callback(new AbortController().signal)},bindCancellation:()=>({controller:new AbortController(),dispose:()=>{}}),
  execute:async(_batch,_signal,_request,selection)=>selected=selection};
 proto.publishResult.call(context,{id:'file',file:'/workspace/Test.cs'},{id:'runtime',name:'Runtime case',outcome:'passed'});
 await proto.manual.call(context,{include:[item]},{},false);
 assert.equal(selected.groups.has('file'),true);assert.equal(selected.tests.get('file').has('runtime'),true);
});

test('Windows cancellation waits for taskkill completion before releasing the owned run',async()=>{
 const file=path.resolve('out/services/process.js'), exports={}, processes=[];
 function spawn(command,args) {
  const child=new EventEmitter();Object.assign(child,{pid:100,stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>{}});
  processes.push({command,args,child});return child;
 }
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,require:()=>({spawn}),process:{platform:'win32',env:{}},setTimeout,clearTimeout});
 const abort=new AbortController(), owned=exports.startProcess('dotnet',['test'],{cwd:'.',signal:abort.signal});
 let settled=false;const done=owned.done.catch(error=>{settled=true;assert.equal(error.name,'AbortError');});
 abort.abort();assert.equal(processes[1].command,'taskkill');assert.ok(processes[1].args.includes('/T'));
 processes[0].child.emit('close',1);await Promise.resolve();assert.equal(settled,false);
 processes[1].child.emit('close',0);await done;assert.equal(settled,true);
});
