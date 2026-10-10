const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');

test('the Windows owner host is resolved from PATH, never the working directory',async t=>{
 const cp=require('node:child_process'),original=cp.spawn;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'testy-host-')),work=path.join(root,'work'),bin=path.join(root,'bin');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(work);fs.mkdirSync(bin);fs.writeFileSync(path.join(work,'dotnet.exe'),'planted');fs.writeFileSync(path.join(bin,'dotnet.exe'),'real');
 const {PassThrough}=require('node:stream'),spawned=[];
 cp.spawn=command=>{
  const child=Object.assign(new EventEmitter(),{pid:7,stdin:Object.assign(new EventEmitter(),{writable:true,write(){}}),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
  spawned.push(command);setImmediate(()=>child.emit('close',0));return child;
 };
 const platform=Object.getOwnPropertyDescriptor(process,'platform');
 Object.defineProperty(process,'platform',{value:'win32'});
 t.after(()=>{cp.spawn=original;Object.defineProperty(process,'platform',platform);});
 const {runProcess}=require('../../out/services/process');
 await runProcess('tool.exe',[],{cwd:work,env:{PATH:`.${path.delimiter}${bin}`}});
 const explicit=path.join(work,'custom.exe');
 await runProcess('tool.exe',[],{cwd:work,env:{PATH:bin},dotnetHost:explicit});
 assert.deepEqual(spawned,[path.join(bin,'dotnet.exe'),explicit]);
});
