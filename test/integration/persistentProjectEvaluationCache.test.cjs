const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine'),{normalizePath}=require('../../out/core/paths');
const projects=require('../../out/services/projects'),processes=require('../../out/services/process');
const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const source=name=>`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class ${name} { [TestMethod] public void Pass() => Assert.AreEqual(1, Core.Feature.Value); }`;
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

async function fixture(t,{privateAnalyzer=false}={}){
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-restart-evaluation-'))),root=path.join(temp,'workspace'),storage=path.join(temp,'state');
 const core=path.join(root,'Core'),tests=path.join(root,'Tests');await fs.mkdir(core,{recursive:true});await fs.mkdir(tests);
 const coreProject=path.join(core,'Core.csproj'),project=path.join(tests,'Tests.csproj'),testFile=path.join(tests,'Smoke.cs');
 const payload=path.join(temp,'restore-payload.props'),imported=path.join(tests,'obj','Tests.csproj.restored.props'),marker=path.join(temp,'restored.txt'),failure=path.join(temp,'fail-restore');
 await fs.writeFile(coreProject,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 await fs.writeFile(path.join(core,'Feature.cs'),'namespace Core; public static class Feature { public static int Value => 1; }');
 await fs.writeFile(project,`<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
 <ItemGroup><ProjectReference Include="../Core/Core.csproj"/></ItemGroup>
 <Target Name="TestyRestoreSideEffects" BeforeTargets="_GenerateRestoreGraphProjectEntry">
 <MakeDir Directories="$(MSBuildProjectDirectory)/obj"/>
 <Copy SourceFiles="${xml(payload)}" DestinationFiles="${xml(imported)}" Condition="Exists('${xml(payload)}')"/>
 <Delete Files="${xml(imported)}" Condition="!Exists('${xml(payload)}')"/>
 <Error Condition="Exists('${xml(failure)}')" Text="controlled restart restore failure"/>
 <WriteLinesToFile File="${xml(marker)}" Lines="restored" Overwrite="false"/>
 </Target></Project>`);
 await fs.writeFile(testFile,source('SmokeTests'));
 let analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');
 if(privateAnalyzer){const copy=path.join(temp,'analyzer');await fs.cp(path.dirname(analyzer),copy,{recursive:true});analyzer=path.join(copy,path.basename(analyzer));}
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2};
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),output=[],results=new Map();let engine,afterRestore,inspect=0,restore=0,sdk=0;
 const evaluate=projects.evaluateProjects,restoreProjects=projects.restoreProjects,runProcess=processes.runProcess;
 projects.evaluateProjects=async(...args)=>{inspect++;return evaluate(...args);};
 projects.restoreProjects=async(...args)=>{restore++;await restoreProjects(...args);await afterRestore?.(...args);};
 processes.runProcess=(command,args,...options)=>{if(args.length===1&&args[0]==='--version')sdk++;return runProcess(command,args,...options);};
 const create=()=>new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer,configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>results.set(`${group.id}:${result.id}`,result),started(){},coverage(){},invalidated(){}}});
 engine=create();
 t.after(async()=>{control.abort();projects.evaluateProjects=evaluate;projects.restoreProjects=restoreProjects;processes.runProcess=runProcess;await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 return{temp,root,tests,project,coreProject,testFile,storage,payload,imported,marker,failure,analyzer,config,output,signal,
  get engine(){return engine;},counts:()=>({inspect,restore,sdk}),afterRestore:hook=>{afterRestore=hook;},
  async restart(){await engine.dispose();engine=create();await engine.restore(signal);},
  async baseline(extraSignal){results.clear();return engine.run({files:[],full:true},extraSignal?AbortSignal.any([signal,extraSignal]):signal);},
  identity:()=>engine.groups.flatMap(group=>group.tests.map(test=>[group.id,test.id,test.name,test.fullyQualifiedName])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  outcomes:()=>[...results].map(([id,result])=>[id,result.outcome]).sort(([a],[b])=>a.localeCompare(b)),
  sourceFiles:()=>engine.projects.find(value=>value.file===normalizePath(project)).sourceFiles,
  markerCount:async()=>(await fs.readFile(marker,'utf8')).trim().split(/\r?\n/).length};
}

test('clean engine restarts reuse evaluated dependency graphs after fresh SDK checks and authoritative Restore',{timeout:120000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 const graph=structuredClone(f.engine.projects),ids=f.identity(),outcomes=f.outcomes(),before=f.counts(),markers=await f.markerCount();
 assert.ok((await fs.stat(path.join(f.storage,'project-evaluations-v1.json'))).size>0);
 await f.restart();assert.equal(f.engine.projects.length,0,'disk candidates are not published during engine construction or coverage restore');
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.equal(f.counts().inspect,before.inspect,'an unchanged restart launches no Inspect');
 assert.ok(f.counts().restore>before.restore);assert.ok(f.counts().sdk>before.sdk);assert.ok(await f.markerCount()>markers);
 assert.deepEqual(f.engine.projects,graph);assert.deepEqual(f.identity(),ids);assert.deepEqual(f.outcomes(),outcomes);
 assert.ok(f.output.some(text=>/Reusing \d+ validated project evaluation/.test(text)));
});

test('restart validation occurs after Restore creates, rewrites and deletes generated compile imports',{timeout:120000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));let count=f.counts().inspect;
 const alpha=path.join(f.temp,'Alpha.cs'),beta=path.join(f.temp,'Beta.cs');await fs.writeFile(alpha,source('AlphaTests'));await fs.writeFile(beta,source('BetaTests'));
 for(const file of [alpha,beta]){
  await f.restart();await fs.writeFile(f.payload,`<Project><ItemGroup><Compile Include="${xml(file)}"/></ItemGroup></Project>`);
  assert.equal((await f.baseline()).passed,2,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
  assert.ok(f.sourceFiles().includes(normalizePath(file)));assert.ok(!f.sourceFiles().includes(normalizePath(file===alpha?beta:alpha)));
 }
 await f.restart();await fs.rm(f.payload);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 assert.ok(f.counts().inspect>count);assert.ok(!f.sourceFiles().includes(normalizePath(beta)));await assert.rejects(fs.stat(f.imported),{code:'ENOENT'});
});

test('restart inventories discover added and deleted files and project references without watcher events',{timeout:150000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));let count=f.counts().inspect;
 const added=path.join(f.tests,'Added.cs');await f.restart();await fs.writeFile(added,source('AddedTests'));
 assert.equal((await f.baseline()).passed,2,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
 await f.restart();await fs.rm(added);assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
 const library=path.join(f.root,'Extra'),extraProject=path.join(library,'Extra.csproj');await fs.mkdir(library);
 await fs.writeFile(extraProject,'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 const initial=await fs.readFile(f.project,'utf8');await fs.writeFile(f.project,initial.replace('</ItemGroup>','<ProjectReference Include="../Extra/Extra.csproj"/></ItemGroup>'));
 await f.restart();assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);
 assert.ok(f.engine.projects.some(project=>project.file===normalizePath(extraProject)));assert.ok(f.engine.projects.find(project=>project.file===normalizePath(f.project)).references.includes(normalizePath(extraProject)));
 await fs.writeFile(f.project,initial);await fs.rm(library,{recursive:true});await f.restart();assert.equal((await f.baseline()).passed,1,f.output.join(''));
 assert.ok(!f.engine.projects.some(project=>project.file===normalizePath(extraProject)));
});

test('failed and cancelled Restore cannot publish persisted graphs before recovery',{timeout:150000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));const initial=f.counts().inspect;
 await f.restart();await fs.writeFile(f.failure,'fail');await assert.rejects(f.baseline(),/controlled restart restore failure/);
 assert.equal(f.engine.projects.length,0);assert.equal(f.counts().inspect,initial);await fs.rm(f.failure);
 const restored=deferred(),abort=new AbortController();f.afterRestore(async(_dotnet,_files,_configuration,options)=>{
  restored.resolve();await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});options.signal.throwIfAborted();
 });
 const run=f.baseline(abort.signal);void run.catch(()=>undefined);
 await Promise.race([restored.promise,run.then(()=>{throw new Error('run finished before controlled Restore barrier');})]);abort.abort();await assert.rejects(run);
 assert.equal(f.engine.projects.length,0);assert.equal(f.counts().inspect,initial);f.afterRestore(undefined);
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.equal(f.counts().inspect,initial,'a cancelled lazy reuse attempt can still retry the exact persisted graph');
});

test('post-Restore analyzer and SDK changes invalidate disk candidates before publication',{timeout:150000},async t=>{
 const f=await fixture(t,{privateAnalyzer:true});assert.equal((await f.baseline()).passed,1,f.output.join(''));let count=f.counts().inspect;
 await f.restart();f.afterRestore(async()=>{f.afterRestore(undefined);await fs.appendFile(f.analyzer,'\nTesty restart analyzer identity\n');});
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
 await f.restart();const pin=path.join(f.tests,'global.json');f.afterRestore(async()=>{f.afterRestore(undefined);await fs.writeFile(pin,JSON.stringify({sdk:{version:'99.0.100',rollForward:'disable'}}));});
 await assert.rejects(f.baseline(),/SDK|99\.0\.100/);assert.equal(f.engine.projects.length,0);assert.equal(f.counts().inspect,count);
 await fs.rm(pin);assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.equal(f.counts().inspect,count);
 await f.restart();f.config.configuration='Release';assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);
});

test('corrupt restart snapshots and unsupported arbitrary evaluations fall back to fresh inspection',{timeout:120000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));let count=f.counts().inspect;
 await f.restart();await fs.writeFile(path.join(f.storage,'project-evaluations-v1.json'),'{interrupted');
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
 const flag=path.join(f.temp,'flag.txt');await fs.writeFile(flag,'FIRST');await fs.writeFile(f.project,(await fs.readFile(f.project,'utf8')).replace('</PropertyGroup>',`<DefineConstants>$([System.IO.File]::ReadAllText('${xml(flag)}'))</DefineConstants></PropertyGroup>`));
 await f.restart();assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count);count=f.counts().inspect;
 await f.restart();await fs.writeFile(flag,'OTHER');assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(f.counts().inspect>count,'unknown arbitrary evaluation inputs never gain trust through persistence');
});
