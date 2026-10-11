const {test}=require('node:test');
const assert=require('node:assert/strict');
const {discoveredTest}=require('../../out/services/mtp');
const {nodeTraits,traitTagIds,hasExcludedTrait,eligibleGroups,batchResources}=require('../../out/core/traits');
const {loadUi}=require('./support/ui.cjs');

const plain=(/** @type {unknown} */ values)=>JSON.parse(JSON.stringify(values)),ids=(/** @type {{tags: {id: string}[]}} */ item)=>plain(item.tags.map(tag=>tag.id));

test('discovery reads traits from the traits array, key/value map and flat trait.* properties',()=>{
 const array=discoveredTest({uid:'a','display-name':'A',traits:[{key:'TestCategory',value:'Integration'},{key:'Owner',value:'sam'},{key:'Owner',value:'sam'},{name:'Speed',value:'slow'},'Area=Billing','broken',{key:'',value:'x'}]});
 assert.deepEqual(plain(array.traits),[{key:'TestCategory',value:'Integration'},{key:'Owner',value:'sam'},{key:'Speed',value:'slow'},{key:'Area',value:'Billing'}]);
 assert.deepEqual(plain(nodeTraits({uid:'m',traits:{Category:['Fast','Unit'],Owner:'kim'}})),[{key:'Category',value:'Fast'},{key:'Category',value:'Unit'},{key:'Owner',value:'kim'}]);
 assert.deepEqual(plain(nodeTraits({uid:'f','trait.Category':'Integration','trait.Tag':['a','b'],'trait.':'ignored'})),[{key:'Category',value:'Integration'},{key:'Tag',value:'a'},{key:'Tag',value:'b'}]);
 assert.equal(discoveredTest({uid:'none','display-name':'None'}).traits,undefined,'tests without traits stay unchanged');
 assert.equal('traits' in discoveredTest({uid:'none'}),false);
 const flood=nodeTraits({uid:'x',traits:Array.from({length:500},(_,index)=>({key:'k',value:String(index)}))});
 assert.equal(/** @type {readonly unknown[]} */ (flood).length,32,'the number of traits per test is bounded');
});

test('trait tags are filterable IDs, with a category tag for TestCategory',()=>{
 assert.deepEqual(traitTagIds([{key:'TestCategory',value:'Integration'},{key:'Category',value:'Slow Tests'},{key:'Owner',value:'a b'}]),
  ['trait:TestCategory=Integration','category:Integration','trait:Category=Slow_Tests','category:Slow_Tests','trait:Owner=a_b']);
 assert.deepEqual(traitTagIds(undefined),[]);
});

test('test items carry trait tags, cached across rebuilds, and notice trait changes',async()=>{
 const collection=()=>({values:/** @type {unknown[]} */ ([]),replace(/** @type {Iterable<unknown>} */ values){this.values=[...values];},add(/** @type {unknown} */ value){this.values.push(value);}});
 const {TestTree}=loadUi({vscode:{Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},Range:class{}}});
 const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],outcomes:new Map(),passed:0,failed:0,
  engine:{knownTests:(/** @type {{tests: unknown[]}} */ group)=>group.tests},host:{disposed:false,activeRun:undefined,roots:[],updateStatus(){}},setOutcome:TestTree.prototype.setOutcome,item:TestTree.prototype.item,
  controller:{items:collection(),createTestItem:(/** @type {string} */ id,/** @type {string} */ label,/** @type {unknown} */ uri)=>({id,label,uri,tags:[],children:collection()})}};
 const node=(/** @type {{key: string, value: string}[] | undefined} */ traits)=>discoveredTest({uid:'t1','display-name':'Adds','location.file':'/Tests.cs','location.line-start':3,'location.type':'Calc','location.method':'Adds',traits});
 const group=(/** @type {{key: string, value: string}[] | undefined} */ traits)=>({id:'g',project:'/Tests.csproj',framework:'net10.0',assembly:'/Tests.dll',file:'/Tests.cs',tests:[node(traits)]});
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

test('excluded traits match a key and value, or a bare category value, ignoring case',()=>{
 const integration=[{key:'TestCategory',value:'Integration'}],owner=[{key:'Owner',value:'Integration'}];
 assert.equal(hasExcludedTrait(integration,['integration']),true,'a bare value matches a category');
 assert.equal(hasExcludedTrait([{key:'Category',value:'Integration'}],['Integration']),true);
 assert.equal(hasExcludedTrait(owner,['Integration']),false,'a bare value matches only categories');
 assert.equal(hasExcludedTrait(owner,['owner=INTEGRATION']),true);
 assert.equal(hasExcludedTrait(integration,['Category=Integration']),false,'a key names exactly that trait');
 assert.equal(hasExcludedTrait(integration,['Unit']),false);
 assert.equal(hasExcludedTrait(undefined,['Integration']),false);
 assert.equal(hasExcludedTrait(integration,[]),false);
});

test('automatic runs see files without excluded tests, and files of only excluded tests not at all',()=>{
 /** @param {string} id @param {{key:string,value:string}[]} [traits] */
 const t=(id,traits)=>({id,name:id,fullyQualifiedName:id,line:1,node:{},...traits?{traits}:{}});
 const slow=[{key:'TestCategory',value:'Integration'}];
 const mixed=/** @type {any} */ ({id:'mixed',project:'p',framework:'f',assembly:'a',tests:[t('unit'),t('db',slow)]});
 const only=/** @type {any} */ ({id:'only',project:'p',framework:'f',assembly:'a',tests:[t('api',slow)]});
 const plainFile=/** @type {any} */ ({id:'plain',project:'p',framework:'f',assembly:'a',tests:[t('fast')]});
 const groups=[mixed,only,plainFile];
 assert.equal(eligibleGroups(groups,[]),groups,'without exclusions nothing changes');
 const eligible=eligibleGroups(groups,['Integration']);
 assert.deepEqual(eligible.map(group=>group.id),['mixed','plain']);
 assert.deepEqual(plain(eligible[0]?.tests.map(test=>test.id)),['unit']);
 assert.deepEqual(plain(eligible[0]?.excludedTestIds),['db'],'a fallback to the whole file cannot run the excluded test');
 assert.equal(eligible[1],plainFile,'unaffected files are the same objects');
});

test('MSTest 4, NUnit and xUnit v3 traits, reported as name/value objects, become traits',()=>{
 assert.deepEqual(plain(nodeTraits({uid:'x',traits:[{Category:'Fast'}]})),[{key:'Category',value:'Fast'}],'xUnit v3');
 assert.deepEqual(plain(nodeTraits({uid:'n',traits:[{Fast:''}]})),[{key:'Category',value:'Fast'}],'NUnit');
 assert.deepEqual(plain(nodeTraits({uid:'m',traits:[{Integration:''},{Owner:'sam'}]})),[{key:'Category',value:'Integration'},{key:'Owner',value:'sam'}]);
 assert.deepEqual(traitTagIds(nodeTraits({uid:'m',traits:[{Integration:''}]})),['trait:Category=Integration','category:Integration']);
});

test('shared resources come from exclusive and serial trait patterns of any test in the batch',()=>{
 const file=(/** @type {string} */ id,/** @type {{key: string, value: string}[][]} */ traits)=>/** @type {any} */ ({id,tests:traits.map((list,index)=>({id:`${id}${index}`,traits:list}))});
 const db=file('a',[[],[{key:'Category',value:'Database'}]]),ports=file('b',[[{key:'Resource',value:'Ports'}]]),plainFile=file('c',[[]]);
 assert.equal(batchResources([db],[],[]),undefined,'nothing configured');
 assert.deepEqual(batchResources([db],['database',' Resource = ports '],[]),{exclusive:['database'],serial:false},'one test of the file is enough; case is ignored');
 assert.deepEqual(batchResources([db,ports],['Database','Resource=Ports'],[]),{exclusive:['database','resource=ports'],serial:false},'a batch of files needs every resource');
 assert.deepEqual(batchResources([ports],['RESOURCE=PORTS'],['Database']),{exclusive:['resource=ports'],serial:false},'spelling of the same pattern names one resource');
 assert.equal(batchResources([plainFile],['Database'],['Database']),undefined);
 assert.deepEqual(batchResources([db],[],['Database']),{exclusive:[],serial:true});
});

test('batch resources name inclusive resources and the most workers a matching trait asks for',()=>{
 const {batchResources}=require('../../out/core/traits');
 const group=(/** @type {{key:string,value:string}[]} */ traits)=>/** @type {any} */ ({tests:[{id:'t',traits}]});
 assert.deepEqual(batchResources([group([{key:'Category',value:'Database'}])],[],[],{inclusive:['Database']}),{exclusive:[],serial:false,inclusive:['database']});
 assert.deepEqual(batchResources([group([{key:'Category',value:'Database'}])],['Database'],[],{inclusive:['Database']}),{exclusive:['database'],serial:false},'an exclusive match wins');
 assert.deepEqual(batchResources([group([{key:'Category',value:'Heavy'}])],[],[],{workers:{Heavy:4,'Category=Heavy':2,Other:8}}),{exclusive:[],serial:false,workers:4});
 assert.equal(batchResources([group([])],[],[],{workers:{Heavy:4}}),undefined);
});
