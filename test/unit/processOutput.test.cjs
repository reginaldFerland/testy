// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OutputTail}=require('../../out/core/outputTail');


test('output tails preserve the exact bounded suffix across trimming and compaction',()=>{
 for(const limit of [0,1,7,8192]) {
  const tail=new OutputTail(limit);let expected='';
  for(let i=0;i<5000;i++){const text=`${i}🌍`;expected=limit?(expected+text).slice(-limit):'';tail.append(text);}
  assert.equal(tail.text(),expected);
  const long='z'.repeat(10000);tail.append(long);assert.equal(tail.text(),limit?long.slice(-limit):'');
 }
});

test('process output decodes split UTF-8 and bounds both streams to 1 MiB',async()=>{
 const {runProcess}=require('../../out/services/process');
 const script='const fs=require("node:fs");for(const fd of [1,2]){for(let i=0;i<144;i++)fs.writeSync(fd,Buffer.alloc(65536,fd===1?65:66));for(const byte of Buffer.from("🌍 end"))fs.writeSync(fd,Buffer.from([byte]));}';
 const result=await runProcess(process.execPath,['-e',script],{cwd:process.cwd(),timeoutMs:10000});assert.equal(result.code,0);
 for(const [value,char] of [[result.stdout,'A'],[result.stderr,'B']]){assert.equal(value.length,1024*1024);assert.equal(value,char.repeat(1024*1024-'🌍 end'.length)+'🌍 end');}
});

test('a child error after spawn kills the owned tree and releases listeners before rejecting',async t=>{
 const {startProcess}=require('../../out/services/process'),{getEventListeners}=require('node:events');
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{setTimeout:delay}=require('node:timers/promises');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-process-error-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const pidFile=path.join(root,'pid'),abort=new AbortController();
 const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
 const owned=startProcess(process.execPath,['-e',script],{cwd:root,signal:abort.signal,timeoutMs:60000});
 let pid;
 for(let n=0;n<500 && !pid;n++){pid=Number(await fs.readFile(pidFile,'utf8').catch(()=>''))||undefined;if(!pid)await delay(10);}
 assert.ok(pid);
 let closed=false;owned.child.once('close',()=>{closed=true;});
 // Simulates a failed kill: the child reports an error while its tree still runs.
 const failure=new Error('kill EPERM');owned.child.emit('error',failure);
 await assert.rejects(owned.done,error=>error===failure);
 assert.equal(closed,true,'completion must wait for the tree to close');
 assert.equal(getEventListeners(abort.signal,'abort').length,0);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('below-normal priority applies to owned commands and their descendants, normal priority leaves them unchanged',{skip:process.platform==='win32'&&'POSIX nice values'},async t=>{
 const {runProcess,setProcessPriority}=require('../../out/services/process');
 t.after(()=>setProcessPriority('normal'));
 const script='const {spawnSync}=require("node:child_process");const os=require("node:os");const child=spawnSync(process.execPath,["-e","process.stdout.write(String(require(\\"node:os\\").getPriority()))"],{encoding:"utf8"});process.stdout.write(os.getPriority()+" "+child.stdout);';
 const base=require('node:os').getPriority();
 setProcessPriority('belowNormal');
 const lowered=(await runProcess(process.execPath,['-e',script],{cwd:process.cwd(),timeoutMs:10000})).stdout.trim().split(' ').map(Number);
 assert.deepEqual(lowered,[Math.max(base,10),Math.max(base,10)]);
 setProcessPriority('normal');
 const normal=(await runProcess(process.execPath,['-e',script],{cwd:process.cwd(),timeoutMs:10000})).stdout.trim().split(' ').map(Number);
 assert.deepEqual(normal,[base,base]);
});

test('tree memory sums a process and its descendants, and is unknown for a process that does not exist',async t=>{
 const {treeMemory}=require('../../out/services/processMemory');
 const {spawn}=require('node:child_process');
 const script='const {spawn}=require("node:child_process");spawn(process.execPath,["-e","const b=Buffer.alloc(64*1024*1024,1);setInterval(()=>b[0]++,1000)"],{stdio:"ignore"});setInterval(()=>{},1000);';
 const child=spawn(process.execPath,['-e',script],{stdio:'ignore',detached:process.platform!=='win32'});
 const pid=/** @type {number} */ (child.pid);
 t.after(()=>{try{process.kill(process.platform==='win32'?pid:-pid,'SIGKILL');}catch{/* gone */}});
 let total;
 for(let attempt=0;attempt<50;attempt++){total=await treeMemory(/** @type {number} */ (child.pid));if((total??0)>64*1024*1024)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok((total??0)>64*1024*1024,`measured ${total}`);
 assert.equal(await treeMemory(2**30),undefined);
});

test('a direct process runs without the owner and is still stopped on cancellation and timeout',async()=>{
 const {runProcess}=require('../../out/services/process');
 const result=await runProcess(process.execPath,['-e','process.stdout.write(String(process.ppid))'],{cwd:process.cwd(),direct:true,timeoutMs:10000});
 assert.equal(Number(result.stdout),process.pid,'the extension host is its parent: no owner in between');
 const abort=new AbortController();const started=Date.now();
 const pending=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),direct:true,signal:abort.signal,timeoutMs:60000});
 setTimeout(()=>abort.abort(),100);
 await assert.rejects(pending,{name:'AbortError'});
 await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),direct:true,timeoutMs:300}),/time limit/);
 assert.ok(Date.now()-started<15000);
});

test('suppression settings exclude each pattern, escaped for XML',()=>{
 const {suppressionSettings,suppressionMarker}=require('../../out/services/analysis');
 const xml=suppressionSettings(['^A\\.B(<[^.]*>)?\\.((M)\\(|.*<M>)']);
 assert.match(xml,/<Configuration><CodeCoverage><Functions><Exclude><Function>\^A\\\.B\(&lt;\[\^\.\]\*&gt;\)\?.*<\/Function><\/Exclude>/);
 assert.ok(suppressionMarker.test('  // Testy: no coverage start'));assert.ok(!suppressionMarker.test('// testy coverage'));
});

test('process tables parse ps and CIM lines alike, skipping headers and blanks',()=>{
 const {rows}=require('../../out/services/processMemory');
 assert.deepEqual(rows('  101     1  2048\n  102   101   512\n\n',1024),[{pid:101,parent:1,bytes:2048*1024},{pid:102,parent:101,bytes:512*1024}]);
 assert.deepEqual(rows('ProcessId ParentProcessId WorkingSetSize\r\n4 0 1000\r\n508 4 2000\r\n',1),[{pid:4,parent:0,bytes:1000},{pid:508,parent:4,bytes:2000}]);
});

/** The priority class of a process the given options start, as PowerShell reports it. @param {Record<string, unknown>} options */
async function windowsPriority(options){
 const {runProcess}=require('../../out/services/process');
 const result=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id $PID).PriorityClass'],{cwd:process.cwd(),timeoutMs:60000,...options});
 return result.stdout.trim();
}

test('[windows] below-normal priority reaches owned, unowned and direct commands, and normal priority leaves them alone',{skip:process.platform!=='win32'&&'Windows only'},async t=>{
 const {setProcessPriority}=require('../../out/services/process');
 t.after(()=>setProcessPriority('normal'));
 setProcessPriority('belowNormal');
 for(const options of [{},{cleanupDescendants:false},{direct:true}])assert.equal(await windowsPriority(options),'BelowNormal',JSON.stringify(options));
 setProcessPriority('normal');
 assert.equal(await windowsPriority({}),'Normal');
});

test('[windows] tree memory reads a process and its descendants through CIM',{skip:process.platform!=='win32'&&'Windows only'},async t=>{
 const {treeMemory}=require('../../out/services/processMemory');
 const {spawn}=require('node:child_process');
 const child=spawn(process.execPath,['-e','const {spawn}=require("node:child_process");spawn(process.execPath,["-e","const b=Buffer.alloc(64*1024*1024,1);setInterval(()=>b[0]++,1000)"],{stdio:"ignore"});setInterval(()=>{},1000);'],{stdio:'ignore'});
 t.after(()=>{try{require('node:child_process').spawnSync('taskkill',['/pid',String(child.pid),'/T','/F']);}catch{/* gone */}});
 let total;
 for(let attempt=0;attempt<30;attempt++){total=await treeMemory(/** @type {number} */ (child.pid));if((total??0)>64*1024*1024)break;await new Promise(resolve=>setTimeout(resolve,500));}
 assert.ok((total??0)>64*1024*1024,`measured ${total}`);
});

test('[windows] a direct process runs without the process host and stops on cancellation',{skip:process.platform!=='win32'&&'Windows only'},async()=>{
 const {runProcess}=require('../../out/services/process');
 const result=await runProcess(process.execPath,['-e','process.stdout.write(String(process.ppid))'],{cwd:process.cwd(),direct:true,timeoutMs:30000});
 assert.equal(Number(result.stdout),process.pid);
 const abort=new AbortController();setTimeout(()=>abort.abort(),200);
 await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),direct:true,signal:abort.signal,timeoutMs:60000}),{name:'AbortError'});
});
