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
 const stored=/** @type {Map<string, Trace>} */ (/** @type {unknown} */ (new Map([['x',{inputs:{'/w/A.cs':'1'},stale:true}],['y',{inputs:{'/w/A.cs':'0'},stale:true}],['z',{inputs:{},stale:true}],
  ['fresh',{inputs:{}}],['historical',{inputs:{},stale:true,historical:true}]]))); // traces reduced to their recorded inputs and freshness
 assert.deepEqual([...policy.freshTraces(stored,new Set(['z']),versions)],['x'],'selected, already fresh and historical traces are not refreshed');
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
 const order=()=>policy.scheduleOrder(/** @type {any[]} */ (['a','b','c','d'].map(id=>({id}))),'responsiveness',id=>failing.has(id),()=>undefined).map(group=>group.id);
 assert.deepEqual(order(),['b','c','a','d']);
 failing.record('b',{id:'b1',outcome:'passed'});assert.equal(failing.has('b'),false);
 failing.record('c',{id:'c2',outcome:'failed'});failing.settle('c',new Set(['c2']));assert.equal(failing.has('c'),true,'a removed test cannot keep its file failing, a reported one does');
 failing.record('c',{id:'c2',outcome:'skipped'});assert.equal(failing.has('c'),false);
 failing.record('d',{id:'d1',outcome:'failed'});failing.settle('d',new Set());assert.equal(failing.has('d'),false);
 failing.record('e',{id:'e1',outcome:'failed'});failing.retain(new Set(['a']));assert.equal(failing.has('e'),false,'deleted files are forgotten');
});

test('responsiveness runs failing files, then unmeasured ones, then the shortest first; throughput runs the longest first',()=>{
 const times=new Map([['a',300],['b',100],['c',200],['e',50]]),failing=new Set(['c']);
 const groups=/** @type {any[]} */ (['a','b','c','d','e'].map(id=>({id})));
 const order=(/** @type {import('../../out/core/runPolicy').SchedulingPriority} */ priority)=>policy.scheduleOrder(groups,priority,id=>failing.has(id),id=>times.get(id)).map(group=>group.id);
 assert.deepEqual(order('responsiveness'),['c','d','e','b','a']);
 // d has no time and counts as the average (162.5 ms): after a and c, before b.
 assert.deepEqual(order('throughput'),['a','c','d','b','e'],'failures do not reorder a throughput run');
 assert.deepEqual(policy.scheduleOrder(groups,'throughput',()=>false,()=>undefined).map(group=>group.id),['a','b','c','d','e'],'without times the order is kept');
 assert.equal(policy.schedulingPriority({baseline:true,mode:'affected',all:false}),'throughput');
 assert.equal(policy.schedulingPriority({baseline:false,mode:'all',all:false}),'throughput');
 assert.equal(policy.schedulingPriority({baseline:false,mode:'affected',all:true}),'throughput');
 assert.equal(policy.schedulingPriority({baseline:false,mode:'affected',all:false}),'responsiveness');
});

test('a batch time is shared by test count, and the time left counts queued and running batches over the workers',()=>{
 assert.deepEqual([...policy.shareElapsed([{id:'a',tests:/** @type {any[]} */ ([1,2,3])},{id:'b',tests:/** @type {any[]} */ ([1])}],400)],[['a',300],['b',100]]);
 assert.deepEqual([...policy.shareElapsed([{id:'a',tests:[]},{id:'b',tests:[]}],400)],[['a',200],['b',200]]);
 assert.equal(policy.remainingTime([{expected:undefined,finished:false}],2,0),undefined,'nothing is known yet');
 const batches=[{expected:1000,started:0,finished:false},{expected:3000,finished:false},{expected:undefined,finished:false},{expected:500,finished:true}];
 // Running: 1000 - 400 = 600; queued: 3000 and the average of the known (1500); over two workers.
 assert.equal(policy.remainingTime(batches,2,400),2550);
 assert.equal(policy.remainingTime(batches,8,400),1700,'never more workers than batches left');
 assert.equal(policy.remainingTime([{expected:100,started:0,finished:false}],1,500),0,'an overdue batch is not negative');
 assert.equal(policy.remainingTime([{expected:100,finished:true}],1,0),0);
});

test('learned run times are smoothed, saved with outcomes, restored without overriding newer ones, and forgotten with the file',()=>{
 const outcomes=new policy.TestOutcomes();
 outcomes.record('f',{id:'t1',outcome:'passed'});outcomes.recordElapsed('f',100);
 assert.equal(outcomes.elapsed('f'),100);
 outcomes.recordElapsed('f',300);assert.equal(outcomes.elapsed('f'),200,'averaged with the previous time');
 outcomes.recordElapsed('f',Number.NaN);outcomes.recordElapsed('f',-1);assert.equal(outcomes.elapsed('f'),200,'invalid times are ignored');
 assert.deepEqual(outcomes.take().saved,[{groupId:'f',elapsed:200,passed:['t1']}]);
 outcomes.recordElapsed('f',200);assert.deepEqual(outcomes.take().saved,[],'an unchanged time saves nothing');
 const restored=new policy.TestOutcomes();
 restored.recordElapsed('g',40);
 restored.restore([{groupId:'f',elapsed:200,passed:['t1']},{groupId:'g',elapsed:900,passed:['t2']}]);
 assert.equal(restored.elapsed('f'),200);assert.equal(restored.elapsed('g'),40,'a time measured in this session is newer');
 restored.retain(new Set(['g']));assert.equal(restored.elapsed('f'),undefined);
 restored.clear();assert.equal(restored.elapsed('g'),undefined);assert.equal(restored.elapsedByFile.size,0);
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

test('a batch is affected by changes to its test files, to files its coverage reached, or to non-C# files',()=>{
 const {batchAffected}=require('../../out/core/runPolicy');
 const traces=new Map([['t1',{dependencies:['/w/A.cs','/w/T1.cs']}]]);const trace=(/** @type {string} */ id)=>traces.get(id);
 const groups=[{id:'t1',file:'/w/T1.cs'},{id:'t2',file:'/w/T2.cs'}];
 assert.equal(batchAffected(groups,['/w/B.cs'],trace),false);
 assert.equal(batchAffected(groups,['/w/A.cs'],trace),true);
 assert.equal(batchAffected(groups,['/w/T2.cs'],trace),true,'a test file without coverage');
 assert.equal(batchAffected(groups,['/w/app.json'],trace),true);
});

test('a superseded run commits a finished file whose own inputs are current although the revision moved',()=>{
 const {commitIsCurrent}=require('../../out/core/runPolicy');
 const trace={inputs:{'/w/A.cs':'h1'}},hashes=new Map([['/w/A.cs','h1'],['/w/B.cs','h9']]);
 const run={topology:1,revision:3,obsoleteBuild:false},now={topology:1,revision:4};
 assert.equal(commitIsCurrent(run,now,trace,hashes),false);
 assert.equal(commitIsCurrent({...run,superseded:true},now,trace,hashes),true);
 assert.equal(commitIsCurrent({...run,superseded:true},now,trace,new Map([['/w/A.cs','h2']])),false,'its own input changed');
 assert.equal(commitIsCurrent({...run,superseded:true},{...now,topology:2},trace,hashes),false);
});

test('files a superseded run committed are selected again only by what changed since they ran',()=>{
 const {alreadyRan}=require('../../out/services/engine/select');
 const ran=new Map([['/w/A.cs','a1'],['/w/B.cs','b2']]),entry={versions:ran,topology:7};
 const host={topology:7,ranAgainst:new Map([['g1',entry],['g2',entry]])};
 /** @type {string[][]} */ const asked=[];
 const select=(/** @type {readonly string[]} */ files)=>{asked.push([...files]);return {groups:files.includes('/w/C.cs')?[{id:'g2'}]:[]};};
 // Nothing changed since: both files are current.
 assert.deepEqual([...alreadyRan(host,['/w/B.cs'],new Map(ran),[{id:'g1'},{id:'g2'},{id:'g3'}],select)].sort(),['g1','g2']);
 // C changed since (new version); it selects g2 again, not g1.
 const before=new Map([...ran,['/w/C.cs','c1']]);
 assert.deepEqual([...alreadyRan(host,['/w/B.cs','/w/C.cs'],before,[{id:'g1'},{id:'g2'}],select)],['g1']);
 assert.deepEqual(asked.at(-1),['/w/C.cs']);
 // An untracked change, or another topology, keeps every file.
 assert.equal(alreadyRan(host,['/w/app.json'],new Map(ran),[{id:'g1'}],select).size,0);
 assert.equal(alreadyRan({...host,topology:8},['/w/B.cs'],new Map(ran),[{id:'g1'}],select).size,0);
});

test('long files of a throughput run are split into balanced parts, and short, ineligible or unknown files stay whole',()=>{
 const {splitLongFiles}=require('../../out/core/runPolicy');
 const file=(/** @type {string} */ id,/** @type {number} */ tests)=>({id,tests:Array.from({length:tests},(_,index)=>({id:`${id}${index}`}))});
 const groups=[file('long',6),file('short',3),file('other',4),file('unknown',2)];
 const times=new Map([['long',12000],['short',1000],['other',1000]]);
 const durations=new Map([['long0',5000],['long1',3000],['long2',1000],['long3',1000],['long4',1000],['long5',1000]]);
 const split=splitLongFiles(groups,4,id=>times.get(id),(_group,test)=>durations.get(test),group=>group.id!=='other');
 assert.deepEqual(split.slice(1).map(parts=>parts.length),[1,1,1]);
 const parts=split[0];assert.ok(parts.length>=2&&parts.length<=4,`${parts.length}`);
 assert.deepEqual(parts.flatMap(part=>part.tests.map(test=>test.id)).sort(),['long0','long1','long2','long3','long4','long5']);
 assert.ok(parts.every(part=>part.id==='long'));
 for(const part of parts){const ids=part.tests.map(test=>test.id);assert.deepEqual(ids,[...ids].sort(),'tests keep their order');}
 assert.deepEqual(splitLongFiles(groups,1,id=>times.get(id),()=>undefined,()=>true).map(parts=>parts.length),[1,1,1,1],'one worker splits nothing');
 assert.deepEqual(splitLongFiles([file('a',4)],4,()=>1500,()=>undefined,()=>true)[0].length,1,'below the minimum');
});

test('automatic runs add pinned items and, when asked, failing files, joining tests of files already selected',()=>{
 const {withAlwaysRun}=require('../../out/services/engine/select');
 const test=(/** @type {string} */ id)=>({id,name:id,fullyQualifiedName:id,line:1,node:{uid:id}});
 const file=(/** @type {string} */ id,/** @type {string[]} */ tests)=>({id,project:'/w/T.csproj',framework:'net10.0',assembly:'/w/T.dll',file:`/w/${id}.cs`,tests:tests.map(test)});
 const groups=[file('a',['a1','a2']),file('b',['b1','b2']),file('c',['c1'])];
 const failing=new Set(['c']);
 const host={groups,pinned:{groups:new Set(['a','b']),tests:new Map([['a',new Set(['a2'])]])},failing:{has:(/** @type {string} */ id)=>failing.has(id)},knownTests:(/** @type {any} */ group)=>group.tests};
 const narrowed=new Map([['a',new Set(['a1'])]]);
 const selection={groups:[{...groups[0],tests:[groups[0].tests[0]]}],reason:'Affected',fallback:false,causes:new Map()};
 const result=withAlwaysRun(/** @type {any} */ (host),{alwaysRunFailing:true},/** @type {any} */ (selection),narrowed);
 assert.deepEqual(result.groups.map(group=>[group.id,group.tests.map(item=>item.id)]),[['a',['a1','a2']],['b',['b1','b2']],['c',['c1']]]);
 assert.deepEqual([...(narrowed.get('a')??[])].sort(),['a1','a2'],'a pinned test joins a narrowed file');
 assert.equal(result.causes?.get('b')?.kind,'pinned');assert.equal(result.causes?.get('c')?.kind,'failing');
 assert.equal(withAlwaysRun(/** @type {any} */ ({...host,pinned:undefined}),{alwaysRunFailing:false},/** @type {any} */ (selection)),selection);
});
