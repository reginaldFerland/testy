const {test}=require('node:test');
const assert=require('node:assert/strict');
const {TestCoverageStore,narrowTests,rebaseRecords}=require('../../out/core/testCoverage');
const {mergeCoverage}=require('../../out/services/runner');

const file='/w/App/Handlers.cs',testFile='/w/Tests/HandlerTests.cs';
/** Two bodies, lines 3-5 and 7-9; v2 edits the second one in place. */
const layout=(/** @type {string} */ second)=>({signature:'sig',members:[{start:3,end:5,hash:'m1'},{start:7,end:9,hash:second}],gaps:['g0','g1','g2']});
const layouts=new Map([['v1',layout('m2')],['v2',layout('m2-edited')],['t1',{signature:'tsig',members:[],gaps:['t']}]]);
const geometry=new Map([['v1',{lines:[3,4,5,7,8,9]}],['t1',{lines:[2]}]]);
const lines=(/** @type {number[]} */ hit)=>[3,4,5,7,8,9].map(line=>({line,hits:hit.includes(line)?1:0}));
/** @param {number[]} hit */
const record=hit=>[{file,hash:'v1',lines:lines(hit)},{file:testFile,hash:'t1',lines:[{line:2,hits:1}]}];
const records=new Map([['first',record([3,4])],['second',record([7,8])],['both',record([4,8])]]);
const group=/** @type {any} */ ({id:'g',tests:[{id:'first'},{id:'second'},{id:'both'}]});
const trace=/** @type {any} */ ({groupId:'g',reliable:true,dependencies:[file,testFile],coverage:mergeCoverage([...records.values()]),timestamp:0});
const context={trace,versions:new Map([[file,'v2'],[testFile,'t1']]),conservative:new Set(),
 geometry:(/** @type {string} */ _file,/** @type {string} */ hash)=>geometry.get(hash),layouts:(/** @type {string} */ _file,/** @type {string} */ hash)=>layouts.get(hash)};

test('a covered file narrows to the tests whose own coverage executed an edited body',()=>{
 assert.deepEqual([...narrowTests(group,records,[file],context)??[]].sort(),['both','second']);
 assert.equal(narrowTests(group,records,[file],{...context,conservative:new Set([file])}),undefined,'a declaration change runs the whole file');
 assert.equal(narrowTests(group,records,['/w/App/Other.cs'],context),undefined,'a change the file does not depend on proves nothing');
 assert.equal(narrowTests(group,records,['/w/App/settings.json'],{...context,trace:{...trace,dependencies:[...trace.dependencies,'/w/App/settings.json']}}),undefined,'non-C# inputs run the whole file');
 assert.equal(narrowTests(group,new Map([...records].slice(0,2)),[file],context),undefined,'every test needs its own coverage');
 assert.equal(narrowTests(group,records,[file],{...context,trace:{...trace,reliable:false}}),undefined);
 const lagging=new Map([...records,['first',[{file,hash:'v0',lines:lines([3])},record([])[1]]]]);
 assert.equal(narrowTests(group,lagging,[file],context),undefined,'a record of another version counts as reached, so here every test is');
 const allReached=new Map([...records].map(([id])=>[id,record([8])]));
 assert.equal(narrowTests(group,allReached,[file],context),undefined,'when every test is reached the file runs whole');
});

test('the coverage of tests that did not run moves to the built versions, or the file cannot be completed',()=>{
 const moved=rebaseRecords(records,['first'],[file],new Map([[file,'v2']]),(_file,hash)=>geometry.get(hash),(_file,hash)=>layouts.get(hash));
 assert.ok(moved);
 const entry=moved.get('first')?.find(item=>item.file===file);
 assert.equal(entry?.hash,'v2');
 assert.deepEqual(entry?.lines.filter(line=>line.hits>0).map(line=>line.line),[3,4]);
 assert.deepEqual(entry?.lines.map(line=>line.line),[3,4,5],'lines of the edited body have no position until a test runs it');
 assert.equal(moved.get('first')?.find(item=>item.file===testFile)?.hash,'t1','other files keep their version');
 assert.equal(rebaseRecords(records,['second'],[file],new Map([[file,'v2']]),(_file,hash)=>geometry.get(hash),(_file,hash)=>layouts.get(hash)),undefined,
  'a test that executed the edit cannot move: its hits in the edited body have no position');
 assert.equal(rebaseRecords(records,['first'],[file],new Map([[file,'v2']]),()=>undefined,(_file,hash)=>layouts.get(hash)),undefined,'unknown geometry cannot move');
 assert.equal(rebaseRecords(records,['missing'],[file],new Map([[file,'v2']]),(_file,hash)=>geometry.get(hash),(_file,hash)=>layouts.get(hash)),undefined);
});

test('per-test coverage sums to the file coverage, and the store forgets removed files',()=>{
 const sum=mergeCoverage([record([3]),record([3,8])]).find(entry=>entry.file===file);
 assert.deepEqual(sum?.lines.map(line=>[line.line,line.hits]),[[3,2],[4,0],[5,0],[7,0],[8,1],[9,0]]);
 const store=new TestCoverageStore();store.set('a',records);store.set('b',records);
 store.retain(new Set(['a']));assert.equal(store.size,1);assert.equal(store.get('b'),undefined);
 store.delete('a');store.set('c',records);store.clear();assert.equal(store.size,0);
});
