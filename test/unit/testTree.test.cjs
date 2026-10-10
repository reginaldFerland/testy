// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {setImmediate:turn}=require('node:timers/promises');
const {loadUi}=require('./support/ui.cjs');

function uiPrototype(vscode={},pathApi=path) {return loadUi({vscode,stubs:{'node:path':pathApi}}).TestTree.prototype;}

test('tree refresh reuses unchanged children, updates locations and removes runtime results',async()=>{
 let replacements=0,created=0;
 function collection(){return{values:[],replace(values){replacements++;this.values=[...values];},add(value){this.values.push(value);}};}
 const proto=uiPrototype({Uri:{file:fsPath=>({fsPath})},Range:class{constructor(line){this.line=line;}}});
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{knownTests:g=>g.tests},host:{disposed:false,activeRun:undefined,roots:[],updateStatus(){}},setOutcome:proto.setOutcome,item:proto.item,
  controller:{items:collection(),createTestItem(id,label,uri){created++;return{id,label,uri,children:collection()};}}};
 const group={id:'g',project:'/Tests.csproj',framework:'net10.0',file:'/Tests.cs',tests:Array.from({length:2000},(_,i)=>({id:`t${i}`,name:`case ${i}`,file:'/Tests.cs',line:i+1}))};
 let completed=false;const first=proto.update.call(context,[group]).then(()=>completed=true);await turn();assert.equal(completed,false,'large groups yield before publication completes');await first;
 const before=replacements,child=context.items.get('g:t0');await proto.update.call(context,[group]);await proto.update.call(context,[{...group,tests:group.tests.map(t=>({...t}))}]);
 assert.equal(replacements,before);assert.equal(context.items.get('g:t0'),child);
 const changed={...group,tests:[{...group.tests[0],name:'renamed',file:'/Moved.cs',line:9},...group.tests.slice(1)]};
 await proto.update.call(context,[changed]);assert.equal(replacements,before+1);assert.equal(context.items.get('g:t0').uri.fsPath,'/Moved.cs');assert.equal(context.items.get('g:t0').range.line,8);
 proto.publishResult.call(context,changed,{id:'runtime',name:'runtime',outcome:'passed'});assert.equal(context.passed,1);
 await proto.update.call(context,[changed]);assert.equal(context.items.has('g:runtime'),false);assert.equal(context.passed,0);
 proto.publishResult.call(context,changed,{id:'runtime2',name:'runtime2',outcome:'passed'});
 await proto.update.call(context,[]);assert.equal(context.items.size,0);assert.equal(context.testIds.size,0);assert.equal(context.passed,0);assert.ok(created>=2000);
});

test('tree items reuse Windows URI paths with native separators',()=>{
 let created=0;
 const proto=uiPrototype({Uri:{file:file=>({fsPath:path.win32.normalize(file)})}},path.win32);
 const context={items:new Map(),controller:{createTestItem(id,label,uri){created++;return{id,label,uri};}}};
 const original=proto.item.call(context,'case','case','c:/workspace/Tests.cs');
 assert.equal(original.uri.fsPath,'c:\\workspace\\Tests.cs');
 assert.equal(proto.item.call(context,'case','renamed','c:/workspace/Tests.cs'),original);assert.equal(original.label,'renamed');assert.equal(created,1);
 assert.notEqual(proto.item.call(context,'case','renamed','c:/workspace/Moved.cs'),original);assert.equal(created,2);
});
