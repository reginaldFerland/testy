const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {TestEngine}=require('../../out/services/engine');
const {Baseline}=require('../../out/services/engine/baseline');
const {SdkChecks}=require('../../out/services/engine/sdk');
const {coverageIdentity}=require('../../out/services/engine/identity');
const {fileStamps,assetVersions,changedVersions}=require('../../out/services/engine/untracked');
const {findProjects}=require('../../out/services/projects');
const {PreparedOutputCache}=require('../../out/services/preparedOutputCache');
const {copyOutput,PreparedOutput}=require('../../out/services/output');
const {HashMemo}=require('../../out/services/hashMemo');
const {CoverageCache}=require('../../out/services/cache');
const {CoverageStore}=require('../../out/core/coverage');
const {contentHash,normalizePath}=require('../../out/core/paths');

/** @param {import('node:test').TestContext} t @param {string} name */
async function temporary(t,name){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`testy-${name}-`)));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}

/** An engine over a real coverage cache; its private members are inspected directly. @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await temporary(t,'restart'),storage=path.join(root,'state');
 /** @type {string[]} */ const output=[];
 const engine=new TestEngine({roots:[root],storage,tools:root,analyzer:'',configuration:()=>/** @type {any} */ ({}) /* partial mock: unused here */,events:{
  output:text=>output.push(text),phase(){},selected(){},discovered(){},coverage(){},invalidated(){},started(){},result(){}}},{coverageCache:new CoverageCache(storage,()=>{})});
 t.after(()=>engine.dispose());
 /** @type {any} */ const internals=engine; // private: resume, baseline, pendingChanges, learned, initialized, checkpoint state
 return{root,storage,engine,internals,output};
}

/** @param {string} groupId @param {Partial<import('../../out/core/coverage').StoredTrace>} [fields] */
const stored=(groupId,fields={})=>{
 const file=`/w/${groupId}.cs`,source={id:contentHash(`${file}\0v1`),file,hash:'v1',lines:[1]};
 return{source,trace:{groupId,timestamp:1,reliable:true,stale:false,identity:'id',dependencies:[file],inputs:{[file]:'v1'},sourceIds:[source.id],
  coverage:[{file,hash:'v1',lines:[{line:1,hits:1}]}],...fields}};
};

test('a resumed checkpoint completes only traces that were current and reliable when saved, and replays what no run consumed',async t=>{
 const f=await fixture(t),fresh=stored('fresh'),stale=stored('stale',{stale:true}),partial=stored('partial',{reliable:false});
 const checkpoint={identity:'id',completed:['fresh','stale','partial','missing'],versions:new Map(),shapes:new Map(),
  untracked:new Map([['/w/TestData/cases.json','10:1']]),pending:['/w/App/data.json'],toolchain:'tools'};
 await new CoverageCache(f.storage,()=>{}).save({sources:[fresh.source,stale.source,partial.source],traces:[fresh.trace,stale.trace,partial.trace],removedSources:[],removedTraces:[],checkpoint});
 const restored=await new CoverageCache(f.storage,()=>{}).restore(f.engine.coverage,undefined,'id');
 assert.deepEqual(restored.checkpoint,checkpoint,'the inline fields round-trip');
 f.internals.resume(restored.checkpoint,'settings');
 assert.deepEqual([...f.internals.baseline.completed],['fresh'],'a trace saved stale, or unreliable, is learned again');
 assert.deepEqual([...f.internals.baseline.untracked],[['/w/TestData/cases.json','10:1']]);
 assert.deepEqual([...f.internals.pendingChanges],['/w/App/data.json']);assert.equal(f.internals.learnedToolchain,'tools');
});

test('a change marked while no run consumes it is saved with the checkpoint, so a restart reruns it',async t=>{
 const f=await fixture(t),data=path.join(f.root,'TestData','cases.json');
 f.internals.learned={settings:'s',identity:'id'};f.internals.initialized=true;f.internals.saveDelay=60_000;
 await f.engine.markChanged([data]);
 await f.engine.dispose();
 const restored=await new CoverageCache(f.storage,()=>{}).restore(new CoverageStore(),undefined,'id');
 assert.deepEqual(restored.checkpoint?.pending,[data],'disposal saved the pending change');
});

test('untracked versions: stamps of existing files, project assets by content, and differences in either direction',async t=>{
 const root=await temporary(t,'untracked'),data=path.join(root,'cases.json'),missing=path.join(root,'missing.json');
 await fs.writeFile(data,'[1]');
 const stamps=await fileStamps([data,missing]);
 assert.deepEqual([...stamps.keys()],[data],'a missing file has no version');
 const project=path.join(root,'App','App.csproj'),custom=path.join(root,'artifacts','obj','App');
 await fs.mkdir(path.join(root,'App','obj'),{recursive:true});await fs.mkdir(custom,{recursive:true});
 await fs.writeFile(path.join(root,'App','obj','project.assets.json'),'{"libraries":{"A/1.0.0":{}}}');await fs.writeFile(path.join(custom,'project.assets.json'),'{}');
 const projects=/** @type {any[]} */ ([{file:project,outputDirectories:[custom]}]),memo=new HashMemo(16); // partial Project: only the paths read here
 const assets=await assetVersions(projects,memo);
 assert.deepEqual([...assets.keys()].sort(),[path.join(custom,'project.assets.json'),path.join(root,'App','obj','project.assets.json')].sort());
 assert.equal(assets.get(path.join(root,'App','obj','project.assets.json')),contentHash('{"libraries":{"A/1.0.0":{}}}'));
 await fs.writeFile(path.join(root,'App','obj','project.assets.json'),'{"libraries":{"A/1.0.1":{}}}');
 const resolved=await assetVersions(projects,memo);
 assert.deepEqual(changedVersions(assets,resolved),[path.join(root,'App','obj','project.assets.json')],'another resolved package is a change');
 assert.deepEqual(changedVersions(new Map([['a','1'],['b','1']]),new Map([['b','2'],['c','1']])).sort(),['a','b','c']);
});

test('the project walk reports files outside every project directory it finds',async t=>{
 const root=await temporary(t,'unowned-walk');
 for(const [file,text] of /** @type {[string,string][]} */ ([['App/App.csproj','<Project />'],['App/data.json','{}'],['App/sub/more.json','{}'],['TestData/cases.json','[]'],['nuget.config','<c />'],['bin/out.json','{}']])){
  await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),text);
 }
 /** @type {string[]} */ const unowned=[];
 const projects=await findProjects([root],['**/bin/**','**/bin/'],undefined,4,undefined,file=>unowned.push(path.relative(root,file)));
 assert.deepEqual(projects,[normalizePath(path.join(root,'App','App.csproj'))]);
 assert.deepEqual(unowned.sort(),['TestData/cases.json','nuget.config'].map(file=>path.join(...file.split('/'))).sort());
});

test('a restart compares untracked versions: changed, added and removed files are changes of a resumed baseline',async t=>{
 const f=await fixture(t),baseline=new Baseline('resume',new Map(),true);
 baseline.rebase(new Map(),new Map(),new Map([['/w/cases.json','1:1'],['/w/App/obj/project.assets.json','a'],['/w/gone.json','1:1']]));
 const changes=f.internals.changedSinceCheckpoint(baseline,[],new Map([['/w/cases.json','2:2'],['/w/App/obj/project.assets.json','a'],['/w/new.json','1:1']]));
 assert.deepEqual([...changes].sort(),['/w/cases.json','/w/gone.json','/w/new.json']);
 assert.deepEqual([...f.internals.pendingChanges].sort(),['/w/cases.json','/w/gone.json','/w/new.json'],'kept pending until a run consumes them');
});

test('a resumed baseline learned with another SDK or evaluation tools learns every file again',async t=>{
 const f=await fixture(t),baseline=new Baseline('resume',new Map(),true);
 baseline.complete(['a','b']);f.internals.toolchain='current';
 f.internals.learnedToolchain='current';f.internals.adoptToolchain(baseline);
 assert.deepEqual([...baseline.completed],['a','b']);
 f.internals.learnedToolchain='other';f.internals.adoptToolchain(baseline);
 assert.deepEqual([...baseline.completed],[]);assert.equal(f.internals.learnedToolchain,'current');
 assert.ok(f.output.some(text=>text.includes('SDK or evaluation tools changed')));
 const unknown=new Baseline('resume',new Map(),true);unknown.complete(['a']);f.internals.learnedToolchain=undefined;f.internals.adoptToolchain(unknown);
 assert.deepEqual([...unknown.completed],[],'a checkpoint without a toolchain trusts nothing');
});

test('the coverage identity includes the environment that MSBuild reads, but not launch-specific variables',async()=>{
 const config=/** @type {any} */ ({dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:1}),tools=new Map();
 const before=await coverageIdentity(config,['/w'],tools);
 const saved={variable:process.env.TESTY_RESTART_PROPERTY,launch:process.env.VSCODE_PID};
 try{
  process.env.VSCODE_PID='12345';assert.equal(await coverageIdentity(config,['/w'],tools),before);
  process.env.TESTY_RESTART_PROPERTY='changed';assert.notEqual(await coverageIdentity(config,['/w'],tools),before);
 }finally{
  if(saved.variable===undefined)delete process.env.TESTY_RESTART_PROPERTY;else process.env.TESTY_RESTART_PROPERTY=saved.variable;
  if(saved.launch===undefined)delete process.env.VSCODE_PID;else process.env.VSCODE_PID=saved.launch;
 }
});

test('SDK checks report the distinct versions they resolved',{skip:process.platform==='win32'},async t=>{
 const root=await temporary(t,'sdk-versions'),dotnet=path.join(root,'dotnet');
 await fs.writeFile(dotnet,'#!/bin/sh\necho 10.0.100\n',{mode:0o755});
 const sdk=new SdkChecks(),options={cwd:root,cleanupDescendants:false,timeoutMs:60_000};
 await sdk.ensure(dotnet,options,'one');await sdk.ensure(dotnet,options,'two');
 assert.deepEqual(sdk.resolved,['10.0.100']);
 await fs.writeFile(dotnet,'#!/bin/sh\necho 10.0.200\n',{mode:0o755});sdk.forget();await sdk.ensure(dotnet,options,'one');
 assert.deepEqual(sdk.resolved,['10.0.100','10.0.200'],'a roll-forward changes the versions');
 await sdk.stop();assert.deepEqual(sdk.resolved,[]);
});

test('a manifest walk started before the mark taken after a build is never joined',async t=>{
 const root=await temporary(t,'walk-mark'),source=path.join(root,'out');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'App.dll'),'built');
 /** @type {string[]} */ const log=[];
 const cache=new PreparedOutputCache(path.join(root,'storage'),randomUUID(),{log:text=>log.push(text)});
 /** @type {any} */ const internals=cache; // private: walks, sequence, sourceManifest
 const older={hash:'before the build',files:[]};
 internals.walks.set(source,{started:++internals.sequence,manifest:Promise.resolve(older)});
 const mark=cache.mark();
 assert.notEqual((await internals.sourceManifest(source,undefined,mark)).hash,older.hash,'the older walk is not joined');
 internals.walks.set(source,{started:++internals.sequence,manifest:Promise.resolve(older)});
 assert.equal(await internals.sourceManifest(source,undefined,mark),older,'a walk started after the mark is shared');
 // acquire passes the mark through.
 /** @type {unknown[]} */ const marks=[];const walk=internals.sourceManifest.bind(cache);
 internals.sourceManifest=(/** @type {string} */ file,/** @type {AbortSignal} */ signal,/** @type {number} */ after)=>{marks.push(after);return walk(file,signal,after);};
 const lease=await cache.acquire(source,'context',async directory=>{
  const template=path.join(directory,'template'),output=new PreparedOutput(template,path.join(directory,'assembly'));
  await copyOutput(source,template);await output.initialize();
  return{root:directory,output,session:'s',coverage:true,instrumented:[],reusable:true};
 },undefined,undefined,mark);
 await lease?.release();await cache.dispose();
 assert.equal(marks[0],mark,log.join(''));
});
