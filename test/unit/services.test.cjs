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
const {CoverageReader} = require('../../out/services/coverageReader');
const {normalizePath} = require('../../out/core/paths');

async function temporary(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy services '));
 t.after(()=>fs.rm(root,{recursive:true,force:true})); return root;
}
function trace(groupId='one',hash='v1') {
 return {groupId,dependencies:['/code.cs','/tests.cs'],inputs:{'/code.cs':hash,'/tests.cs':'test1'},timestamp:1,reliable:true,
  coverage:[{file:'/code.cs',hash,lines:[{line:1,hits:1},{line:2,hits:0}]}]};
}

test('cache membership restoration yields, publishes atomically and respects concurrent changes',async t=>{
 const {contentHash}=require('../../out/core/paths'),{setImmediate:turn}=require('node:timers/promises');
 const sources=Array.from({length:1000},(_,i)=>({file:`/Source${i}.cs`,hash:'v1',id:contentHash(`/Source${i}.cs\0v1`),lines:[1,2]}));
 const sourceIds=sources.map(source=>source.id);
 const traces=Array.from({length:200},(_,i)=>({groupId:`group${i}`,sourceIds,dependencies:[`/Source${i}.cs`],inputs:{[`/Source${i}.cs`]:'v1'},reliable:true,stale:false,timestamp:1,
  coverage:[{file:`/Source${i}.cs`,hash:'v1',lines:[{line:1,hits:1}]}]}));
 const store=new CoverageStore();store.replace([trace()],new Set(['one']));
 const abort=new AbortController(),pending=store.restorePackedAsync(sources,traces,abort.signal);
 await turn();assert.equal(store.traces.size,1);assert.ok(store.traces.has('one'),'no partial restored state is visible');
 abort.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(store.traces.has('one'));
 const competing=store.restorePackedAsync(sources,traces);await turn();store.replace([trace('live')],new Set(['live']));await competing;
 assert.deepEqual([...store.traces.keys()],['live'],'new live state takes precedence over restored history');
 const root=await temporary(t);await new CoverageCache(root,()=>{}).save({sources,traces,removedSources:[],removedTraces:[]});
 let beats=0;const timer=setInterval(()=>beats++,1);
 try {await new CoverageCache(root,()=>{}).restore(store);}finally{clearInterval(timer);}
 assert.ok(beats>1);assert.equal(store.traces.size,200);assert.equal(store.traces.has('live'),false);
 assert.deepEqual([...store.dependentGroups(['/Source199.cs'])],['group199']);
 const summary=store.summary('/Source999.cs',new Map([['/Source999.cs','v1']]));
 assert.equal(summary.groupIds.length,200);assert.equal(summary.total,2);assert.equal(summary.covered,0);assert.equal(summary.stale,true);
 assert.deepEqual(store.takeDelta(),{sources:[],traces:[],removedSources:[],removedTraces:[]});
 let release,acquired;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>acquired=resolve);
 const lock=withLock(path.join(root,'coverage-v2.lock'),undefined,async()=>{acquired();await gate;});await ready;
 const waiting=new CoverageCache(root,()=>{}).restore(store);
 try {store.replace([trace('newer')],new Set(['newer']));}finally{release();await lock;}
 await waiting;assert.deepEqual([...store.traces.keys()],['newer'],'changes during disk I/O or lock waits also take precedence');
});

test('run output leases reclaim dead hosts and preserve live or unknown ownership',async t=>{
 const {claimRunOutputs,reclaimRunOutputs}=require('../../out/services/runOutputs'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
 const root=await temporary(t),storage=path.join(root,'runs'),ready=path.join(root,'ready');
 const live=await claimRunOutputs(storage),unknown=path.join(storage,randomUUID());await fs.mkdir(unknown);
 const script=`const fs=require('node:fs/promises');const {claimRunOutputs}=require(${JSON.stringify(path.resolve('out/services/runOutputs.js'))});(async()=>{const lease=await claimRunOutputs(${JSON.stringify(storage)});await fs.writeFile(lease.directory+'/asset','output');await fs.writeFile(${JSON.stringify(ready)},lease.directory);setInterval(()=>{},1000);})();`;
 const child=spawn(process.execPath,['-e',script],{stdio:'ignore'});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 let abandoned;
 for(let i=0;i<200;i++){try{abandoned=await fs.readFile(ready,'utf8');break;}catch{await delay(10);}}
 assert.ok(abandoned);await reclaimRunOutputs(storage);await fs.access(abandoned);await fs.access(live.directory);
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
 await reclaimRunOutputs(storage);await assert.rejects(fs.access(abandoned),{code:'ENOENT'});await fs.access(live.directory);await fs.access(unknown);
 await assert.rejects(claimRunOutputs(storage,path.basename(live.directory)),{code:'EEXIST'});await fs.access(live.directory);
 const abort=new AbortController();abort.abort();await assert.rejects(claimRunOutputs(storage,undefined,abort.signal),{name:'AbortError'});
 await live.dispose();await live.dispose();assert.deepEqual(await fs.readdir(storage),[path.basename(unknown)]);
});

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

test('zero-hit coverage becomes stale with its test and recovers without losing geometry',()=>{
 const store=new CoverageStore(), hashes=new Map([['/code.cs','v1'],['/tests.cs','test1']]);
 const zero={...trace(),dependencies:['/tests.cs'],inputs:{'/tests.cs':'test1'},coverage:[{file:'/code.cs',hash:'v1',lines:[{line:1,hits:0}]}]};
 store.replace([zero],new Set(['one']));
 assert.equal(store.summary('/code.cs',hashes).stale,false);
 const changed=new Map(hashes);changed.set('/tests.cs','test2');
 assert.equal(store.summary('/code.cs',changed).stale,true);
 store.replace([{...zero,inputs:{'/tests.cs':'test2'}}],new Set(['one']));
 assert.equal(store.summary('/code.cs',changed).stale,false);
 assert.equal(store.summary('/code.cs',changed).total,1);
 store.invalidate(new Set(['one']));assert.equal(store.summary('/code.cs',changed).stale,true);
 const restored=new CoverageStore(), delta=store.takeDelta();restored.restorePacked(delta.sources,delta.traces);
 assert.equal(restored.summary('/code.cs',changed).stale,true);
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

test('cache lock cancellation returns before another writer releases ownership',async t=>{
 const root=await temporary(t), cache=new CoverageCache(root,()=>{}), store=new CoverageStore();
 store.replace([trace()],new Set(['one']));const delta=store.takeDelta();
 let release, acquired;const gate=new Promise(resolve=>release=resolve), ready=new Promise(resolve=>acquired=resolve);
 const held=withLock(path.join(root,'coverage-v2.lock'),undefined,async()=>{acquired();await gate;});await ready;
 const abort=new AbortController();
 try{
  const saving=cache.save(delta,abort.signal);await delay(20);abort.abort();
  await assert.rejects(Promise.race([saving,delay(2000).then(()=>{throw new Error('cancellation waited on cache ownership');})]),{name:'AbortError'});
 }finally{release();await held;}
 store.retryDelta(delta);await cache.save(store.takeDelta());
 const restored=new CoverageStore();await cache.restore(restored);assert.equal(restored.traces.size,1);
});

test('geometry memo avoids rereads but observes concurrent writers and pruning',async t=>{
 const root=await temporary(t), a=new CoverageCache(root,()=>{}), b=new CoverageCache(root,()=>{});
 const store=new CoverageStore();store.replace([trace()],new Set(['one']));const delta=store.takeDelta();
 await a.save(delta);
 const read=fs.readFile;let sourceReads=0;
 fs.readFile=async function(file,...args){if(String(file).includes(`${path.sep}sources${path.sep}`))sourceReads++;return read.call(this,file,...args);};
 try{await a.save(delta);assert.equal(sourceReads,0);}finally{fs.readFile=read;}
 const expanded=new CoverageStore();expanded.replace([{...trace('two'),coverage:[{file:'/code.cs',hash:'v1',lines:[{line:3,hits:1}]}]}],new Set(['two']));
 await b.save(expanded.takeDelta());await a.save(delta);
 const restored=new CoverageStore();await a.restore(restored);
 assert.deepEqual(restored.summary('/code.cs',new Map([['/code.cs','v1'],['/tests.cs','test1']])).lines.map(line=>line.line),[1,2,3]);
 // A different writer can prune everything. The next write must restore its geometry.
 await b.save({sources:[],traces:[],removedSources:[],removedTraces:['one','two']});await b.restore(new CoverageStore());
 await a.save(delta);const again=new CoverageStore();await b.restore(again);assert.equal(again.traces.size,1);
});

test('coverage parsing yields host time, preserves lines, and can be cancelled and reused',async t=>{
 const root=await temporary(t), reader=new CoverageReader();t.after(()=>reader.dispose());
 const file=normalizePath(path.join(root,'Code.cs')), report=path.join(root,'coverage.xml'), hashes=new Map([[file,'v1']]);
 const count=150000;
 await fs.writeFile(report,`<coverage><packages><package><classes><class filename="${file}"><lines>`+
  Array.from({length:count},(_,index)=>`<line number="${index+1}" hits="${index%2}"/>`).join('')+'</lines></class></classes></package></packages></coverage>');
 let beats=0;const timer=setInterval(()=>beats++,5);
 let result;try{result=await reader.read(report,root,hashes);}finally{clearInterval(timer);}
 assert.ok(beats>=3,`parsing must allow the extension host to run, observed ${beats} timer ticks`);
 assert.equal(result[0].file,file);assert.equal(result[0].hash,'v1');assert.equal(result[0].lines.length,count);
 assert.deepEqual(result[0].lines.at(-1),{line:count,hits:1});
 const abort=new AbortController(), pending=reader.read(report,root,hashes,abort.signal);
 const cancelling=setTimeout(()=>abort.abort(),10);
 try{await assert.rejects(pending,{name:'AbortError'});}finally{clearTimeout(cancelling);}
 await fs.writeFile(report,`<coverage><packages><package><classes><class filename="${file}"><lines><line number="3" hits="2"/></lines></class></classes></package></packages></coverage>`);
 assert.deepEqual((await reader.read(report,root,hashes))[0].lines,[{line:3,hits:2}]);
});

test('output copying has a global concurrency bound across a wide tree',async t=>{
 const root=await temporary(t), source=path.join(root,'source'), destination=path.join(root,'copy');
 for(let outer=0;outer<8;outer++)for(let inner=0;inner<4;inner++){
  const dir=path.join(source,String(outer),String(inner));await fs.mkdir(dir,{recursive:true});
  await Promise.all(Array.from({length:4},(_,index)=>fs.writeFile(path.join(dir,`${index}.txt`),'asset')));
 }
 const copy=fs.copyFile;let active=0,peak=0;
 fs.copyFile=async function(...args){active++;peak=Math.max(peak,active);try{await delay(2);return await copy.apply(this,args);}finally{active--;}};
 try{await copyOutput(source,destination);}finally{fs.copyFile=copy;}
 assert.ok(peak>1 && peak<=8,`observed ${peak} concurrent copies`);
 assert.equal(await fs.readFile(path.join(destination,'7','3','3.txt'),'utf8'),'asset');
});

test('source refresh reuses unchanged hashes, includes aliases and accepts cancellation',async t=>{
 const root=await temporary(t), file=path.join(root,'Code.cs'), source=new SourceTracker();
 await fs.writeFile(file,'global using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;');
 source.setFiles([file]);assert.deepEqual(await source.refresh([file]),[file]);
 const hashes=source.hashes;await source.refresh([file]);assert.equal(source.hashes,hashes);
 assert.equal(source.aliasSources.get(file),await fs.readFile(file,'utf8'));
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

test('process cancellation terminates its own descendants before completion',async t=>{
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

test('normal process completion terminates descendants with ignored or inherited output',async t=>{
 const root=await temporary(t);
 for(const stdio of ['ignore','inherit']){
  const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${JSON.stringify(stdio)}});console.log(child.pid);child.unref();`;
  const owned=startProcess(process.execPath,['-e',script],{cwd:root,timeoutMs:10000});
  const result=await owned.done;assert.equal(result.code,0);const pid=Number(result.stdout.trim());assert.ok(pid);
  let alive=true;
  try{
   for(let n=0;n<100 && alive;n++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}
   assert.equal(alive,false,`${stdio} child must not survive a successful run`);
  }finally{if(alive){try{process.kill(pid,'SIGKILL');}catch{}}}
 }
});

test('owned process arguments preserve whitespace, quoting, Unicode and shell characters',async t=>{
 const root=await temporary(t), args=['','space value','double"quote','trailing\\','日本語 😀','$(echo nope) & %PATH%'];
 const result=await startProcess(process.execPath,['-e','console.log(JSON.stringify(process.argv.slice(1)))','--',...args],{cwd:root}).done;
 assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),args);
});

test('project discovery stops between filesystem reads after cancellation',async()=>{
 const {findProjects}=require('../../out/services/projects'),original=fs.readdir;let reads=0;
 const abort=new AbortController();
 fs.readdir=async()=>{reads++;await delay(20);return [{name:'nested',isDirectory:()=>true,isFile:()=>false}];};
 try{const pending=findProjects(['/workspace'],[],abort.signal);setTimeout(()=>abort.abort(),5);await assert.rejects(pending,{name:'AbortError'});assert.equal(reads,1);}
 finally{fs.readdir=original;}
});

test('private output restores read-only assets and inaccessible directories and cleans cancellation damage',async t=>{
 const {removeOutput}=require('../../out/services/output');
 const root=await temporary(t),template=path.join(root,'template'),output=path.join(root,'output');
 await fs.mkdir(path.join(template,'assets'),{recursive:true});await fs.writeFile(path.join(template,'assets','data.txt'),'original');
 const prepared=new PreparedOutput(template,output);await prepared.initialize();
 const assets=path.join(output,'assets'),file=path.join(assets,'data.txt'),mode=(await fs.stat(assets)).mode&0o777;
 await fs.writeFile(file,'changed');await fs.chmod(file,0o444);await fs.chmod(assets,0o000);
 try{
  await prepared.restore();assert.equal(await fs.readFile(file,'utf8'),'original');
  if(process.platform!=='win32')assert.equal((await fs.stat(assets)).mode&0o777,mode);
  await fs.chmod(assets,0o000);await removeOutput(output);assert.equal(await fs.stat(output).catch(()=>null),null);
  await fs.writeFile(output,'replaced root');await prepared.restore();assert.equal(await fs.readFile(file,'utf8'),'original');
 }finally{await removeOutput(output);}
});

test('manual containers include newly discovered children while leaf selections and exclusions remain exact',()=>{
 const {selectManual}=require('../../out/services/engine');
 const tests=ids=>ids.map(id=>({id}));
 const groups=[{id:'file',project:'project',tests:tests(['old','new'])},{id:'new-file',project:'project',tests:tests(['new-file-test'])},{id:'other',project:'other',tests:tests(['other-test'])}];
 const ids=selection=>selectManual(groups,selection).flatMap(group=>group.tests.map(test=>test.id));
 assert.deepEqual(ids({groups:new Set(['file'])}),['old','new']);
 assert.deepEqual(ids({groups:new Set(),projects:new Set(['project']),exclude:{groups:new Set(['file']),tests:new Map([['file',new Set(['old'])]])}}),['new','new-file-test']);
 assert.deepEqual(ids({groups:new Set(['file']),tests:new Map([['file',new Set(['old'])]])}),['old']);
 assert.deepEqual(ids({groups:new Set(),all:true,exclude:{groups:new Set(),projects:new Set(['project'])}}),['other-test']);
});

test('dense caches larger than 16 MiB restore without losing geometry, yield host time and cancel atomically',async t=>{
 const root=await temporary(t), count=1000000, lines=Array.from({length:10000},(_,i)=>({line:i+1,hits:1}));
 const store=new CoverageStore();store.replace([{groupId:'dense',dependencies:[],inputs:{},timestamp:1,reliable:true,
  coverage:Array.from({length:100},(_,i)=>({file:`/source/File${i}.cs`,hash:'v1',lines}))}],new Set(['dense']));
 const warnings=[],cache=new CoverageCache(root,text=>warnings.push(text));await cache.save(store.takeDelta());
 const names=await fs.readdir(path.join(root,'coverage-v2/traces'));
 assert.ok((await fs.stat(path.join(root,'coverage-v2/traces',names[0]))).size>16*1024*1024);
 let beats=0;const timer=setInterval(()=>beats++,5),restored=new CoverageStore();
 try{await cache.restore(restored);}finally{clearInterval(timer);}
 assert.equal(restored.traces.get('dense').coverage.reduce((sum,file)=>sum+file.lines.length,0),count);
 assert.equal((await fs.readdir(path.join(root,'coverage-v2/sources'))).length,100);assert.deepEqual(warnings,[]);assert.ok(beats>=3);
 const target=new CoverageStore(),abort=new AbortController(),pending=cache.restore(target,abort.signal);
 setTimeout(()=>abort.abort(),15);await assert.rejects(pending,{name:'AbortError'});assert.equal(target.traces.size,0);
});


test('private output catches same-size writes within one filesystem timestamp tick',async t=>{
 const root=await temporary(t),template=path.join(root,'template'),working=path.join(root,'working');
 await fs.mkdir(template);await fs.writeFile(path.join(template,'asset'),'original');
 const originalStat=fs.lstat;
 fs.lstat=async function(file,options){const stat=await originalStat.call(this,file,options);if(options?.bigint){stat.ctimeNs=1n;stat.mtimeNs=1n;}return stat;};
 try{
  const prepared=new PreparedOutput(template,working);await prepared.initialize();
  await fs.writeFile(path.join(working,'asset'),'modified');await prepared.restore();
  assert.equal(await fs.readFile(path.join(working,'asset'),'utf8'),'original');
  await fs.writeFile(path.join(working,'asset'),'modified');await prepared.restore();
  assert.equal(await fs.readFile(path.join(working,'asset'),'utf8'),'original');
 }finally{fs.lstat=originalStat;}
});

test('manual snapshots replace shared dependencies and remove vanished roots without evaluating independent projects',async()=>{
 const {refreshProjectSnapshots,mergeProjects,buildOrder}=require('../../out/services/projects');
 const node=(file,references=[],sourceFiles=[])=>({file,framework:'net10.0',assembly:`${file}.dll`,references,sourceFiles});
 const old=new Map([['Tests',[node('Tests',['A']),node('A',['B'],['old.cs']),node('B')]],['A',[node('A',['B']),node('B')]],['B',[node('B')]],['Other',[node('Other')]],['Deleted',[node('Deleted')]]]);
 const fresh=new Map([['Tests',[node('Tests',['B']),node('B',['A']),node('A',[],['new.cs'])]],['A',[node('A',[],['new.cs'])]],['B',[node('B',['A']),node('A',[],['new.cs'])]]]);
 const evaluated=[];
 const snapshots=await refreshProjectSnapshots(old,['Tests','A','B','Other'],['Tests'],async file=>{evaluated.push(file);assert.notEqual(file,'Other');return fresh.get(file);});
 assert.deepEqual(new Set(evaluated),new Set(['Tests','A','B']));assert.equal(snapshots.has('Deleted'),false);
 const projects=mergeProjects([...snapshots.values()].flat());
 assert.deepEqual(buildOrder(projects,new Set(['Tests'])).map(project=>project.file),['A','B','Tests']);
 assert.deepEqual(projects.find(project=>project.file==='A').sourceFiles,['new.cs']);
 assert.equal(old.has('Deleted'),true,'snapshot replacement is atomic');
});

test('cache restoration failure allows startup baseline and cancellation still stops startup',async t=>{
 const {TestEngine}=require('../../out/services/engine');
 const root=await temporary(t),warnings=[];
 await fs.mkdir(path.join(root,'coverage-v2','epoch.json'),{recursive:true});
 const engine=new TestEngine({roots:[],storage:root,events:{output:text=>warnings.push(text)}});
 await engine.restore();assert.match(warnings.join(''),/fresh baseline/);assert.equal(engine.coverage.traces.size,0);
 // Optional cache failure leaves both the damaged path and recoverable data alone.
 assert.equal((await fs.stat(path.join(root,'coverage-v2','epoch.json'))).isDirectory(),true);
 const abort=new AbortController();abort.abort();await assert.rejects(engine.restore(abort.signal),{name:'AbortError'});
});

test('dense checkpoint preparation, aggregation and serialization yield, and aborted replacement retains old coverage',async t=>{
 const root=await temporary(t),store=new CoverageStore(),cache=new CoverageCache(root,()=>{}),count=150000;
 const hashes=new Map([['/code.cs','v1'],['/tests.cs','test1']]);
 const dense={...trace(),coverage:[{file:'/code.cs',hash:'v1',lines:Array.from({length:count},(_,i)=>({line:i+1,hits:1}))}]};
 let beats=0;const timer=setInterval(()=>beats++,1);
 try{
  await store.replaceAsync([dense],new Set(['one']));const packedBeats=beats;
  assert.ok(packedBeats>1,'checkpoint packing must yield, including within one large file');
  const summary=await store.summarizeAsync(hashes);assert.ok(beats>packedBeats,'aggregation must yield');assert.equal(summary[0].covered,count);
  const aggregationBeats=beats;await cache.save(store.takeDelta());assert.ok(beats>aggregationBeats,'serialization must yield');
  const old=store.traces.get('one'),abort=new AbortController();
  const pending=store.replaceAsync([{...dense,timestamp:99}],new Set(['one']),abort.signal);
  setTimeout(()=>abort.abort(),1);await assert.rejects(pending,{name:'AbortError'});assert.equal(store.traces.get('one'),old);
  const restored=new CoverageStore();await cache.restore(restored);
  assert.equal(restored.traces.get('one').coverage[0].lines.length,count);
  assert.deepEqual(restored.summary('/code.cs',hashes).lines,summary[0].lines);
 }finally{clearInterval(timer);}
});

test('detached children are cleaned on normal completion and cancellation without touching unrelated processes',{skip:process.platform==='win32'},async t=>{
 const {spawn}=require('node:child_process');
 const root=await temporary(t),background=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
 t.after(()=>{try{process.kill(background.pid,'SIGKILL');}catch{}});
 for(const cancel of [false,true]){
  const pidFile=path.join(root,`child-${cancel}`),abort=new AbortController();
  const script=`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));${cancel?'setInterval(()=>{},1000);':''}`;
  const owned=startProcess(process.execPath,['-e',script],{cwd:root,signal:abort.signal,cleanupDescendants:true});
  let pid;for(let i=0;i<100;i++){try{pid=Number(await fs.readFile(pidFile,'utf8'));break;}catch{await delay(10);}}
  assert.ok(pid);t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
  if(cancel){abort.abort();await assert.rejects(owned.done,{name:'AbortError'});}else{assert.equal((await owned.done).code,0);}
  let alive=true;for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}
  assert.equal(alive,false);assert.doesNotThrow(()=>process.kill(background.pid,0));
 }
});

test('cancelling streamed cache writes preserves the previous atomic trace and cleans temporary files',async t=>{
 const root=await temporary(t),cache=new CoverageCache(root,()=>{}),store=new CoverageStore();
 store.replace([trace()],new Set(['one']));await cache.save(store.takeDelta());
 const dense={...trace(),timestamp:99,coverage:[{file:'/code.cs',hash:'v1',lines:Array.from({length:50000},(_,i)=>({line:i+1,hits:1}))}]};
 await store.replaceAsync([dense],new Set(['one']));
 const abort=new AbortController(),open=fs.open;let interrupted=false;
 fs.open=async function(file,...args){
  const handle=await open.call(this,file,...args);
  if(String(file).includes(`${path.sep}traces${path.sep}`)&&String(file).endsWith('.tmp')){
   const write=handle.writeFile.bind(handle);
   handle.writeFile=async(...args)=>{await write(...args);interrupted=true;abort.abort();};
  }
  return handle;
 };
 try{await assert.rejects(cache.save(store.takeDelta(),abort.signal),{name:'AbortError'});}finally{fs.open=open;}
 assert.equal(interrupted,true,'cancel while writing the trace, after its first chunk');
 const restored=new CoverageStore();await cache.restore(restored);assert.equal(restored.traces.get('one').timestamp,1);
 assert.equal((await fs.readdir(path.join(root,'coverage-v2/traces'))).some(file=>file.endsWith('.tmp')),false);
});

test('asynchronous summaries retain concurrent editor reads and stale invalidations',async()=>{
 const store=new CoverageStore(),hashes=new Map([['/code.cs','v1'],['/tests.cs','test1']]);
 const dense={...trace(),coverage:[{file:'/code.cs',hash:'v1',lines:Array.from({length:20000},(_,i)=>({line:i+1,hits:1}))}]};
 await store.replaceAsync([dense],new Set(['one']));
 const pending=store.summarizeAsync(hashes);
 store.markStale(new Set(['one']));const editor=store.summary('/code.cs',hashes);
 const summaries=await pending;assert.equal(summaries.length,1);assert.equal(summaries[0],editor);assert.equal(summaries[0].stale,true);
});

test('generated headers are consistently excluded while generator inputs and header removal remain tracked',async t=>{
 const root=await temporary(t),source=new SourceTracker(),generated=path.join(root,'Stamped.cs'),input=path.join(root,'generator.data');
 source.setFiles([generated,input]);
 await fs.writeFile(input,'v1');await fs.writeFile(generated,'// <auto-generated/> v1');
 assert.deepEqual(await source.refresh(source.files),[input]);assert.equal(source.hashes.has(generated),false);
 await fs.writeFile(generated,'// <AUTO-GENERATED/> v2');assert.deepEqual(await source.refresh(source.files),[]);
 await fs.writeFile(input,'v2');assert.deepEqual(await source.refresh(source.files),[input]);
 await fs.writeFile(generated,'class UserCode {}');assert.deepEqual(await source.refresh(source.files),[generated]);assert.equal(source.isGenerated(generated),false);
 await fs.writeFile(generated,'// <auto-generated/> v3');assert.deepEqual(await source.refresh(source.files),[generated]);assert.equal(source.isGenerated(generated),true);
 await fs.rm(generated);assert.deepEqual(await source.refresh(source.files),[]);
 await fs.writeFile(generated,'// <auto-generated/> created during build');assert.deepEqual(await source.refresh(source.files),[]);
});

test('unchanged manual graphs refresh only the selected root, but shared context changes propagate',async()=>{
 const {refreshProjectSnapshots}=require('../../out/services/projects');
 const shared={file:'Lib',framework:'net10.0',assembly:'Lib.dll',references:[],sourceFiles:['a.cs','b.cs'],properties:{Flavor:'Default',Configuration:'Debug'},contextId:'lib',contextReferences:[]};
 const previous=new Map(Array.from({length:8},(_,i)=>[`Test${i}`,[{...shared,file:`Test${i}`,contextId:`test${i}`,contextReferences:['lib']},shared]]));
 let calls=[];
 const unchanged=await refreshProjectSnapshots(previous,[...previous.keys()],['Test0'],async file=>{
  calls.push(file);return previous.get(file).map(node=>({...node,sourceFiles:[...node.sourceFiles].reverse(),properties:{Configuration:'Debug',Flavor:'Default'}})).reverse();
 });
 assert.deepEqual(calls,['Test0']);assert.equal(unchanged.get('Test1'),previous.get('Test1'));
 calls=[];await refreshProjectSnapshots(previous,[...previous.keys()],['Test0'],async file=>{
  calls.push(file);return previous.get(file).map(node=>node.file==='Lib'?{...node,properties:{...node.properties,Flavor:'Updated'}}:node);
 });
 assert.equal(calls.length,8);
});

test('build planning preserves conditional context edges without losing merged source ownership',()=>{
 const {mergeProjects,buildRoots}=require('../../out/services/projects');
 const node=(file,id,edges,entryPoint=false)=>({file,framework:'net10.0',assembly:`${id}.dll`,sourceFiles:[`${id}.cs`],references:[],contextId:id,contextReferences:edges,entryPoint});
 const graph=[node('Tests','tests',['a'],true),node('A','a',['b']),node('B','b',['leaf']),node('A','leaf',[])];
 graph[0].isTestProject=true;graph[0].references=['A'];graph[1].references=['B'];graph[2].references=['A'];
 const merged=mergeProjects(graph),order=buildOrder(merged,new Set(['Tests']));
 assert.deepEqual(order.map(node=>node.contextId),['leaf','b','a','tests']);
 assert.deepEqual(buildRoots(order).map(node=>node.contextId),['tests']);
 assert.deepEqual(merged.find(node=>node.file==='A').sourceFiles,['a.cs','leaf.cs']);
 assert.throws(()=>buildOrder(mergeProjects([...graph.slice(0,3),node('A','leaf',['a'])]),new Set(['Tests'])),/cycle/);
});

test('POSIX owner handles host death and kills detached descendants without touching other processes',{skip:process.platform==='win32',timeout:15000},async t=>{
 const {spawn}=require('node:child_process'),root=await temporary(t),pidFile=path.join(root,'pids'),ownerFile=path.join(root,'owner');
 const background=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 const pids=[background.pid];t.after(()=>{for(const pid of pids){try{process.kill(pid,'SIGKILL');}catch{}}});
 const child=`const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();require('node:fs').writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
 const hostScript=`const owned=require(${JSON.stringify(path.resolve('out/services/process'))}).startProcess(process.execPath,['-e',${JSON.stringify(child)}],{cwd:${JSON.stringify(root)},cleanupDescendants:true});require('node:fs').writeFileSync(${JSON.stringify(ownerFile)},String(owned.child.pid));`;
 const host=spawn(process.execPath,['-e',hostScript],{stdio:'ignore'});pids.push(host.pid);
 let children;for(let i=0;i<300;i++){try{children=JSON.parse(await fs.readFile(pidFile,'utf8'));break;}catch{await delay(10);}}
 assert.ok(children);pids.push(...children,Number(await fs.readFile(ownerFile,'utf8')));
 host.kill('SIGKILL');
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 for(let i=0;i<500&&children.some(alive);i++){await delay(10);}
 assert.deepEqual(children.filter(alive),[]);assert.equal(alive(background.pid),true);
});

test('POSIX supervision handles launch failure, timeout and original Electron environment',{skip:process.platform==='win32'},async t=>{
 const root=await temporary(t);
 const missing=await startProcess(path.join(root,'does not exist'),[],{cwd:root}).done;
 assert.equal(missing.code,127);assert.match(missing.stderr,/ENOENT/);
 const result=await startProcess(process.execPath,['-e','console.log(process.env.ELECTRON_RUN_AS_NODE || "unset")'],{cwd:root,env:{ELECTRON_RUN_AS_NODE:undefined}}).done;
 assert.equal(result.stdout.trim(),'unset');
 await assert.rejects(startProcess(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{cwd:root,timeoutMs:200}).done,/time limit/);
});

test('build roots avoid redundant default contexts ahead of alternate binary consumers',()=>{
 const {buildRoots}=require('../../out/services/projects');
 const node=(id,file,assembly,edges=[])=>({contextId:id,file,framework:'net10.0',assembly,contextReferences:edges,references:[],sourceFiles:[]});
 const special=node('special','Lib','Special.dll'),normal=node('normal','Lib','Lib.dll');
 const consumer={...node('consumer','Consumer','Consumer.dll'),isTestProject:true,entryPoint:true,binaryReferences:['Special.dll']};
 const tests={...node('tests','Tests','Tests.dll',['special']),isTestProject:true,entryPoint:true};
 assert.deepEqual(buildRoots([special,normal,consumer,tests]).map(node=>node.contextId),['special','consumer','tests']);
 // Mutually referencing filenames in different contexts must still retain a root.
 const a=node('a','A','A.dll',['leafB']),b=node('b','B','B.dll',['leafA']);
 const roots=buildRoots([node('leafB','B','B2.dll'),a,node('leafA','A','A2.dll'),b]);
 assert.deepEqual(roots.map(node=>node.contextId),['a']);
});
