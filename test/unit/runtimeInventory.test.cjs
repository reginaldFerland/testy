const test=require('node:test'),assert=require('node:assert/strict');
const {RuntimeInventory}=require('../../out/services/runtimeInventory');

const test0={id:'known',name:'Known',fullyQualifiedName:'Known',line:1,node:{uid:'known'}};
const file={id:'file',project:'/p.csproj',framework:'net10.0',assembly:'/p.dll',file:'/A.cs',tests:[test0]};
const container={id:'runtime:p',project:'/p.csproj',framework:'net10.0',assembly:'/p.dll',tests:[],runtimeOnly:true};
const result=id=>({id,name:id,fullyQualifiedName:id,outcome:'passed',duration:0,node:{uid:id}});

test('runtime rows join discovered tests, move out of containers once a file reports them, and retire when unreported',()=>{
 const inventory=new RuntimeInventory();inventory.reconcile([file],new Set());
 assert.equal(inventory.observe(file,result('known')),false,'a discovered result adds nothing');
 assert.equal(inventory.tests(file),file.tests);
 assert.equal(inventory.observe(container,result('case(1)')),true,'a new container changes the tree');
 assert.equal(inventory.observe(container,result('case(2)')),false);
 assert.deepEqual([...inventory.rows.get(container.id).keys()],['case(1)','case(2)']);
 // The file now reports one case itself: the container no longer holds it.
 assert.equal(inventory.observe(file,result('case(1)')),true);
 assert.deepEqual(inventory.tests(file).map(test=>test.id),['known','case(1)']);
 assert.equal(inventory.tests(file),inventory.tests(file),'merged tests are reused');
 assert.deepEqual([...inventory.rows.get(container.id).keys()],['case(2)']);
 // A complete file run without the case retires it; the whole target completing retires the container.
 assert.equal(inventory.retireUnreported([file],new Set(['known'])),true);
 assert.deepEqual(inventory.tests(file).map(test=>test.id),['known']);
 assert.equal(inventory.containers.size,1);
 assert.equal(inventory.retireUnreported([file],new Set(['known']),new Set(['known'])),true);
 assert.equal(inventory.containers.size,0);assert.equal(inventory.rows.has(container.id),false);
});

test('reconciling drops rows of changed identities and containers of retired targets',()=>{
 const inventory=new RuntimeInventory();inventory.reconcile([file],new Set());
 inventory.observe(file,result('case(1)'));inventory.observe(container,result('case(2)'));
 inventory.reconcile([file],new Set(['file']));
 assert.equal(inventory.rows.size,0);assert.equal(inventory.containers.size,0);
 inventory.observe(container,result('case(3)'));
 inventory.reconcile([],new Set());
 assert.equal(inventory.rows.size,0);assert.equal(inventory.containers.size,0);
});
