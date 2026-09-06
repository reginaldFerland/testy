const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {setImmediate:turn}=require('node:timers/promises');
const mtp=require('../../out/services/mtp');
const {normalizePath}=require('../../out/core/paths');
const {selectManual}=require('../../out/services/engine');

test('discovery distinguishes successful empty projects from failed streams and exits',async()=>{
 const options={dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),timeoutMs:5000};
 assert.deepEqual(await mtp.requestTests({...options,env:{TESTY_UPDATES:'[]'}},'discover'),[]);
 for(const [code,updates] of [[2,[]],[2,[{uid:'one'}]],[0,[{uid:'suite','node-type':'group','execution-state':'error','error.message':'broken discovery'}]],
  [0,[{uid:'one','execution-state':'failed'}]],[0,[{uid:'one','execution-state':'unknown-error'}]]]){
  await assert.rejects(mtp.requestTests({...options,env:{TESTY_EXIT:String(code),TESTY_UPDATES:JSON.stringify(updates)}},'discover'),/failed/);
 }
});

test('POSIX teardown still scans ownership when group signals fail or escalation is needed',async()=>{
 for(const scenario of ['normal','term','escalation']){
  const file=path.resolve('out/services/posixOwner.js'),control=new EventEmitter(),child=new EventEmitter(),signals=[],exits=[];
  child.pid=42;let scans=0,timer;
  const stderr=Object.assign(new EventEmitter(),{write(){}}),stdout=new EventEmitter();
  const fakeProcess=Object.assign(new EventEmitter(),{stdin:{},env:{},stderr,stdout,exit:code=>exits.push(code),kill:(_pid,signal)=>{
   signals.push(signal);if(signal===(scenario==='term'?'SIGTERM':'SIGKILL'))throw Object.assign(new Error('denied'),{code:'EPERM'});
  }});
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports:{},process:fakeProcess,setTimeout:callback=>{timer=callback;return 1;},clearTimeout(){},
   require:name=>name==='node:child_process'?{spawn:()=>child}:name==='node:readline'?{createInterface:()=>control}:
    name==='./posixProcesses'?{cleanupPosixOwner:async()=>{scans++;}}:createRequire(file)(name)});
  control.emit('line',JSON.stringify({command:'owned',args:[],owner:'12345678-1234-1234-1234-123456789abc',cleanupDescendants:true}));
  if(scenario==='normal')child.emit('exit',0);
  else {control.emit('close');if(scenario==='escalation')timer();}
  stdout.emit('error',Object.assign(new Error('host exited'),{code:'EPIPE'}));
  stderr.emit('error',Object.assign(new Error('host exited'),{code:'EPIPE'}));
  await turn();assert.equal(scans,1,scenario);assert.equal(exits.length,1);assert.ok(signals.includes('SIGKILL'));
 }
});

test('one denied descendant does not prevent attempts to terminate other owned descendants',async()=>{
 const file=path.resolve('out/services/posixProcesses.js'),exports={},killed=[];
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,process:{platform:'linux',pid:99,kill:pid=>{
  killed.push(pid);if(pid===10)throw Object.assign(new Error('denied'),{code:'EPERM'});
 }},require:name=>name==='node:fs/promises'?{readdir:async()=>['10','11'],readFile:async()=> 'TESTY_PROCESS_OWNER=test\0'}:createRequire(file)(name)});
 await assert.rejects(exports.cleanupPosixOwner('test'),/Unable to terminate/);assert.deepEqual(killed,[10,11]);
});

test('large discovery normalizes shared source paths once and yields for cancellation',async()=>{
 const {discover}=require('../../out/services/runner');
 const file=normalizePath(path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/CalculatorTests.cs'));
 const project={file:path.join(path.dirname(file),'ImpactDemo.Tests.csproj'),framework:'net10.0',assembly:'/unused/Tests.dll',sourceFiles:[file]};
 const nodes=Array.from({length:20000},(_,i)=>({uid:`row${i}`,'location.file':file}));
 const original=fs.realpathSync.native;let calls=0,ticked=false;
 fs.realpathSync.native=(...args)=>{if(args[0]===file)calls++;return original(...args);};
 try{
  setImmediate(()=>{ticked=true;});const groups=await discover(project,{},nodes);
  assert.equal(groups[0].tests.length,nodes.length);assert.equal(calls,1);assert.equal(ticked,true);
  const abort=new AbortController();setImmediate(()=>abort.abort());
  await assert.rejects(discover(project,{signal:abort.signal},nodes),{name:'AbortError'});
 }finally{fs.realpathSync.native=original;}
});

function runner(t,updates){
 const file=path.resolve('out/services/runner.js'),realRequire=createRequire(file),exports={},sent=[],owners=[];
 const project=normalizePath(path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/ImpactDemo.Tests.csproj'));
 const groups=['Calculator','Greeting'].map((name,i)=>({id:name,project,assembly:path.join(path.dirname(project),'Tests.dll'),framework:'net10.0',
  file:normalizePath(path.join(path.dirname(project),`${name}Tests.cs`)),tests:[mtp.discoveredTest({uid:`parent${i}`,'display-name':name,'location.type':`Class${i}`,'location.method':'Theory'})]}));
 const nodes=groups.flatMap(group=>group.tests.map(test=>test.node));
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,require:name=>name==='./mtp'?{...mtp,requestTests:async(options,operation,selected)=>{
  const requested=selected??nodes;sent.push(Array.from(requested,node=>node.uid));
  return mtp.requestTests({...options,dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),
   timeoutMs:5000,env:{TESTY_UPDATES:JSON.stringify(updates(requested,groups))}},operation,selected);
 }}:realRequire(name)});
 const session=new exports.RunnerSession({dotnet:'dotnet',storage:'.',testArguments:[],onResult:(group,result,test)=>owners.push({group,result,test})});
 session.prepared.set(`${project}\0net10.0`,{root:'.',output:{directory:'.',restore:async()=>{}},session:'fixture',coverage:false,nodes,
  nativeById:new Map(nodes.map(node=>[node.uid,node])),byKey:new Map(),groups,runs:0});
 t.after(async()=>{session.prepared.clear();await session.dispose();});return{session,groups,sent,owners};
}

test('new runtime IDs use method ownership and manually rerun the correct file',async t=>{
 const f=runner(t,nodes=>[{uid:'suite','node-type':'group','execution-state':'passed'},...nodes.map((node)=>({...node,uid:`row${node.uid.slice(-1)}`,
  'display-name':'runtime','execution-state':node.uid==='parent1'?'failed':'passed'}))]);
 await f.session.run(f.groups,new Map());
 assert.equal(f.owners.length,2,'group notifications are not test results');
 const failed=f.owners.find(entry=>entry.result.outcome==='failed');assert.equal(failed.group.id,'Greeting');
 const rerun=await f.session.run([{...failed.group,tests:[failed.test]}],new Map());
 assert.deepEqual(f.sent[1],['parent1']);assert.equal(rerun.results[0].outcome,'failed');
});

test('unmapped runtime rows have project scope, honor exclusions, and do not duplicate container runs',async t=>{
 const f=runner(t,nodes=>[...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'runtime','display-name':'unmapped','execution-state':'failed'}]);
 await f.session.run(f.groups,new Map());
 const entry=f.owners.find(entry=>entry.result.id==='runtime'),unknown=entry.group;
 assert.equal(unknown.runtimeOnly,true);assert.equal(unknown.file,undefined);
 const groups=[...f.groups,unknown],known=group=>group.runtimeOnly?[entry.test]:group.tests;
 assert.equal(selectManual(groups,{all:true,groups:new Set()},known).length,2);
 const select=exclude=>selectManual(groups,{groups:new Set([unknown.id]),exclude},known);
 let result=await f.session.run(select(),new Map());assert.deepEqual(f.sent[1],['parent0','parent1']);assert.equal(result.executedGroups.length,2);
 result=await f.session.run(select({groups:new Set(['Greeting'])}),new Map());
 assert.deepEqual(f.sent[2],['parent0']);assert.equal(result.trace.groupId,'Calculator');
 assert.equal(f.owners.at(-1).group.id,'Calculator','a single-file rerun resolves the earlier unknown owner');
 const excluded=selectManual(groups,{all:true,groups:new Set(),exclude:{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['runtime'])]])}},known);
 await assert.rejects(f.session.run(excluded,new Map()),/cannot honor an exclusion/);
});

test('ambiguous method metadata never assigns runtime rows to an arbitrary file',async t=>{
 const f=runner(t,nodes=>[...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'runtime','display-name':'unmapped','location.type':'Shared','location.method':'Theory','execution-state':'passed'}]);
 for(const group of f.groups)group.tests[0].node['location.type']='Shared';
 await f.session.run(f.groups,new Map());
 assert.equal(f.owners.find(entry=>entry.result.id==='runtime').group.runtimeOnly,true);
});

test('unmapped runtime rows appear under a project container and disappear when reattributed',async()=>{
 const file=path.resolve('out/extension.js'),realRequire=createRequire(file),exports={};
 const vscode={Uri:{file:fsPath=>({fsPath})},Range:class{},TestMessage:class{}};
 vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nexports.Testy=Testy;',{
  exports,require:name=>name==='vscode'?vscode:name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
 });
 const proto=exports.Testy.prototype,collection=()=>({values:[],replace(values){this.values=[...values];},add(value){this.values.push(value);}});
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{projects:[],knownTests:group=>group.tests},watch(){},updateStatus(){},setOutcome:proto.setOutcome,item:proto.item,
  controller:{items:collection(),createTestItem(id,label,uri){return{id,label,uri,children:collection()};}}};
 const group={id:'known',project:'/Tests.csproj',framework:'net10.0',file:'/Tests.cs',tests:[]};
 await proto.updateTree.call(context,[group]);
 const unknown={...group,id:'runtime',file:undefined,runtimeOnly:true};
 proto.publishResult.call(context,unknown,{id:'row',name:'row',outcome:'failed'});
 const container=context.items.get('file:runtime');assert.equal(container.label,'Unmapped runtime tests · net10.0');assert.equal(container.uri,undefined);
 assert.ok(context.items.get('project:/Tests.csproj').children.values.includes(container));assert.equal(context.testIds.get('runtime:row').group,'runtime');
 await proto.updateTree.call(context,[{...group,tests:[{id:'row',name:'row',file:'/Tests.cs',line:1}]}]);
 assert.equal(context.items.has('file:runtime'),false);assert.equal(context.testIds.has('runtime:row'),false);assert.equal(context.failed,0);
});
