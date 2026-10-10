const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {selectTests,ProjectIndex}=require('../../out/core/selection');
const {normalizePath,isExcluded,defaultExcludes,isConfigurationFile,isRestoreInput}=require('../../out/core/paths');
const policy=require('../../out/core/runPolicy');

/** @typedef {import('../../out/core/model').Project} Project */
/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/core/model').Trace} Trace */
/** @typedef {import('../../out/core/selection').Selection} Selection */
/** @typedef {import('../../out/core/selection').SelectionCause} SelectionCause */

const p=(/** @type {string} */ file)=>normalizePath(path.resolve('/workspace',file));
// Fixtures carry only the fields selection reads, so they are cast to the full model types.
const projects=/** @type {Project[]} */ (/** @type {unknown} */ ([
 {file:p('App/App.csproj'),sourceFiles:[p('App/A.cs')],inputs:[p('App/appsettings.json'),p('build/Common.msbuild')],references:[]},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs')],inputs:[p('build/Common.msbuild')],references:[p('App/App.csproj')]},
 {file:p('Other/Other.csproj'),sourceFiles:[p('Other/C.cs'),p('Other/CTests.cs')],references:[]}
]));
const groups=/** @type {TestFile[]} */ (/** @type {unknown} */ ([
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'c',file:p('Other/CTests.cs'),project:p('Other/Other.csproj'),tests:[]}
]));
const trace=(/** @type {string} */ groupId,/** @type {string[]} */ ...files)=>({groupId,dependencies:files,coverage:[],reliable:true,timestamp:1});
const traces=new Map([['a',trace('a',p('App/A.cs'))],['c',trace('c',p('Other/C.cs'))]]);
const index=new ProjectIndex(projects,new Set([p('build/Common.msbuild')]));
const hashes=new Map([...projects.flatMap(project=>[project.file,...project.sourceFiles,...project.inputs??[]])].map(file=>[file,'hash']));
// Non-C# inputs have no declaration shape, so the engine always passes them as conservative changes.
const select=(/** @type {string} */ file)=>selectTests(groups,projects,traces,[p(file)],'affected',false,new Set(/\.cs$/.test(file)?[]:[p(file)]),index);
const cause=(/** @type {Selection} */ selection,/** @type {string} */ id)=>/** @type {SelectionCause} */ (/** @type {ReadonlyMap<string, SelectionCause>} */ (selection.causes).get(id));
const selected=(/** @type {string} */ file)=>select(file).groups.map(group=>group.id);

test('editor settings are excluded from watching and inputs by default',()=>{
 for(const file of ['.vscode/settings.json','App/.vscode/launch.json','.vs/Workspace/v17/.suo','.idea/workspace.xml']){assert.equal(isExcluded(p(file),defaultExcludes,[p('')]),true,file);}
 assert.equal(isExcluded(p('App/appsettings.json'),defaultExcludes,[p('')]),false);
});

test('a tooling file outside every project neither restores nor selects tests',()=>{
 for(const file of ['package.json','tsconfig.json']){
  assert.equal(isConfigurationFile(p(file)),false,file);assert.equal(policy.invalidatesRestore(p(file),index),false,file);
  assert.deepEqual(selected(file),[],`${file} reaches no project`);
 }
 assert.equal(policy.isStructuralChange(p('package.json'),index,hashes),false,'an unowned non-C# file outside every project needs no evaluation');
});

test('global.json, nuget.config and Directory.Build.props are configuration that restores every project beneath them',()=>{
 for(const file of ['global.json','nuget.config','NuGet.Config','Directory.Build.props','Directory.Packages.props']){
  assert.equal(isConfigurationFile(p(file)),true,file);assert.equal(isRestoreInput(p(file)),true,file);
  assert.equal(policy.invalidatesRestore(p(file),index),true,file);assert.equal(policy.isStructuralChange(p(file),index,hashes),true,file);
  const selection=select(file);
  assert.deepEqual(selection.groups.map(group=>group.id),['a','c'],file);
  assert.equal(cause(selection,'a').reason,'configuration');
 }
});

test('an owned appsettings.json is an ordinary input of its project and dependents',()=>{
 const file=p('App/appsettings.json');
 assert.equal(isConfigurationFile(file),false);
 assert.equal(policy.isStructuralChange(file,index,hashes),false,'a known input needs no evaluation');
 assert.equal(policy.invalidatesRestore(file,index),false);
 const selection=select('App/appsettings.json');
 assert.deepEqual(selection.groups.map(group=>group.id),['a'],'only the owner and its dependent test project run');
 assert.equal(cause(selection,'a').reason,'unanalyzed');
 assert.deepEqual(selected('Other/unowned.json'),['c'],'an unowned file inside a project directory still falls back to that project');
});

test('test-platform and compiler configuration is structural without forcing a restore',()=>{
 for(const file of ['Tests/testconfig.json','Tests/Tests.testconfig.json','Tests/xunit.runner.json','App/Properties/launchSettings.json','test.runsettings','.editorconfig','Tests/Tests.slnx']){
  assert.equal(isConfigurationFile(p(file)),true,file);assert.equal(policy.invalidatesRestore(p(file),index),false,file);
 }
});

test('imports with other extensions are configuration once evaluation read them',()=>{
 const file=p('build/Common.msbuild');
 assert.equal(isConfigurationFile(file),false);assert.equal(index.isConfiguration(file),true);
 assert.equal(policy.isStructuralChange(file,index,hashes),true);assert.equal(policy.invalidatesRestore(file,index),true);
 assert.equal(cause(select('build/Common.msbuild'),'a').reason,'configuration');
 assert.equal(new ProjectIndex(projects).isConfiguration(file),false,'without evaluation metadata it remains an ordinary owned input');
});

test('incremental runs sweep every input only when watcher events may be incomplete',()=>{
 /** @type {Parameters<typeof policy.needsSourceSweep>[0]} */
 const run={full:false,structureDirty:false,manual:false,trigger:'fileSystem'};
 assert.equal(policy.needsSourceSweep(run),false);
 for(const change of /** @type {Partial<typeof run>[]} */ ([{full:true},{structureDirty:true},{manual:true},{trigger:'save'},{trigger:undefined}])){assert.equal(policy.needsSourceSweep({...run,...change}),true,JSON.stringify(change));}
});

test('commit freshness requires the build, topology, revision and every recorded input to be unchanged',()=>{
 const versions=new Map([['/w/A.cs','1']]),run={topology:1,revision:2,obsoleteBuild:false},current={topology:1,revision:2};
 assert.equal(policy.commitIsCurrent(run,current,{inputs:{'/w/A.cs':'1'}},versions),true);
 assert.equal(policy.commitIsCurrent(run,current,{inputs:{'/w/A.cs':'2'}},versions),false);
 assert.equal(policy.commitIsCurrent(run,current,{inputs:{'/w/New.cs':'<missing>'}},versions),true,'a still-missing file is unchanged');
 assert.equal(policy.commitIsCurrent(run,{...current,revision:3},{},versions),false);
 assert.equal(policy.commitIsCurrent(run,{...current,topology:2},{},versions),false);
 assert.equal(policy.commitIsCurrent({...run,obsoleteBuild:true},current,{},versions),false);
 const stored=/** @type {Map<string, Trace>} */ (/** @type {unknown} */ (new Map([['x',{inputs:{'/w/A.cs':'1'}}],['y',{inputs:{'/w/A.cs':'0'}}],['z',{inputs:{}}]]))); // traces reduced to their recorded inputs
 assert.deepEqual([...policy.freshTraces(stored,new Set(['z']),versions)],['x'],'selected traces are not refreshed');
});

test('selection rules for shapes, merged impact, completeness and checkpoints',()=>{
 assert.deepEqual([...policy.conservativeChanges(['a','b','c'],new Map([['a','s'],['b','t'],['c',null]]),new Map([['a','s'],['b','u']]))],['b','c']);
 /** @type {(id: string, tests?: string[]) => any} */ // partial TestFile fixtures: only id and test ids matter to these policies
 const group=(id,tests=[])=>({id,tests:tests.map(test=>({id:test}))});
 const merged=policy.mergeImpact(/** @type {any} */ ({groups:[group('a'),group('b')],causes:new Map([['a',{kind:'edited'}]])}),/** @type {any} */ ({groups:[group('b'),group('c')],reason:'next',fallback:false,causes:new Map([['c',{kind:'covers'}]])})); // partial selections
 assert.deepEqual(merged.groups.map(item=>item.id),['a','b','c']);assert.equal(merged.reason,'next');assert.deepEqual([.../** @type {ReadonlyMap<string, unknown>} */ (merged.causes).keys()],['a','c']);
 const original=new Map([['f',group('f',['1','2'])]]);
 assert.equal(policy.requestsComplete([group('f',['2','1'])],original),true);
 assert.equal(policy.requestsComplete([group('f',['1'])],original),false);
 assert.equal(policy.requestsComplete([group('unknown')],original),false);
 const run={configuration:'Debug',configured:{configuration:'Debug',coverage:true},manual:false};
 assert.equal(policy.completesCheckpoint(true,run,false),true);
 assert.equal(policy.completesCheckpoint(false,run,true),false);
 assert.equal(policy.completesCheckpoint(true,{...run,configuration:'Release'},true),false,'another configuration compiles different code');
 assert.equal(policy.completesCheckpoint(true,{...run,manual:true},false),false,'a manual run without collected coverage learned nothing');
 assert.equal(policy.completesCheckpoint(true,{...run,manual:true,configured:{configuration:'Debug',coverage:false}},false),true);
 assert.deepEqual(policy.baselineOrder([group('a'),group('b'),group('c')],new Set(['a'])).map(item=>item.id),['b','c','a']);
 assert.equal(policy.consumesChanges({manual:false,scoped:false,baseline:false}),true);
 assert.equal(policy.consumesChanges({manual:true,scoped:false,baseline:false}),false,'manual runs keep automatic changes pending');
 assert.equal(policy.consumesChanges({manual:false,scoped:true,baseline:false}),false,'a scoped impact run skipped affected files');
 assert.equal(policy.consumesChanges({manual:false,scoped:true,baseline:true}),true,'a scoped baseline still learns every file');
});

test('previously failing files are scheduled first, and a passing rerun clears them',()=>{
 const failing=new policy.FailingTests();
 failing.record('b',{id:'b1',outcome:'failed'});failing.record('c',{id:'c1',outcome:'errored'});failing.record('a',{id:'a1',outcome:'passed'});
 const order=()=>policy.failingFirst(/** @type {any[]} */ (['a','b','c','d'].map(id=>({id}))),id=>failing.has(id)).map(group=>group.id);
 assert.deepEqual(order(),['b','c','a','d']);
 failing.record('b',{id:'b1',outcome:'passed'});assert.equal(failing.has('b'),false);
 failing.record('c',{id:'c2',outcome:'failed'});failing.settle('c',new Set(['c2']));assert.equal(failing.has('c'),true,'a removed test cannot keep its file failing, a reported one does');
 failing.record('c',{id:'c2',outcome:'skipped'});assert.equal(failing.has('c'),false);
 failing.record('d',{id:'d1',outcome:'failed'});failing.settle('d',new Set());assert.equal(failing.has('d'),false);
 failing.record('e',{id:'e1',outcome:'failed'});failing.retain(new Set(['a']));assert.equal(failing.has('e'),false,'deleted files are forgotten');
});

test('target reports keep the union of every file report without rebuilding it',()=>{
 const reports=new Map([['f1',new Set(['r1','r2'])]]),files=new Map([['t',['f1','f2']]]);
 const target=new policy.TargetReports(reports,key=>files.get(key)??[]);
 assert.equal(target.target('t'),undefined,'not every file has reported');
 target.set('t','f2',new Set(['r2','r3']));
 const union=/** @type {ReadonlySet<string>} */ (target.target('t'));assert.deepEqual([...union].sort(),['r1','r2','r3']);
 target.set('t','f1',new Set(['r3']));
 assert.deepEqual([.../** @type {ReadonlySet<string>} */ (target.target('t'))].sort(),['r2','r3'],'a replaced report drops rows only it reported');
 assert.equal(target.target('t'),union,'the same live view is returned');
 assert.deepEqual([.../** @type {ReadonlySet<string>} */ (reports.get('f1'))],['r3'],'reports are written through to the checkpoint');
 target.set('other','x',new Set(['y']));assert.deepEqual([.../** @type {ReadonlySet<string>} */ (reports.get('x'))],['y']);
});

test('impact runs schedule files with failures in their latest results first',async()=>{
 const {TestEngine}=require('../../out/services/engine'),{selectRun}=require('../../out/services/engine/select');
 // Partial mock: only a few events and an empty configuration are read; the engine's private state is assigned directly, so it is typed any.
 /** @type {any} */ const engine=new TestEngine(/** @type {any} */ ({roots:[],storage:'/unused/testy-state',events:{output(){},selected(){},coverage(){}},configuration:()=>({})}));
 const file=(/** @type {string} */ id)=>({id,file:p(`Tests/${id}.cs`),project:p('Tests/Tests.csproj'),framework:'net10.0',tests:[]});
 engine.groups=['first','second','third'].map(file);engine.projects=projects;engine.index=index;
 for(const group of engine.groups){engine.coverage.replace([{...trace(group.id,p('App/A.cs')),inputs:{}}],new Set(engine.groups.map((/** @type {{id: string}} */ item)=>item.id)));}
 engine.failing.record('third',{id:'t1',outcome:'failed'});
 /** @type {any} */ const run={changes:[p('App/A.cs')],signal:new AbortController().signal,config:{mode:'affected'},previousIndex:index}; // partial RunContext
 const selected=await selectRun(engine,run,/** @type {any} */ ({before:new Map()}),/** @type {any} */ ({currentShapes:new Map([[p('App/A.cs'),'shape']]),sessions:{}}));
 assert.deepEqual(selected.selection.groups.map(group=>group.id),['third','first','second']);
 assert.equal(selected.checkpoint,undefined,'only a baseline has checkpoints to update');
});
