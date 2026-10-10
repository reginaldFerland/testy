// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {discover,locationFiles,nodeKey,methodKey}=require('../../out/services/runnerDiscovery');
const analysis=require('../../out/services/analysis');
const {normalizePath}=require('../../out/core/paths');

/** @type {any} */
const project={file:normalizePath(path.resolve('workspace/App/App.csproj')),framework:'net10.0',assembly:path.resolve('workspace/App/bin/App.dll'),
 sourceFiles:[normalizePath(path.resolve('workspace/App/A.cs')),normalizePath(path.resolve('workspace/App/B.cs'))]};
const fileA=project.sourceFiles[0],fileB=project.sourceFiles[1];
/** @param {string} uid @param {Record<string,unknown>} [extra] */
const node=(uid,extra={})=>({uid,'display-name':uid,'node-type':'action','execution-state':'discovered',...extra});

test('discovered nodes are grouped by source file, with unlocated tests in a file-less group',async()=>{
 const nodes=[node('a1',{'location.file':fileA,'location.type':'T','location.method':'One','location.line-start':4}),
  node('b1',{'location.file':fileB,'location.type':'T','location.method':'Two'}),node('a2',{'location.file':fileA,'location.type':'T','location.method':'Three'}),node('loose')];
 const groups=await discover(project,/** @type {any} */ ({testArguments:[]}),nodes);
 assert.deepEqual(groups.map(group=>[group.file,group.tests.map(test=>test.id)]),[[fileA,['a1','a2']],[fileB,['b1']],[undefined,['loose']]]);
 for(const group of groups)assert.deepEqual([group.project,group.framework,group.assembly],[project.file,'net10.0',project.assembly]);
 assert.equal(new Set(groups.map(group=>group.id)).size,3);assert.equal(groups[0].tests[0].line,4);
});

test('missing locations come from portable symbols only when they name a project source file',async t=>{
 const calls=[],original=analysis.sourceLocations;
 const symbols=new Map([['T.One',{file:fileA,line:12}],['T.Two',{file:normalizePath(path.resolve('elsewhere/X.cs')),line:3}]]);
 /** @type {any} */ (analysis).sourceLocations=async(/** @type {unknown[]} */ ...args)=>{calls.push(args);return symbols;};
 t.after(()=>{/** @type {any} */ (analysis).sourceLocations=original;});
 const nodes=[node('one',{'location.type':'T','location.method':'One(System.Int32)'}),node('two',{'location.type':'T','location.method':'Two'}),node('three',{'location.file':fileB,'location.type':'T','location.method':'Three'})];
 const groups=await discover(project,/** @type {any} */ ({dotnet:'dotnet',analyzer:'analyzer.dll',storage:'storage',testArguments:[]}),nodes);
 assert.equal(calls.length,1);
 assert.deepEqual(groups.map(group=>[group.file,group.tests.map(test=>test.id)]),[[fileA,['one']],[undefined,['two']],[fileB,['three']]]);
 assert.equal(groups[0].tests[0].line,12);
 // Nothing is looked up when every node already has a location.
 await discover(project,/** @type {any} */ ({dotnet:'dotnet',analyzer:'analyzer.dll',storage:'storage',testArguments:[]}),[nodes[2]]);assert.equal(calls.length,1);
});

test('an unavailable symbol reader keeps the fallback grouping and says so',async t=>{
 const original=analysis.sourceLocations,output=/** @type {string[]} */ ([]);
 /** @type {any} */ (analysis).sourceLocations=async()=>{throw new Error('no symbols');};
 t.after(()=>{/** @type {any} */ (analysis).sourceLocations=original;});
 const groups=await discover(project,/** @type {any} */ ({dotnet:'dotnet',analyzer:'a.dll',storage:'s',testArguments:[],output:(/** @type {string} */ text)=>output.push(text)}),[node('x')]);
 assert.deepEqual(groups.map(group=>group.file),[undefined]);assert.match(output.join(''),/source locations unavailable.*no symbols/);
 const abort=new AbortController();abort.abort();
 await assert.rejects(discover(project,/** @type {any} */ ({testArguments:[],signal:abort.signal}),[node('x')]),{name:'AbortError'});
});

test('node and method keys identify tests independent of their location',()=>{
 const a=node('1',{'location.type':'T','location.method':'M(System.Int32)','location.method-arity':0});
 assert.equal(nodeKey(a),nodeKey({...a,uid:'2','location.file':fileA}));assert.notEqual(nodeKey(a),nodeKey({...a,'display-name':'other'}));
 assert.equal(methodKey(a),JSON.stringify(['T','M']));assert.equal(methodKey({'location.type':'T'}),undefined);
 assert.deepEqual(locationFiles([a,node('3',{'location.file':fileB}),node('4',{'location.file':7})]),[fileB]);
});
