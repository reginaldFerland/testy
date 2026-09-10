const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
const projects=require('../../out/services/projects'),processes=require('../../out/services/process');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
const testSource=name=>`using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class ${name} { [TestMethod] public void Pass() => Assert.IsTrue(true); }`;
const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');

async function fixture(t,{privateAnalyzer=false}={}){
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-full-evaluation-'))),root=path.join(temp,'workspace');await fs.mkdir(root);
 const project=path.join(root,'Tests.csproj'),source=path.join(root,'Tests.cs'),payload=path.join(temp,'restore-payload.props');
 const imported=path.join(root,'obj','Tests.csproj.dynamic.props'),marker=path.join(temp,'restored.txt'),failure=path.join(temp,'fail-restore');
 // NuGet's outer Restore invokes this entry target in each restored project.
 // Its side effects happen after project evaluation and before Testy's Inspect.
 await fs.writeFile(project,`<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
 <Target Name="TestyRestoreSideEffects" BeforeTargets="_GenerateRestoreGraphProjectEntry">
 <MakeDir Directories="$(MSBuildProjectDirectory)/obj"/>
 <Copy SourceFiles="${xml(payload)}" DestinationFiles="${xml(imported)}" Condition="Exists('${xml(payload)}')"/>
 <Delete Files="${xml(imported)}" Condition="!Exists('${xml(payload)}')"/>
 <Error Condition="Exists('${xml(failure)}')" Text="controlled restore failure"/>
 <WriteLinesToFile File="${xml(marker)}" Lines="restored" Overwrite="false"/>
 </Target></Project>`);
 await fs.writeFile(source,testSource('SmokeTests'));
 let analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');
 if(privateAnalyzer){const directory=path.join(temp,'analyzer');await fs.cp(path.dirname(analyzer),directory,{recursive:true});analyzer=path.join(directory,path.basename(analyzer));}
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2};
 const output=[],control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]);
 const evaluate=projects.evaluateProjects,restore=projects.restoreProjects,runProcess=processes.runProcess;
 let evaluations=0,restores=0,sdkChecks=0,afterRestore;
 projects.evaluateProjects=async(...args)=>{evaluations++;return evaluate(...args);};
 projects.restoreProjects=async(...args)=>{restores++;await restore(...args);await afterRestore?.(...args);};
 processes.runProcess=(command,args,...rest)=>{if(args.length===1&&args[0]==='--version')sdkChecks++;return runProcess(command,args,...rest);};
 const engine=new TestEngine({roots:[root],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer,configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 t.after(async()=>{control.abort();projects.evaluateProjects=evaluate;projects.restoreProjects=restore;processes.runProcess=runProcess;await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 return{temp,root,project,source,payload,imported,marker,failure,analyzer,config,engine,output,signal,
  counts:()=>({evaluations,restores,sdkChecks}),afterRestore:hook=>{afterRestore=hook;},
  baseline:(extraSignal)=>engine.run({files:[],full:true},extraSignal?AbortSignal.any([signal,extraSignal]):signal),
  manual:()=>engine.run({files:[],full:false},signal,{all:true,groups:new Set(),coverage:false}),
  sourceFiles:()=>engine.projects.find(value=>value.file===normalizePath(project)).sourceFiles,
  markerCount:async()=>(await fs.readFile(marker,'utf8')).trim().split(/\r?\n/).length};
}

test('repeated full baselines preserve SDK checks and real Restore side effects while reusing evaluated graphs',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 const first=f.counts(),markers=await f.markerCount();assert.equal(first.evaluations,1);
 assert.equal((await f.baseline()).passed,1,f.output.join(''));
 assert.equal(f.counts().evaluations,first.evaluations,'unchanged full baseline needs no second Inspect');
 assert.equal(f.counts().restores,first.restores+1,'a full baseline still invokes Restore');
 assert.equal(f.counts().sdkChecks,first.sdkChecks+1,'a full baseline still checks its selected SDK');
 assert.ok(await f.markerCount()>markers,'the real project restore target executed again');
 const full=f.counts();assert.equal((await f.manual()).passed,1,f.output.join(''));
 assert.deepEqual(f.counts(),full,'unchanged manual runs retain their existing restore/evaluation reuse');
 const added=path.join(f.root,'Added.cs');await fs.writeFile(added,testSource('AddedTests'));
 assert.equal((await f.baseline()).passed,2,f.output.join(''));assert.ok(f.sourceFiles().includes(normalizePath(added)));
 const withAdded=f.counts().evaluations;await fs.rm(added);
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok(!f.sourceFiles().includes(normalizePath(added)));
 assert.ok(f.counts().evaluations>withAdded,'deleted default-glob sources invalidate the full-baseline graph');
});

test('full baselines validate imports after Restore creates, changes and removes them',{timeout:90000},async t=>{
 const f=await fixture(t),alpha=path.join(f.temp,'Alpha.cs'),beta=path.join(f.temp,'Beta.cs');
 await fs.writeFile(alpha,testSource('AlphaTests'));await fs.writeFile(beta,testSource('BetaTests'));
 assert.equal((await f.baseline()).passed,1,f.output.join(''));let count=f.counts().evaluations;
 for(const file of [alpha,beta]){
  await fs.writeFile(f.payload,`<Project><ItemGroup><Compile Include="${xml(file)}"/></ItemGroup></Project>`);
  assert.equal((await f.baseline()).passed,2,f.output.join(''));
  assert.ok(f.counts().evaluations>count,'a restored import changes the evaluated compile inventory');count=f.counts().evaluations;
  assert.ok(f.sourceFiles().includes(normalizePath(file)));
  assert.ok(!f.sourceFiles().includes(normalizePath(file===alpha?beta:alpha)));
 }
 await fs.rm(f.payload);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 assert.ok(f.counts().evaluations>count);assert.ok(!f.sourceFiles().includes(normalizePath(beta)));
 await assert.rejects(fs.stat(f.imported),{code:'ENOENT'});
});

test('failed and cancelled restores do not publish a cached or partially refreshed baseline graph',{timeout:120000},async t=>{
 const f=await fixture(t),extra=path.join(f.temp,'Extra.cs');await fs.writeFile(extra,testSource('ExtraTests'));
 assert.equal((await f.baseline()).passed,1,f.output.join(''));
 const original=f.engine.projects,initial=f.counts().evaluations;
 await fs.writeFile(f.payload,`<Project><ItemGroup><Compile Include="${xml(extra)}"/></ItemGroup></Project>`);
 await fs.writeFile(f.failure,'fail');await assert.rejects(f.baseline(),/controlled restore failure/);
 assert.equal(f.engine.projects,original,'failed Restore cannot publish the previously cached graph as a completed refresh');
 assert.equal(f.counts().evaluations,initial);assert.ok((await fs.readFile(f.imported,'utf8')).includes('Extra.cs'));
 await fs.rm(f.failure);assert.equal((await f.baseline()).passed,2,f.output.join(''));
 const recovered=f.engine.projects,inspected=f.counts().evaluations,restored=deferred(),abort=new AbortController();
 await fs.rm(f.payload);
 f.afterRestore(async(_dotnet,_files,_configuration,options)=>{
  restored.resolve();await new Promise(resolve=>{if(options.signal.aborted)resolve();else options.signal.addEventListener('abort',resolve,{once:true});});
  options.signal.throwIfAborted();
 });
 const run=f.baseline(abort.signal);void run.catch(()=>undefined);
 await Promise.race([restored.promise,run.then(()=>{throw new Error('baseline finished before the restore barrier');})]);
 abort.abort();await assert.rejects(run);
 assert.equal(f.engine.projects,recovered);assert.equal(f.counts().evaluations,inspected,'cancelled Restore cannot publish post-restore cache validation');
 f.afterRestore(undefined);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 assert.ok(!f.sourceFiles().includes(normalizePath(extra)));assert.ok(f.counts().evaluations>inspected);
});

test('a nearer SDK pin introduced during Restore receives a fresh SDK check before graph publication',{timeout:90000},async t=>{
 const f=await fixture(t);assert.equal((await f.baseline()).passed,1,f.output.join(''));
 const original=f.engine.projects,before=f.counts(),pin=path.join(f.root,'global.json');
 f.afterRestore(async()=>fs.writeFile(pin,JSON.stringify({sdk:{version:'99.0.100',rollForward:'disable'}})));
 await assert.rejects(f.baseline(),/SDK|99\.0\.100/);
 assert.equal(f.engine.projects,original);assert.equal(f.counts().evaluations,before.evaluations);
 assert.equal(f.counts().sdkChecks,before.sdkChecks+2,'checks both the original SDK and the newly introduced pin');
 f.afterRestore(undefined);await fs.rm(pin);
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.equal(f.counts().evaluations,before.evaluations);
});

test('analyzer identity is refreshed after Restore before reusing full-baseline evaluations',{timeout:90000},async t=>{
 const f=await fixture(t,{privateAnalyzer:true});assert.equal((await f.baseline()).passed,1,f.output.join(''));
 const before=f.counts().evaluations,bytes=(await fs.stat(f.analyzer)).size;
 // A valid PE overlay changes the task-owned assembly identity without changing
 // its behavior, so the next real Inspect can still complete and run the tests.
 f.afterRestore(async()=>{f.afterRestore(undefined);await fs.appendFile(f.analyzer,'\nTesty evaluation identity regression\n');});
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.ok((await fs.stat(f.analyzer)).size>bytes);
 assert.equal(f.counts().evaluations,before+1,'Restore cannot bless an old graph using a pre-Restore analyzer identity');
 assert.equal((await f.baseline()).passed,1,f.output.join(''));assert.equal(f.counts().evaluations,before+1,'admission records the refreshed identity');
});
