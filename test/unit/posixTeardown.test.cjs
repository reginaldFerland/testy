const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {setImmediate:turn}=require('node:timers/promises');


test('POSIX teardown still scans ownership when group signals fail or escalation is needed',async()=>{
 for(const scenario of ['normal','term','escalation']){
  const file=path.resolve('out/services/posixOwner.js'),control=new EventEmitter(),child=Object.assign(new EventEmitter(),{pid:42}),/** @type {string[]} */ signals=[],/** @type {number[]} */ exits=[];
  let scans=0,/** @type {(() => void) | undefined} */ timer;
  const stderr=Object.assign(new EventEmitter(),{write(){}}),stdout=new EventEmitter();
  const fakeProcess=Object.assign(new EventEmitter(),{stdin:{},env:{},stderr,stdout,exit:/** @param {number} code */ code=>exits.push(code),kill:(/** @type {number} */ _pid,/** @type {string} */ signal)=>{
   signals.push(signal);if(signal===(scenario==='term'?'SIGTERM':'SIGKILL'))throw Object.assign(new Error('denied'),{code:'EPERM'});
  }});
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports:{},process:fakeProcess,setTimeout:(/** @type {() => void} */ callback)=>{timer=callback;return 1;},clearTimeout(){},
   require:(/** @type {string} */ name)=>name==='node:child_process'?{spawn:()=>child}:name==='node:readline'?{createInterface:()=>control}:
    name==='./posixProcesses'?{cleanupPosixOwner:async()=>{scans++;}}:createRequire(file)(name)});
  control.emit('line',JSON.stringify({command:'owned',args:[],owner:'12345678-1234-1234-1234-123456789abc',cleanupDescendants:true}));
  if(scenario==='normal')child.emit('exit',0);
  else {control.emit('close');if(scenario==='escalation')/** @type {() => void} */ (timer)();}
  stdout.emit('error',Object.assign(new Error('host exited'),{code:'EPIPE'}));
  stderr.emit('error',Object.assign(new Error('host exited'),{code:'EPIPE'}));
  await turn();assert.equal(scans,1,scenario);assert.equal(exits.length,1);assert.ok(signals.includes('SIGKILL'));
 }
});

test('one denied descendant does not prevent attempts to terminate other owned descendants',async()=>{
 const file=path.resolve('out/services/posixProcesses.js'),/** @type {any} */ exports={},/** @type {number[]} */ killed=[]; // exports is filled by the vm-evaluated module
 
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,process:{platform:'linux',pid:99,kill:(/** @type {number} */ pid)=>{
  killed.push(pid);if(pid===10)throw Object.assign(new Error('denied'),{code:'EPERM'});
 }},require:(/** @type {string} */ name)=>name==='node:fs/promises'?{readdir:async()=>['10','11'],readFile:async()=> 'TESTY_PROCESS_OWNER=test\0'}:createRequire(file)(name)});
 await assert.rejects(exports.cleanupPosixOwner('test'),/Unable to terminate/);assert.deepEqual(killed,[10,11]);
});
