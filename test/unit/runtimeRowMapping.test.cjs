const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const mtp=require('../../out/services/mtp');
const {normalizePath}=require('../../out/core/paths');
const {selectManual}=require('../../out/services/engine');
const {loadUi}=require('./support/ui.cjs');

/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/services/mtp').TestNode} Node */
/** @typedef {import('../../out/services/engine/types').ManualSelection} ManualSelection */
/** @param {import('node:test').TestContext} t @param {(requested: readonly Node[], groups: TestFile[]) => unknown[]} updates */
function runner(t,updates){
 /** @type {Record<string, any>} */ const exports={};
 /** @type {string[][]} */ const sent=[];
 /** @type {{group: TestFile, result: import('../../out/core/model').TestResult, test: import('../../out/core/model').DiscoveredTest}[]} */ const owners=[];
 const file=path.resolve('out/services/runner.js'),realRequire=createRequire(file);
 const project=normalizePath(path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/ImpactDemo.Tests.csproj'));
 const groups=['Calculator','Greeting'].map((name,i)=>({id:name,project,assembly:path.join(path.dirname(project),'Tests.dll'),framework:'net10.0',
  file:normalizePath(path.join(path.dirname(project),`${name}Tests.cs`)),tests:[mtp.discoveredTest({uid:`parent${i}`,'display-name':name,'location.type':`Class${i}`,'location.method':'Theory'})]}));
 const nodes=/** @type {Node[]} */ (groups.flatMap(group=>group.tests.map(test=>test.node))); // discovered rows always carry a uid
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,AbortController,require:(/** @type {string} */ name)=>name==='./mtp'?{...mtp,requestTests:async(/** @type {any} */ options,/** @type {any} */ operation,/** @type {readonly Node[] | undefined} */ selected)=>{
  const requested=selected??nodes;sent.push(Array.from(requested,node=>node.uid));
  return mtp.requestTests({...options,dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),
   timeoutMs:5000,env:{TESTY_UPDATES:JSON.stringify(updates(requested,groups))}},operation,selected);
 }}:realRequire(name)});
 const session=new exports.RunnerSession({dotnet:'dotnet',storage:'.',testArguments:[],onResult:(/** @type {TestFile} */ group,/** @type {any} */ result,/** @type {any} */ test)=>owners.push({group,result,test})});
 session.prepared.set(`${project}\0net10.0`,{root:'.',output:{directory:'.',restore:async()=>{}},session:'fixture',coverage:false,nodes,
  nativeById:new Map(nodes.map(node=>[node.uid,node])),byKey:new Map(),groups,runs:0});
 t.after(async()=>{session.prepared.clear();await session.dispose();});return{session,groups,sent,owners};
}

test('new runtime IDs use method ownership and manually rerun the correct file',async t=>{
 const f=runner(t,nodes=>[{uid:'suite','node-type':'group','execution-state':'passed'},...nodes.map((node)=>({...node,uid:`row${node.uid.slice(-1)}`,
  'display-name':'runtime','execution-state':node.uid==='parent1'?'failed':'passed'}))]);
 await f.session.run(f.groups,new Map());
 assert.equal(f.owners.length,2,'group notifications are not test results');
 const failed=/** @type {(typeof f.owners)[number]} */ (f.owners.find(entry=>entry.result.outcome==='failed'));assert.equal(failed.group.id,'Greeting');
 const rerun=await f.session.run([{...failed.group,tests:[failed.test]}],new Map());
 assert.deepEqual(f.sent[1],['parent1']);assert.equal(rerun.results[0].outcome,'failed');
});

test('unmapped runtime rows have project scope, honor exclusions, and do not duplicate container runs',async t=>{
 const f=runner(t,nodes=>[...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'runtime','display-name':'unmapped','execution-state':'failed'}]);
 await f.session.run(f.groups,new Map());
 const entry=/** @type {(typeof f.owners)[number]} */ (f.owners.find(entry=>entry.result.id==='runtime')),unknown=entry.group;
 assert.equal(unknown.runtimeOnly,true);assert.equal(unknown.file,undefined);
 const groups=[...f.groups,unknown],known=(/** @type {TestFile} */ group)=>group.runtimeOnly?[entry.test]:group.tests;
 assert.equal(selectManual(groups,{all:true,groups:new Set()},known).length,2);
 const select=(/** @type {ManualSelection['exclude']} */ exclude=undefined)=>selectManual(groups,{groups:new Set([unknown.id]),exclude},known);
 let result=await f.session.run(select(),new Map());assert.deepEqual(f.sent[1],['parent0','parent1']);assert.equal(result.executedGroups.length,2);
 result=await f.session.run(select({groups:new Set(['Greeting'])}),new Map());
 assert.deepEqual(f.sent[2],['parent0']);assert.equal(result.trace.groupId,'Calculator');
 assert.equal(/** @type {(typeof f.owners)[number]} */ (f.owners.at(-1)).group.id,'Calculator','a single-file rerun resolves the earlier unknown owner');
 const excluded=selectManual(groups,{all:true,groups:new Set(),exclude:{groups:new Set([unknown.id]),tests:new Map([[unknown.id,new Set(['runtime'])]])}},known);
 await assert.rejects(f.session.run(excluded,new Map()),/cannot honor an exclusion/);
});

test('ambiguous method metadata never assigns runtime rows to an arbitrary file',async t=>{
 const f=runner(t,nodes=>[...nodes.map(node=>({...node,'execution-state':'passed'})),{uid:'runtime','display-name':'unmapped','location.type':'Shared','location.method':'Theory','execution-state':'passed'}]);
 for(const group of f.groups)/** @type {Record<string, unknown>} */ (group.tests[0].node)['location.type']='Shared'; // the fixture node is readonly in the type only
 await f.session.run(f.groups,new Map());
 assert.equal(/** @type {(typeof f.owners)[number]} */ (f.owners.find(entry=>entry.result.id==='runtime')).group.runtimeOnly,true);
});

test('unmapped runtime rows appear under a project container and disappear when reattributed',async()=>{
 const proto=loadUi({vscode:{Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},Range:class{},TestMessage:class{}}}).TestTree.prototype;
 /** @returns {{values: any[], replace(values: Iterable<any>): void, add(value: any): void}} */
 const collection=()=>({values:[],replace(values){this.values=[...values];},add(value){this.values.push(value);}});
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{knownTests:(/** @type {TestFile} */ group)=>group.tests},host:{disposed:false,activeRun:undefined,roots:[],updateStatus(){}},setOutcome:proto.setOutcome,item:proto.item,
  controller:{items:collection(),createTestItem(/** @type {string} */ id,/** @type {string} */ label,/** @type {unknown} */ uri){return{id,label,uri,tags:[],children:collection()};}}};
 const group={id:'known',project:'/Tests.csproj',framework:'net10.0',file:'/Tests.cs',tests:[]};
 await proto.update.call(context,[group]);
 const unknown={...group,id:'runtime',file:undefined,runtimeOnly:true};
 proto.publishResult.call(context,unknown,{id:'row',name:'row',outcome:'failed'});
 const container=context.items.get('file:runtime');assert.equal(container.label,'Unmapped runtime tests · net10.0');assert.equal(container.uri,undefined);
 assert.ok(context.items.get('project:/Tests.csproj').children.values.includes(container));assert.equal(context.testIds.get('runtime:row').group,'runtime');
 await proto.update.call(context,[{...group,tests:[{id:'row',name:'row',file:'/Tests.cs',line:1}]}]);
 assert.equal(context.items.has('file:runtime'),false);assert.equal(context.testIds.has('runtime:row'),false);assert.equal(context.failed,0);
});
