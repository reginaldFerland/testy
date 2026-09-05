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
