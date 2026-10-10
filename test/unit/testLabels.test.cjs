// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {loadUi}=require('./support/ui.cjs');
const {testName,typeLabel}=require('../../out/core/testUpdates');
const {testConverter}=require('../../out/services/mtp');
const {resolveDisplayPaths,displayPath}=require('../../out/core/paths');

test('xUnit default display names lose the type prefix, custom names stay',()=>{
 const node=(/** @type {string} */name,method='Add')=>({uid:'u','display-name':name,'location.type':'App.Tests.CalcTests','location.method':method});
 assert.equal(testName(node('App.Tests.CalcTests.Add')),'Add');
 assert.equal(testName(node('App.Tests.CalcTests.Add(x: 1, y: 2)')),'Add(x: 1, y: 2)');
 assert.equal(testName(node('App.Tests.CalcTests.Add(x: 1, y: 2)','Add(System.Int32, System.Int32)')),'Add(x: 1, y: 2)');
 assert.equal(testName(node('Adds two numbers')),'Adds two numbers');
 assert.equal(testName(node('App.Tests.CalcTests.AddMore')),'App.Tests.CalcTests.AddMore');
 assert.equal(testName(node('Add')),'Add');
 assert.equal(testName({uid:'u','display-name':'A.B.C'}),'A.B.C');
 assert.equal(testName({uid:'u'}),'u');
 assert.equal(testConverter()(node('App.Tests.CalcTests.Add')).name,'Add');
 assert.equal(testConverter()(node('App.Tests.CalcTests.Add')).fullyQualifiedName,'App.Tests.CalcTests.Add');
});

test('class labels drop the namespace and show nested types with dots',()=>{
 assert.equal(typeLabel('App.Tests.CalcTests'),'CalcTests');
 assert.equal(typeLabel('Plain'),'Plain');
 assert.equal(typeLabel('App.Outer+Inner'),'Outer.Inner');
 assert.equal(typeLabel('App.Outer+Inner+Deep'),'Outer.Inner.Deep');
 assert.equal(typeLabel('App.Box`1'),'Box`1');
 assert.equal(typeLabel('App.Box<System.String>'),'Box<System.String>');
});

test('Windows labels and URIs use the on-disk case while identity keys stay lowercase',async t=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform'),realpath=fsp.realpath;
 Object.defineProperty(process,'platform',{value:'win32'});
 t.after(()=>{Object.defineProperty(process,'platform',/** @type {PropertyDescriptor} */(platform));fsp.realpath=realpath;});
 fsp.realpath=/** @type {any} */(async(/** @type {string} */file)=>{if(file==='c:/repo/tests/calctests.cs')return'C:\\Repo\\Tests\\CalcTests.cs';if(file==='c:/repo/tests/tests.csproj')return'C:\\Repo\\Tests\\Tests.csproj';throw new Error('ENOENT');});
 await resolveDisplayPaths(['c:/repo/tests/calctests.cs','c:/repo/tests/tests.csproj']);
 assert.equal(displayPath('c:/repo/tests/calctests.cs'),'C:\\Repo\\Tests\\CalcTests.cs');
 assert.equal(displayPath('c:/other.cs'),'c:/other.cs');
 const win=path.win32;
 function collection(){return{values:/** @type {any[]} */([]),owner:/** @type {any} */(undefined),replace(/** @type {any[]} */v){this.values=[...v];for(const c of v)c.parent=this.owner;},add(/** @type {any} */v){this.values.push(v);v.parent=this.owner;},forEach(/** @type {any} */f){this.values.forEach(f);}};}
 const ui=loadUi({vscode:{Uri:{file:(/** @type {string} */fsPath)=>({fsPath:win.normalize(fsPath)})},Range:class{}},stubs:{'node:path':win}});
 const proto=ui.TestTree.prototype;
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{knownTests:(/** @type {any} */g)=>g.tests},host:{disposed:false,activeRun:undefined,roots:[],updateStatus(){}},setOutcome:proto.setOutcome,item:proto.item,
  controller:{items:collection(),createTestItem(/** @type {string} */id,/** @type {string} */label,/** @type {any} */uri){const item={id,label,uri,tags:[],children:collection()};item.children.owner=item;return item;}}};
 const node=(/** @type {string} */type)=>({'location.type':type});
 const group={id:'g',project:'c:/repo/tests/tests.csproj',framework:'net10.0',file:'c:/repo/tests/calctests.cs',tests:[
  {id:'a',name:'A',file:'c:/repo/tests/calctests.cs',line:1,node:node('App.CalcTests')},
  {id:'b',name:'B',file:'c:/repo/tests/calctests.cs',line:2,node:node('App.CalcTests')},
  {id:'c',name:'C',file:'c:/repo/tests/calctests.cs',line:3,node:node('App.Outer+Inner')},
  {id:'d',name:'D',file:'c:/repo/tests/calctests.cs',line:4,node:{}}]};
 await proto.update.call(context,[group]);
 const project=context.items.get('project:c:/repo/tests/tests.csproj'),file=context.items.get('file:g');
 assert.equal(project.label,'Tests');assert.equal(project.uri.fsPath,'C:\\Repo\\Tests\\Tests.csproj');
 assert.equal(file.label,'CalcTests.cs · net10.0');assert.equal(file.uri.fsPath,'C:\\Repo\\Tests\\CalcTests.cs');
 assert.deepEqual(file.children.values.map((/** @type {any} */c)=>c.label),['CalcTests','Outer.Inner','D']);
 const calc=context.items.get('class:g:App.CalcTests');
 assert.deepEqual(calc.children.values.map((/** @type {any} */c)=>c.id),['g:a','g:b']);
 assert.equal(calc.uri.fsPath,'C:\\Repo\\Tests\\CalcTests.cs');
 assert.deepEqual([...context.testIds.keys()].sort(),['g:a','g:b','g:c','g:d']);
 const {requestScope}=ui.module('ui/testTree');
 const items=(/** @type {string[]} */...ids)=>ids.map(id=>context.items.get(id));
 assert.deepEqual([...requestScope(context.testIds,{include:items('class:g:App.CalcTests')}).tests.get('g')],['a','b']);
 assert.deepEqual([...requestScope(context.testIds,{include:items('class:g:App.CalcTests','file:g')}).tests.keys()],[]);
 assert.deepEqual([...requestScope(context.testIds,{include:items('file:g'),exclude:items('class:g:App.Outer+Inner')}).exclude.tests.get('g')],['c']);

 // Moving a test out of its class and removing the class leaves no stale items.
 const second={...group,tests:[{...group.tests[0],node:{}},group.tests[3]]};
 await proto.update.call(context,[second]);
 assert.equal(context.items.has('class:g:App.CalcTests'),false);assert.equal(context.items.has('class:g:App.Outer+Inner'),false);
 assert.deepEqual([...context.testIds.keys()].sort(),['g:a','g:d']);
 assert.deepEqual(file.children.values.map((/** @type {any} */c)=>c.id),['g:a','g:d']);
 await proto.update.call(context,[]);
 assert.equal(context.items.size,0);
});
