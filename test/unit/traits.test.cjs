const {test}=require('node:test');
const assert=require('node:assert/strict');
const {discoveredTest}=require('../../out/services/mtp');
const {nodeTraits,traitTagIds}=require('../../out/core/traits');
const {loadUi}=require('./support/ui.cjs');

const plain=values=>JSON.parse(JSON.stringify(values)),ids=item=>plain(item.tags.map(tag=>tag.id));

test('discovery reads traits from the traits array, key/value map and flat trait.* properties',()=>{
 const array=discoveredTest({uid:'a','display-name':'A',traits:[{key:'TestCategory',value:'Integration'},{key:'Owner',value:'sam'},{key:'Owner',value:'sam'},{name:'Speed',value:'slow'},'Area=Billing','broken',{key:'',value:'x'}]});
 assert.deepEqual(plain(array.traits),[{key:'TestCategory',value:'Integration'},{key:'Owner',value:'sam'},{key:'Speed',value:'slow'},{key:'Area',value:'Billing'}]);
 assert.deepEqual(plain(nodeTraits({uid:'m',traits:{Category:['Fast','Unit'],Owner:'kim'}})),[{key:'Category',value:'Fast'},{key:'Category',value:'Unit'},{key:'Owner',value:'kim'}]);
 assert.deepEqual(plain(nodeTraits({uid:'f','trait.Category':'Integration','trait.Tag':['a','b'],'trait.':'ignored'})),[{key:'Category',value:'Integration'},{key:'Tag',value:'a'},{key:'Tag',value:'b'}]);
 assert.equal(discoveredTest({uid:'none','display-name':'None'}).traits,undefined,'tests without traits stay unchanged');
 assert.equal('traits' in discoveredTest({uid:'none'}),false);
 const flood=nodeTraits({uid:'x',traits:Array.from({length:500},(_,index)=>({key:'k',value:String(index)}))});
 assert.equal(flood.length,32,'the number of traits per test is bounded');
});

test('trait tags are filterable IDs, with a category tag for TestCategory',()=>{
 assert.deepEqual(traitTagIds([{key:'TestCategory',value:'Integration'},{key:'Category',value:'Slow Tests'},{key:'Owner',value:'a b'}]),
  ['trait:TestCategory=Integration','category:Integration','trait:Category=Slow_Tests','category:Slow_Tests','trait:Owner=a_b']);
 assert.deepEqual(traitTagIds(undefined),[]);
});

test('test items carry trait tags, cached across rebuilds, and notice trait changes',async()=>{
 const collection=()=>({values:[],replace(values){this.values=[...values];},add(value){this.values.push(value);}});
 const {TestTree}=loadUi({vscode:{Uri:{file:fsPath=>({fsPath})},Range:class{}}});
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{knownTests:group=>group.tests},host:{disposed:false,activeRun:undefined,roots:[],updateStatus(){}},setOutcome:TestTree.prototype.setOutcome,item:TestTree.prototype.item,
  controller:{items:collection(),createTestItem:(id,label,uri)=>({id,label,uri,tags:[],children:collection()})}};
 const node=traits=>discoveredTest({uid:'t1','display-name':'Adds','location.file':'/Tests.cs','location.line-start':3,'location.type':'Calc','location.method':'Adds',traits});
 const group=traits=>({id:'g',project:'/Tests.csproj',framework:'net10.0',assembly:'/Tests.dll',file:'/Tests.cs',tests:[node(traits)]});
 await TestTree.prototype.update.call(context,[group([{key:'TestCategory',value:'Integration'}])]);
 const item=context.items.get('g:t1');
 assert.deepEqual(ids(item),['project:Tests','framework:net10.0','trait:TestCategory=Integration','category:Integration']);
 const tag=item.tags[2];
 await TestTree.prototype.update.call(context,[group([{key:'TestCategory',value:'Integration'}])]);
 assert.equal(context.items.get('g:t1').tags[2],tag,'tag objects are cached by ID');
 await TestTree.prototype.update.call(context,[group([{key:'TestCategory',value:'Slow'}])]);
 assert.deepEqual(ids(context.items.get('g:t1')).slice(2),['trait:TestCategory=Slow','category:Slow'],'changed traits rebuild the item');
 await TestTree.prototype.update.call(context,[group(undefined)]);
 assert.deepEqual(ids(context.items.get('g:t1')),['project:Tests','framework:net10.0']);
});
