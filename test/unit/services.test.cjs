const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {setTimeout: delay} = require('node:timers/promises');
const {CoverageStore} = require('../../out/core/coverage');
const {CoverageCache} = require('../../out/services/cache');
const {SourceTracker} = require('../../out/services/sources');
const {ProjectIndex, selectTests} = require('../../out/core/selection');
const {buildOrder} = require('../../out/services/projects');
const {copyOutput, PreparedOutput} = require('../../out/services/output');
const {installCoverageTool} = require('../../out/services/coverageTool');
const {withLock} = require('../../out/services/lock');
const {startProcess} = require('../../out/services/process');

async function temporary(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy services '));
 t.after(()=>fs.rm(root,{recursive:true,force:true})); return root;
}
function trace(groupId='one',hash='v1') {
 return {groupId,dependencies:['/code.cs','/tests.cs'],inputs:{'/code.cs':hash,'/tests.cs':'test1'},timestamp:1,reliable:true,
  coverage:[{file:'/code.cs',hash,lines:[{line:1,hits:1},{line:2,hits:0}]}]};
}

test('coverage caches summaries and shares zero-hit geometry; changed test inputs mark production stale',()=>{
 const store=new CoverageStore(); store.replace([trace(),trace('two')],new Set(['one','two']));
 const hashes=new Map([['/code.cs','v1'],['/tests.cs','test1']]);
 const summary=store.summarize(hashes);
 assert.equal(store.summarize(hashes),summary);
 const delta=store.takeDelta(); assert.equal(delta.sources.length,1);assert.equal(delta.traces[0].coverage[0].lines.length,1);
 assert.equal(summary[0].stale,false);
 const changedHashes=new Map(hashes);changedHashes.set('/tests.cs','test2');
 const changed=store.summarize(changedHashes);
 assert.equal(changed[0].stale,true);assert.equal(store.traces.get('one').reliable,true);
 assert.equal(store.summary('/code.cs',changedHashes).stale,true);
});

test('cache tolerates corruption, concurrent writers and orphaned geometry',async t=>{
 const root=await temporary(t), first=new CoverageStore(), second=new CoverageStore();
 first.replace([trace()],new Set(['one']));second.replace([trace('two')],new Set(['two']));
 const a=new CoverageCache(root,()=>{}), b=new CoverageCache(root,()=>{});
 await Promise.all([a.save(first.takeDelta()),b.save(second.takeDelta())]);
 await fs.writeFile(path.join(root,'coverage-v2/traces',`${'a'.repeat(64)}.json`),'{broken');
 await fs.writeFile(path.join(root,'coverage-v2/traces',`${'b'.repeat(64)}.json`),JSON.stringify({groupId:'bad',sourceIds:[],inputs:[],coverage:[]}));
 const restored=new CoverageStore();await a.restore(restored);
 assert.equal(restored.traces.size,2);
 assert.ok([...restored.traces.values()].every(trace=>trace.stale && !trace.reliable));
 first.replace([trace('one','v2')],new Set(['one']));await a.save(first.takeDelta());
 const again=new CoverageStore();await b.restore(again);
 assert.equal(again.traces.size,2);assert.equal(again.traces.get('two').coverage[0].hash,'v1');
});

test('source refresh reuses unchanged hashes, includes aliases and accepts cancellation',async t=>{
 const root=await temporary(t), file=path.join(root,'Code.cs'), source=new SourceTracker();
 await fs.writeFile(file,'global using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;');
 source.setFiles([file]);assert.deepEqual(await source.refresh([file]),[file]);
 const hashes=source.hashes;await source.refresh([file]);assert.equal(source.hashes,hashes);
 assert.deepEqual(source.excludedAliases,['Blind']);
 await fs.writeFile(file,'changed');source.mark([file]);
 const abort=new AbortController();abort.abort();
 await assert.rejects(source.refresh([file],abort.signal),{name:'AbortError'});
 assert.equal(source.hashes,hashes);assert.deepEqual(await source.refresh([file]),[file]);
 await fs.rm(file);assert.deepEqual(await source.refresh([file]),[file]);assert.equal(source.hashes.has(file),false);
});

test('ownership covers linked/multi-target files and binary dependencies; runtime edges bypass static candidates',()=>{
 const lib={file:'/w/Lib.csproj',assembly:'/w/bin/Lib.dll',sourceFiles:['/shared/Code.cs'],references:[],framework:'net10.0'};
 const tests={file:'/w/tests/Tests.csproj',assembly:'/w/tests/Tests.dll',sourceFiles:[],references:[],binaryReferences:[lib.assembly],framework:'net10.0'};
 const second={...lib,framework:'net10.0-windows',assembly:'/w/bin/windows/Lib.dll'};
 const graph=[tests,lib,second], index=new ProjectIndex(graph);
 assert.deepEqual([...index.affected(['/shared/Code.cs'])], [lib.file,tests.file]);
 assert.deepEqual(buildOrder(graph,new Set([tests.file])).map(project=>project.framework),['net10.0','net10.0-windows','net10.0']);
 const group={id:'runtime',project:'/other/plugin/Tests.csproj',file:'/other/plugin/Tests.cs'};
 const selected=selectTests([group],[lib],new Map([['runtime',{...trace('runtime'),dependencies:['/shared/Code.cs']}]]),['/shared/Code.cs'],'affected');
 assert.equal(selected.groups[0],group);
 const unknown=selectTests([group],[lib],new Map(),['/shared/Code.cs'],'affected');
 assert.equal(unknown.groups[0],group,'unmapped dynamic components cannot produce a successful empty run');
 assert.throws(()=>buildOrder([{...lib,references:[tests.file]},{...tests,references:[lib.file]}],new Set([lib.file])),/cycle/);
});

test('prepared output repairs mutated/deleted/new files and never follows links back to build output',async t=>{
 const root=await temporary(t), original=path.join(root,'original'), template=path.join(root,'template'), working=path.join(root,'working');
 await fs.mkdir(path.join(original,'assets'),{recursive:true});await fs.writeFile(path.join(original,'assets/data'),'pristine');
 await fs.writeFile(path.join(original,'assembly.dll'),'original');
 await copyOutput(original,template);const prepared=new PreparedOutput(template,working);await prepared.initialize();
 await fs.writeFile(path.join(working,'assembly.dll'),'modified');await fs.rm(path.join(working,'assets'),{recursive:true});await fs.mkdir(path.join(working,'new'));await fs.writeFile(path.join(working,'new/file'),'new');
 await prepared.restore();assert.equal(await fs.readFile(path.join(working,'assembly.dll'),'utf8'),'original');
 assert.equal(await fs.readFile(path.join(working,'assets/data'),'utf8'),'pristine');
 await assert.rejects(fs.access(path.join(working,'new')));
 if(process.platform !== 'win32') {
  await fs.symlink(path.join(original,'assembly.dll'),path.join(original,'link.dll'));
  const linked=path.join(root,'linked');await copyOutput(original,linked);await fs.writeFile(path.join(linked,'link.dll'),'instrumented');
  assert.equal(await fs.readFile(path.join(original,'assembly.dll'),'utf8'),'original');
  await fs.symlink(original,path.join(original,'cycle'));await assert.rejects(copyOutput(original,path.join(root,'cycle-copy')),/cycle/);
 }
 const abort=new AbortController();abort.abort();await assert.rejects(copyOutput(original,path.join(root,'cancelled'),abort.signal),{name:'AbortError'});
});

test('collector installation is atomic, cancelable and serialized across windows',async t=>{
 const root=await temporary(t), abort=new AbortController();let calls=0;
 const fakeInstall=async(_command,args,options)=>{
  calls++;const directory=args[args.indexOf('--tool-path')+1];
  await fs.writeFile(path.join(directory,process.platform==='win32'?'dotnet-coverage.exe':'dotnet-coverage'),'partial');
  if(calls===1) {abort.abort();options.signal.throwIfAborted();}
  await delay(50);return {code:0,stdout:'',stderr:''};
 };
 await assert.rejects(installCoverageTool('dotnet',root,{cwd:root,signal:abort.signal},fakeInstall),{name:'AbortError'});
 assert.deepEqual(await fs.readdir(root),[]);
 const paths=await Promise.all([installCoverageTool('dotnet',root,{cwd:root},fakeInstall),installCoverageTool('dotnet',root,{cwd:root},fakeInstall)]);
 assert.equal(paths[0],paths[1]);assert.equal(calls,2);await fs.access(paths[0]);
 const waiting=new AbortController();
 await withLock(path.join(root,'lock'),undefined,async()=>{
  const pending=withLock(path.join(root,'lock'),waiting.signal,async()=>assert.fail('cancelled lock must not run'));
  waiting.abort();await assert.rejects(pending,{name:'AbortError'});
 });
});

test('process cancellation terminates its own descendants before completion', {skip:process.platform==='win32'},async t=>{
 const root=await temporary(t), pidFile=path.join(root,'pid');
 const script=`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
 const abort=new AbortController(), processRun=startProcess(process.execPath,['-e',script],{cwd:root,signal:abort.signal});
 let pid;
 for(let n=0;n<100;n++) {try{pid=Number(await fs.readFile(pidFile,'utf8'));break;}catch{await delay(10);}}
 assert.ok(pid);abort.abort();await assert.rejects(processRun.done,{name:'AbortError'});
 let alive=true;
 for(let n=0;n<100 && alive;n++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}
 assert.equal(alive,false);
});
