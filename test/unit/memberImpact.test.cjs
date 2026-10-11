const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {reachesChangedMember,lineMapping,rebasedTrace,MemberLayouts}=require('../../out/core/memberImpact');
const {selectTests}=require('../../out/core/selection');
const {CoverageStore}=require('../../out/core/coverage');
const {unaffectedByEdit}=require('../../out/services/engine/select');
const {buildServerEnvironment}=require('../../out/services/projectBuild');
const {normalizePath}=require('../../out/core/paths');

/** @typedef {import('../../out/core/memberImpact').MemberLayout} MemberLayout */
/** @typedef {import('../../out/core/model').Project} Project */
/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/core/model').Trace} Trace */

/** @param {string} file */
const p=file=>normalizePath(path.resolve('/workspace',file));
/** @param {string} name */
const h=name=>name.padEnd(64,'0');
/** @param {number[]} lines */
const hits=(...lines)=>lines.map(line=>({line,hits:1}));
/** @template T @param {T | null | undefined} value @returns {T} */
const need=value=>/** @type {T} */(value);

// Handler.cs v1: constructor body on line 5, Handle on lines 8-11, Unused on line 12; a field initializer on line 4.
/** @type {MemberLayout} */
const v1={signature:h('S'),members:[{start:5,end:5,hash:h('ctor')},{start:8,end:11,hash:h('handle1')},{start:12,end:12,hash:h('unused')}],gaps:[h('g0'),h('g1'),h('g2'),h('g3')]};
// v2 edits Handle and adds two lines to it: Unused moves down by two.
/** @type {MemberLayout} */
const v2={...v1,members:[v1.members[0],{start:8,end:13,hash:h('handle2')},{start:14,end:14,hash:h('unused')}]};
const geometry=[4,5,8,9,10,11,12];

test('a test file reaches an edit only if its coverage executed a changed body',()=>{
 assert.equal(reachesChangedMember(v1,v2,{hits:hits(5,9),lines:geometry}),true,'it ran Handle');
 assert.equal(reachesChangedMember(v1,v2,{hits:hits(4,5,12),lines:geometry}),false,'constructor, initializer and Unused are unchanged');
 assert.equal(reachesChangedMember(v1,{...v2,signature:h('T')},{hits:hits(5),lines:geometry}),true,'a declaration edit reaches everything');
 assert.equal(reachesChangedMember(v1,{...v2,members:v2.members.slice(1)},{hits:hits(5),lines:geometry}),true,'bodies that do not pair up reach everything');
 assert.equal(reachesChangedMember(v1,v2,{hits:hits(5),lines:[4,5,12]}),true,'a changed body without instrumentable lines cannot prove it was missed');
});

test('lines move with unchanged bodies and gaps, never out of changed ones',()=>{
 const map=need(lineMapping(v1,v2));
 assert.equal(map(5),5,'the constructor before the edit stays');
 assert.equal(map(4),4,'the first gap stays');
 assert.equal(map(12),14,'Unused moves with its body');
 assert.equal(map(9),undefined,'a line in the edited body has no position yet');
 assert.equal(map(13),15,'the gap after the last body moves with that body');
 assert.equal(lineMapping(v1,{...v2,gaps:[h('g0'),h('g1'),h('x'),h('g3')]})?.(4),4,'other gaps still move');
 assert.equal(lineMapping(v1,{...v2,gaps:[h('x'),h('g1'),h('g2'),h('g3')]})?.(4),undefined,'a changed gap does not');
 assert.equal(lineMapping(v1,{...v2,signature:h('T')}),undefined);
 assert.equal(lineMapping({...v1,gaps:undefined},v2),undefined,'older layouts without gaps cannot move lines');
});

test('a rebased trace moves its coverage to the new version and accounts for it',()=>{
 const file=p('App/Handler.cs'),other=p('App/Other.cs');
 /** @type {Trace} */
 const trace={groupId:'t',dependencies:[file,other],coverage:[{file,hash:'v1',lines:hits(4,5,12)},{file:other,hash:'o1',lines:hits(1)}],reliable:true,timestamp:1,inputs:{[file]:'v1',[other]:'o1'}};
 const layouts=new Map([['v1',v1],['v2',v2]]);
 const rebased=need(rebasedTrace(trace,[file],new Map([[file,'v2'],[other,'o1']]),()=>({lines:geometry,declarations:[{name:'Handle',start:8,end:11},{name:'Unused',start:12,end:12}]}),(_file,hash)=>layouts.get(hash)));
 assert.deepEqual(rebased.inputs,{[file]:'v2',[other]:'o1'});
 const moved=need(rebased.coverage.find(entry=>entry.file===file));
 assert.equal(moved.hash,'v2');
 assert.deepEqual(moved.lines,[{line:4,hits:1},{line:5,hits:1},{line:14,hits:1}],'the edited body has no lines until a test of the new version reports them');
 assert.deepEqual(moved.declarations,[{name:'Unused',start:14,end:14}]);
 assert.equal(rebased.coverage.find(entry=>entry.file===other),trace.coverage[1],'other files are untouched');
 assert.equal(rebasedTrace({...trace,coverage:[{file,hash:'v1',lines:hits(9)}]},[file],new Map([[file,'v2']]),()=>({lines:geometry}),(_file,hash)=>layouts.get(hash)),undefined,
  'a covered line that cannot move leaves the trace as it is');
 assert.equal(rebasedTrace(trace,[file],new Map([[file,'v2']]),()=>({lines:geometry}),()=>undefined),undefined,'an unknown layout leaves it too');
});

test('layouts are kept for current versions and for versions some trace refers to',()=>{
 const layouts=new MemberLayouts();
 layouts.set('a.cs','old',v1);layouts.set('a.cs','new',v2);layouts.set('b.cs','gone',v1);
 layouts.retain(new Map([['a.cs','new']]),(file,hash)=>file==='a.cs'&&hash==='old');
 assert.equal(layouts.get('a.cs','old'),v1);assert.equal(layouts.get('a.cs','new'),v2);assert.equal(layouts.get('b.cs','gone'),undefined);
});

const projects=/** @type {Project[]} */ (/** @type {any} */ ([
 {file:p('App/App.csproj'),sourceFiles:[p('App/Handler.cs')],references:[]},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs'),p('Tests/BTests.cs')],references:[p('App/App.csproj')]}
]));
const groups=/** @type {TestFile[]} */ (/** @type {any} */ ([
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'b',file:p('Tests/BTests.cs'),project:p('Tests/Tests.csproj'),tests:[]}
]));
/** @param {string} groupId @returns {Trace} */
const traceOf=groupId=>({groupId,dependencies:[p('App/Handler.cs'),p(`Tests/${groupId.toUpperCase()}Tests.cs`)],coverage:[],reliable:true,timestamp:1});
const traces=new Map([['a',traceOf('a')],['b',traceOf('b')]]);

test('selection keeps only the files that reached the edit, without falling back for the rest',()=>{
 const handler=p('App/Handler.cs');
 /** @param {Set<string>} conservative @param {(change: string, id: string) => boolean} [unaffected] */
 const select=(conservative,unaffected)=>selectTests(groups,projects,traces,[handler],'affected',false,conservative,undefined,undefined,undefined,unaffected);
 assert.deepEqual(select(new Set()).groups.map(group=>group.id),['a','b'],'file granularity selects every file that reached the file');
 const narrowed=select(new Set(),(_change,id)=>id==='b');
 assert.deepEqual(narrowed.groups.map(group=>group.id),['a']);
 assert.equal(narrowed.fallback,false);
 const none=select(new Set(),()=>true);
 assert.deepEqual(none.groups,[],'files that all provably missed the edit are mapped, not unknown');
 assert.equal(none.reason,'Files that exercised the changed code');
 assert.deepEqual(select(new Set([handler]),()=>true).groups.map(group=>group.id),['a','b'],'a declaration change ignores body evidence');
});

test('an edit is unaffecting only with a reliable trace, known layouts of both versions and no changed body reached',()=>{
 const file=p('App/Handler.cs'),coverage=new CoverageStore();
 coverage.replace([{groupId:'a',dependencies:[file],coverage:[{file,hash:'v1',lines:[...hits(5),{line:9,hits:0},{line:12,hits:0}]}],reliable:true,timestamp:1},
  {groupId:'b',dependencies:[file],coverage:[{file,hash:'v1',lines:hits(9)}],reliable:true,timestamp:1},
  {groupId:'c',dependencies:[file],coverage:[{file,hash:'v1',lines:hits(5)}],reliable:false,timestamp:1}],new Set(['a','b','c']));
 const members=new MemberLayouts();members.set(file,'v1',v1);members.set(file,'v2',v2);
 const host={coverage,members},built=new Map([[file,'v2']]);
 assert.equal(unaffectedByEdit(host,built,file,'a'),true);
 assert.equal(unaffectedByEdit(host,built,file,'b'),false,'it ran the edited body');
 assert.equal(unaffectedByEdit(host,built,file,'c'),false,'an unreliable trace narrows nothing');
 assert.equal(unaffectedByEdit(host,new Map([[file,'v1']]),file,'b'),true,'a trace of the built version already accounts for it');
 assert.equal(unaffectedByEdit({coverage,members:new MemberLayouts()},built,file,'a'),false,'unknown layouts prove nothing');
});

test('builds keep the MSBuild server alive unless the user chose otherwise',()=>{
 assert.equal(buildServerEnvironment({A:'1'},{}).DOTNET_CLI_USE_MSBUILD_SERVER,'1');
 assert.equal(buildServerEnvironment({A:'1'},{}).A,'1');
 assert.equal(buildServerEnvironment({DOTNET_CLI_USE_MSBUILD_SERVER:'0'},{}).DOTNET_CLI_USE_MSBUILD_SERVER,'0');
 assert.equal(buildServerEnvironment(undefined,{DOTNET_CLI_USE_MSBUILD_SERVER:'0'}).DOTNET_CLI_USE_MSBUILD_SERVER,undefined,'the inherited value applies');
});

test('a server build that fails without a diagnostic is built again without the server; build errors are not',async()=>{
 const processes=require('../../out/services/process'),{buildProjects}=require('../../out/services/projectBuild');
 const original=processes.runProcess;
 /** @type {(string|undefined)[]} */
 const servers=[];let output='';
 /** @param {string} first */
 const runWith=async first=>{
  servers.length=0;
  processes.runProcess=async(/** @type {string} */ _command,/** @type {readonly string[]} */ _args,/** @type {import("../../out/services/process").ProcessOptions} */ options)=>{
   servers.push(options.env?.DOTNET_CLI_USE_MSBUILD_SERVER);
   return servers.length===1?{code:1,stdout:first,stderr:''}:{code:0,stdout:'',stderr:''};
  };
  const project=/** @type {any} */ ({file:p('App/App.csproj'),framework:'net10.0'});
  try {await buildProjects('dotnet',[project],'Debug',{cwd:p(''),output:(/** @type {string} */ text)=>{output+=text;}});return true;}
  catch {return false;}
  finally {processes.runProcess=original;}
 };
 assert.equal(await runWith('  App -> /out/App.dll\n'),true);
 assert.deepEqual(servers,['1','0']);assert.match(output,/without the server/);
 assert.equal(await runWith('/w/App/A.cs(3,5): error CS1002: ; expected [/w/App/App.csproj]\n'),false,'a compile error fails at once');
 assert.deepEqual(servers,['1']);
});
