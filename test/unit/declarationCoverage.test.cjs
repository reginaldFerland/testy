const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parseCobertura,methodDeclarations}=require('../../out/services/reports');
const {CoverageStore,mergeDeclarations,declarationHits}=require('../../out/core/coverage');
const {CoverageCache,validSource}=require('../../out/services/cache');
const {contentHash,normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');
const plain=(/** @type {unknown} */ value)=>JSON.parse(JSON.stringify(value));

const line=(/** @type {number} */ number,/** @type {number} */ hits)=>`<line number="${number}" hits="${hits}" branch="False" />`;
const method=(/** @type {string} */ name,/** @type {string} */ signature,/** @type {number[][]} */ lines)=>`<method name="${name}" signature="${signature}"><lines>${lines.map(([number,hits])=>line(number,hits)).join('')}</lines></method>`;
const cls=(/** @type {string} */ name,/** @type {string} */ methods,/** @type {number[][]} */ lines)=>`<class name="${name}" filename="Code.cs"><methods>${methods}</methods><lines>${lines.map(([number,hits])=>line(number,hits)).join('')}</lines></class>`;
// Shaped like dotnet-coverage 18.1 output: overloads, a lambda closure class, a local function and an async state machine.
const report=`<?xml version="1.0" encoding="utf-8"?><coverage><packages><package name="app"><classes>${
 cls('Probe.Calc',method('Add','(int, int)',[[6,1],[7,1],[8,1]])+method('Add','(double)',[[9,0],[10,0],[11,0]])
  +method('Local','(int)',[[19,1],[21,1],[22,1]])+method('&lt;Local&gt;g__Twice|4_0','(int)',[[20,1]]),[[6,1],[7,1],[8,1],[9,0],[10,0],[11,0],[19,1],[20,1],[21,1],[22,1]])
 +cls('Probe.Calc.&lt;&gt;c',method('&lt;Lambda&gt;b__3_0','(int)',[[17,1]]),[[17,1]])
 +cls('Probe.Calc.&lt;SlowAsync&gt;d__2',method('MoveNext','()',[[12,1],[13,1],[15,1]]),[[12,1],[13,1],[15,1]])
}</classes></package></packages></coverage>`;

test('Cobertura method elements yield member spans; generated lambdas are skipped and state machines keep their member name',()=>{
 const cwd=process.cwd(),file=normalizePath(path.join(cwd,'Code.cs')),declarations=new Map();
 const lines=parseCobertura(report,cwd,new Set([file]),declarations);
 assert.deepEqual(declarations.get(file),[
  {name:'Add(int, int)',start:6,end:8},{name:'Add(double)',start:9,end:11},{name:'SlowAsync',start:12,end:15},{name:'Local(int)',start:19,end:22}]);
 assert.deepEqual([...lines],[...parseCobertura(report,cwd,new Set([file]))],'class lines are unchanged whether or not spans are requested');
 assert.deepEqual(methodDeclarations('A','<!-- <method name="Hidden"><lines><line number="1"/></lines></method> --><method name="NoLines"/><method name="Bad"><lines><line number="0" hits="1"/></lines></method>'),[],
  'commented, empty and invalid methods contribute no spans');
});

test('declaration spans merge as geometry and count a method hit when its lines ran',()=>{
 const a=[{name:'A()',start:1,end:3}],b=[{name:'B()',start:5,end:6},{name:'A()',start:1,end:3}];
 assert.equal(mergeDeclarations(a,undefined),a);assert.equal(mergeDeclarations(a,[{...a[0]}]),a,'nothing new keeps the previous identity');
 assert.deepEqual(mergeDeclarations(a,b),[{name:'A()',start:1,end:3},{name:'B()',start:5,end:6}]);
 const lines=[{line:1,hits:0},{line:2,hits:4},{line:5,hits:0},{line:6,hits:0}];
 assert.deepEqual(declarationHits(lines,[.../** @type {readonly import('../../out/core/model').Declaration[]} */ (mergeDeclarations(a,b)),{name:'Gone()',start:8,end:9}]).map(({declaration,hits})=>[declaration.name,hits]),[['A()',4],['B()',0]],
  'spans without instrumented lines are omitted');
});

test('the store keeps spans on shared sources, not per-test hits, and summaries expose the displayed version',()=>{
 const file='/Code.cs',hashes=new Map([[file,'v1']]),store=new CoverageStore();
 const entry=(/** @type {import('../../out/core/model').Declaration[]} */ declarations,/** @type {number} */ hits)=>({file,hash:'v1',lines:[{line:1,hits},{line:2,hits:0},{line:5,hits:0}],declarations});
 const trace=(/** @type {string} */ groupId,/** @type {ReturnType<typeof entry>} */ coverage)=>({groupId,dependencies:[file],coverage:[coverage],reliable:true,timestamp:1});
 store.replace([trace('one',entry([{name:'A()',start:1,end:2}],1)),trace('two',entry([{name:'B()',start:5,end:5}],0))],new Set(['one','two']));
 const summary=store.summarize(hashes)[0];
 assert.deepEqual(summary.declarations,[{name:'A()',start:1,end:2},{name:'B()',start:5,end:5}]);
 assert.ok([...store.traces.values()].every(trace=>trace.coverage.every(coverage=>!('declarations' in coverage))));
 const delta=store.takeDelta(),restored=new CoverageStore();restored.restorePacked(delta.sources,delta.traces);
 assert.deepEqual(restored.summarize(hashes)[0].declarations,summary.declarations,'persisted geometry restores the spans');
 assert.ok(validSource(delta.sources[0]));
 assert.ok(!validSource({...delta.sources[0],declarations:[{name:'A()',start:3,end:1}]}));
 assert.ok(!validSource({...delta.sources[0],declarations:[{start:1,end:1}]}));
});

test('the coverage cache rewrites a source whose geometry gained spans',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-declaration-cache-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file='/Code.cs',id=contentHash(`${file}\0v1`),source={id,file,hash:'v1',lines:[1,2]};
 const trace={groupId:'one',timestamp:1,reliable:true,stale:false,dependencies:[file],inputs:{[file]:'v1'},sourceIds:[id],coverage:[{file,hash:'v1',lines:[{line:1,hits:1}]}]};
 const cache=new CoverageCache(root,()=>{});
 await cache.save({sources:[source],traces:[trace],removedSources:[],removedTraces:[]},t.signal);
 await cache.save({sources:[{...source,declarations:[{name:'A()',start:1,end:2}]}],traces:[],removedSources:[],removedTraces:[]},t.signal);
 const store=new CoverageStore();await new CoverageCache(root,()=>{}).restore(store,t.signal);
 assert.deepEqual(store.summarize(new Map([[file,'v1']]))[0].declarations,[{name:'A()',start:1,end:2}]);
});

/** @param {{documents?: any[]}} [options] documents are partial TextDocument mocks */
function view({documents=[]}={}){
 const vscode={window:{visibleTextEditors:[]},workspace:{textDocuments:documents},Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},
  FileCoverage:class{constructor(/** @type {unknown} */ uri,/** @type {unknown} */ statementCoverage,/** @type {unknown} */ branchCoverage,/** @type {unknown} */ declarationCoverage){Object.assign(this,{uri,statementCoverage,declarationCoverage});}},
  StatementCoverage:class{constructor(/** @type {unknown} */ executed,/** @type {unknown} */ location){Object.assign(this,{kind:'statement',executed,location});}},
  DeclarationCoverage:class{constructor(/** @type {string} */ name,/** @type {unknown} */ executed,/** @type {unknown} */ location){Object.assign(this,{kind:'declaration',name,executed,location});}},
  Position:class{constructor(/** @type {number} */ line,/** @type {number} */ character){Object.assign(this,{line,character});}},
  Range:class{constructor(/** @type {number} */ startLine,/** @type {number} */ startCharacter,/** @type {number} */ endLine,/** @type {number} */ endCharacter){this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};}}};
 return{vscode,ui:loadUi({vscode})};
}

test('published file coverage carries method counts and detail includes declarations alongside statements',async()=>{
 const file=normalizePath('/workspace/Code.cs'),{ui}=view({documents:[{uri:{scheme:'file',fsPath:file},lineCount:6,
  getText:()=>'class C {\n    void A() {\n        Run();\n    }\n    void B() { }\n}'}]});
 const summary={file,stale:false,covered:2,total:3,groupIds:[],lines:[{line:2,hits:1},{line:3,hits:1},{line:5,hits:0}],
  declarations:[{name:'A()',start:2,end:4},{name:'B()',start:5,end:5},{name:'Edited()',start:9,end:12}]};
 /** @type {any[]} */ const added=[];const context={host:{disposed:false,activeRun:{addCoverage:(/** @type {unknown} */ coverage)=>added.push(coverage)},updateStatus(){}},
  engine:{coverage:{summarize:()=>[summary]},hashes:new Map()},productionSources:new Set(),owners:new Map(),items:new Map(),publishedCoverage:new Map(),details:new WeakMap(),queue(){}};
 const proto=ui.CoverageView.prototype;proto.publish.call(context);
 assert.deepEqual(plain(added[0].declarationCoverage),{covered:1,total:2});
 const detail=await proto.detail.call(context,summary,summary.lines);
 assert.deepEqual(plain(detail.filter((/** @type {any} */ item)=>item.kind==='statement').map((/** @type {any} */ item)=>[item.location.start.line,item.location.start.character,item.location.end.character])),[[1,4,14],[2,8,14],[4,4,16]],
  'ranges come from the open document text');
 assert.deepEqual(plain(detail.filter((/** @type {any} */ item)=>item.kind==='declaration').map((/** @type {any} */ item)=>[item.name,item.executed,item.location.start.line,item.location.end.line])),[['A()',1,1,3],['B()',0,4,4]],
  'spans beyond the open document are dropped');
});

test('detail for an unsaved editor uses its buffer rather than the file on disk',async()=>{
 const file=normalizePath(path.join(os.tmpdir(),'testy-missing-on-disk.cs')),{ui}=view({documents:[{uri:{scheme:'file',fsPath:file},lineCount:2,isDirty:true,getText:()=>'\n  Unsaved();'}]});
 const detail=await ui.CoverageView.prototype.detail.call({},{file,lines:[{line:2,hits:3},{line:3,hits:0}]},[{line:2,hits:3},{line:3,hits:0}]);
 assert.deepEqual(plain(detail.map((/** @type {any} */ item)=>[item.location.start.line,item.location.start.character,item.location.end.character])),[[1,2,12]]);
});
