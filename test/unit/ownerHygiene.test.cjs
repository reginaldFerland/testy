const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');

const OWNER='12345678-1234-1234-1234-123456789abc';

/** Narrows a value the test knows is present (type-only; no runtime check). @template T @param {T | null | undefined} value @returns {T} */
const need=value=>/** @type {T} */(value);

/**
 * Load a compiled service in a sandbox with a fake ps, process table and kill.
 * @param {{ platform: string, table: () => [number, string][], environments: Record<number, string>, fileReads?: string[] }} options
 */
function posixProcesses({platform,table,environments,fileReads=[]}){
 /** @type {{ cleanupPosixOwner?: (...args: any[]) => Promise<void> }} */ // sandbox module exports, filled by the evaluated script
 const exports={};
 const file=path.resolve('out/services/posixProcesses.js'),/** @type {string[][]} */ queries=[],/** @type {number[]} */ killed=[];
 const live=new Set(Object.keys(environments).map(Number));
 /** @param {string} command @param {string[]} args */
 const spawn=(command,args)=>{
  const child=Object.assign(new EventEmitter(),{stdout:Object.assign(new EventEmitter(),{setEncoding(){}})});
  queries.push(args);
  setImmediate(()=>{
   let text='',code=0;
   if(args.includes('pid=,etime=')){text=table().filter(([pid])=>live.has(pid)).map(([pid,age])=>`${pid} ${age}`).join('\n');}
   else{
    const wanted=args.includes('-p')?args[args.indexOf('-p')+1].split(',').map(Number):[...live];
    const rows=wanted.filter(pid=>live.has(pid));
    text=rows.map(pid=>`${pid} command ${environments[pid]}`).join('\n');code=rows.length||!args.includes('-p')?0:1;
   }
   child.stdout.emit('data',text);child.emit('close',code);
  });
  return child;
 };
 const fsPromises={readdir:async()=>[...live].map(String),readFile:async (/** @type {string} */ name)=>{
  fileReads.push(name);return `${environments[Number(need(/\/proc\/(\d+)\//.exec(name))[1])]}\0`;
 }};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,process:{platform,pid:99,kill:(/** @type {number} */ pid)=>{killed.push(pid);live.delete(pid);}},
  require:(/** @type {string} */ name)=>name==='node:child_process'?{spawn}:name==='node:fs/promises'?fsPromises:createRequire(file)(name)});
 return{cleanup:(/** @type {any[]} */ ...args)=>need(exports.cleanupPosixOwner)(...args),queries,killed};
}
const owned=`TESTY_PROCESS_OWNER=${OWNER}`;

test('POSIX cleanup reads environments only for processes that started after the launch',async()=>{
 const environments={100:owned,200:'OTHER=1',300:owned,400:owned};
 // 100 and 300 started within the run (5s); 200 and 400 are long-running (400 even carries the nonce, which a descendant cannot).
 const s=posixProcesses({platform:'darwin',environments,table:()=>[[100,'00:04'],[200,'1-02:00:00'],[300,'00:01'],[400,'10:00:00']]});
 await s.cleanup(OWNER,Date.now()-3000);
 assert.deepEqual(s.killed.sort(),[100,300]);
 const environmentQueries=s.queries.filter(args=>args[0]==='eww');
 assert.ok(environmentQueries.length>=1);
 for(const args of environmentQueries) assert.equal(args.includes('-ax')||args.includes('-axo'),false,'must select processes explicitly');
 assert.equal(environmentQueries[0][environmentQueries[0].indexOf('-p')+1],'100,300');
});

test('POSIX cleanup skips the environment scan when nothing started since the launch',async()=>{
 const s=posixProcesses({platform:'darwin',environments:{200:owned},table:()=>[[200,'3-00:00:00']]});
 await s.cleanup(OWNER,Date.now()-1000);
 assert.equal(s.queries.some(args=>args[0]==='eww'),false);assert.deepEqual(s.killed,[]);
});

test('Linux cleanup inspects only candidate /proc entries and still finds an escaped nonce holder',async()=>{
 /** @type {string[]} */ const fileReads=[];
 const s=posixProcesses({platform:'linux',fileReads,environments:{100:owned,200:'OTHER=1',300:'OTHER=2'},table:()=>[[100,'00:02'],[200,'05:00:00'],[300,'00:00']]});
 await s.cleanup(OWNER,Date.now()-1000);
 assert.deepEqual(s.killed,[100]);
 assert.equal(fileReads.some(name=>name.includes('/200/')),false);
});

test('cleanup without a launch time inspects every process',async()=>{
 const s=posixProcesses({platform:'darwin',environments:{100:owned,200:owned},table:()=>[]});
 await s.cleanup(OWNER);
 assert.deepEqual(s.killed.sort(),[100,200]);
 assert.deepEqual([...s.queries[0]],['eww','-axo','pid=,command=']);
});

test('the Windows owner receives code-injecting variables under another name',()=>{
 const file=path.resolve('out/services/process.js'),/** @type {{ startProcess?: (...args: any[]) => { child: EventEmitter } }} */ exports={},/** @type {{ command: string, args: string[], options: { env: Record<string, string | undefined> } }[]} */ spawned=[];
 const child=Object.assign(new EventEmitter(),{pid:7,stdin:Object.assign(new EventEmitter(),{writable:true,write(){}}),
  stdout:Object.assign(new EventEmitter(),{setEncoding(){}}),stderr:Object.assign(new EventEmitter(),{setEncoding(){}})});
 const fakeProcess={platform:'win32',env:{Path:'C:\\bin',DOTNET_STARTUP_HOOKS:'C:\\user.dll'},pid:1,execPath:'node'};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,process:fakeProcess,__dirname:path.dirname(file),setTimeout:()=>({unref(){}}),clearTimeout(){},
  require:(/** @type {string} */ name)=>name==='node:child_process'?{spawn:(/** @type {string} */ command,/** @type {string[]} */ args,/** @type {{ env: Record<string, string | undefined> }} */ options)=>{spawned.push({command,args,options});return child;}}:createRequire(file)(name)});
 const owned=need(exports.startProcess)('C:\\tools\\tool.exe',['a'],{cwd:'C:\\work',env:{DOTNET_STARTUP_HOOKS:'C:\\observer.dll',TESTY_RUNTIME_OBSERVATION:'C:\\manifest.txt'}});
 owned.child.emit('exit',0,null);
 const env=spawned[0].options.env;
 assert.equal(env.DOTNET_STARTUP_HOOKS,undefined);assert.equal(env.TESTY_RUNTIME_OBSERVATION,undefined);
 assert.equal(env.TESTY_CHILD_ENV_DOTNET_STARTUP_HOOKS,'C:\\observer.dll');
 assert.equal(env.TESTY_CHILD_ENV_TESTY_RUNTIME_OBSERVATION,'C:\\manifest.txt');
 assert.equal(env.Path,'C:\\bin');assert.equal(spawned[0].args[1],'C:\\tools\\tool.exe');
});

test('owned commands resolve on PATH only, never in the working directory',async t=>{
 const {resolveOwnedCommand}=require('../../out/services/executable');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'testy-owned-')),work=path.join(root,'work'),bin=path.join(root,'bin');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(work);fs.mkdirSync(bin);fs.writeFileSync(path.join(work,'tool.exe'),'planted');fs.writeFileSync(path.join(bin,'tool.exe'),'real');
 const platform=Object.getOwnPropertyDescriptor(process,'platform');
 Object.defineProperty(process,'platform',{value:'win32'});
 try{
  assert.equal(await resolveOwnedCommand('tool',{PATH:`${bin}${path.delimiter}.`},work),path.join(bin,'tool.exe'));
  assert.equal(await resolveOwnedCommand('tool.exe',{PATH:`.${path.delimiter}${bin}`},work),path.join(bin,'tool.exe'));
  await assert.rejects(resolveOwnedCommand('tool',{PATH:'.'},work),/Cannot find tool/);
  const explicit=path.join(work,'tool.exe');assert.equal(await resolveOwnedCommand(explicit,{PATH:bin},work),explicit);
 }finally{Object.defineProperty(process,'platform',need(platform));}
});

test('the observation manifest names the host assembly for the hook',async t=>{
 const {RuntimeObservation}=require('../../out/services/runtimeObservation');
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'testy-manifest-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const observation=await RuntimeObservation.start(path.join(directory,'reports'),'/work/Tests.dll',[{name:'Plugin',sources:[]}],[]);
 const lines=fs.readFileSync(need(observation.env.TESTY_RUNTIME_OBSERVATION),'utf8').split('\n').map(line=>Buffer.from(line,'base64').toString());
 assert.deepEqual(lines,[path.join(directory,'reports'),'/work/Tests.dll','Plugin']);
});
