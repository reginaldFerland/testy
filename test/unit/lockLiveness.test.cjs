const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {currentProcessStamp,isProcessAlive}=require('../../out/services/processStamp');
const {withLock,lockTiming,LockTimeoutError,LockLostError}=require('../../out/services/lock');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');

async function temporary(t,name){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`testy-${name}-`)));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
// Lock heartbeats are unreferenced, so a test that only waits for one needs something else to keep the loop alive.
function keepAlive(t){const timer=setInterval(()=>undefined,1000);t.after(()=>clearInterval(timer));}
function timing(t,changes){const original={...lockTiming};Object.assign(lockTiming,changes);t.after(()=>Object.assign(lockTiming,original));}
const gate=()=>{let open;const closed=new Promise(resolve=>open=resolve);return{closed,open};};

test('a live holder whose heartbeat pauses past the stale limit keeps its lock',async t=>{
 if((await currentProcessStamp()).start===undefined){t.skip('this platform cannot verify process identity');return;}
 const root=await temporary(t,'lock-paused'),lock=path.join(root,'state.lock'),order=[];
 // No heartbeat can fire during the test, as in a suspended laptop or a blocked event loop.
 timing(t,{heartbeatMs:60_000,staleMs:100});
 const hold=gate(),holder=withLock(lock,undefined,async()=>{order.push('holder');await hold.closed;order.push('holder done');});
 await delay(30);
 const contender=withLock(lock,undefined,async()=>{order.push('contender');});
 await delay(500);
 assert.deepEqual(order,['holder'],'a silent heartbeat from a verified live process is not abandonment');
 hold.open();await Promise.all([holder,contender]);
 assert.deepEqual(order,['holder','holder done','contender']);
});

test('a holder that loses its lock aborts its work and fails instead of reporting success',async t=>{
 const root=await temporary(t,'lock-lost'),lock=path.join(root,'state.lock');
 const takeOver=async()=>{const [name]=await fs.readdir(lock);await fs.unlink(path.join(lock,name));};
 timing(t,{heartbeatMs:20});keepAlive(t);
 let reason;
 await assert.rejects(withLock(lock,undefined,async signal=>{
  await takeOver();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  reason=signal.reason;return 'finished';
 }),LockLostError);
 assert.ok(reason instanceof LockLostError,'the work is told through its signal');
 // A takeover between heartbeats is still caught before success is reported.
 timing(t,{heartbeatMs:60_000});
 await assert.rejects(withLock(lock,undefined,async()=>{await takeOver();return 'finished';}),LockLostError);
 assert.equal(await withLock(lock,undefined,async()=>'ordinary locks still work'),'ordinary locks still work');
});

test('lock waits can be bounded, and shutdown paths skip a hung live holder',async t=>{
 const root=await temporary(t,'lock-timeout'),lock=path.join(root,'state.lock'),storage=path.join(root,'prepared');
 const messages=[],lease=await claimPreparedStorage(storage,undefined,{log:message=>messages.push(message)});
 timing(t,{cleanupWaitMs:150});
 const hold=gate(),entered=gate(),holder=withLock(`${storage}.lock`,undefined,async()=>{entered.open();await hold.closed;});
 await entered.closed;
 const other=withLock(lock,undefined,()=>hold.closed);await delay(30);
 const started=Date.now();
 await assert.rejects(withLock(lock,undefined,async()=>'unreachable',{timeoutMs:100}),LockTimeoutError);
 assert.ok(Date.now()-started<30_000);
 await Promise.all([lease.park({marker:true},{entries:1,bytes:1}),lease.dispose()]);
 assert.ok(Date.now()-started<30_000,'park and dispose give up instead of waiting forever');
 assert.ok(messages.some(message=>/busy/.test(message)));
 const owner=JSON.parse(await fs.readFile(`${lease.directory}.owner.json`,'utf8'));
 assert.equal(owner.state,'active','the data stays in place for a later reclaim');
 hold.open();await Promise.all([holder,other]);
});

test('process identity includes the OS start time where it is cheap to read',{skip:!['linux','darwin'].includes(process.platform)},async t=>{
 const module=path.resolve('out/services/processStamp.js');
 const child=spawn(process.execPath,['-e',`require(${JSON.stringify(module)}).currentProcessStamp().then(stamp=>{console.log(JSON.stringify(stamp));setInterval(()=>{},1000);});`],{stdio:['ignore','pipe','ignore']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const stamp=JSON.parse(await new Promise((resolve,reject)=>{child.stdout.once('data',data=>resolve(String(data)));child.once('error',reject);}));
 assert.equal(stamp.pid,child.pid);assert.equal(typeof stamp.start,'string');
 assert.equal(await isProcessAlive(child.pid,stamp),true);
 assert.equal(await isProcessAlive(child.pid,{...stamp,start:'another process that reused this PID'}),false);
 const {start:_start,...older}=stamp;
 assert.equal(await isProcessAlive(child.pid,older),true,'stamps from older versions fall back to the boot check');
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
 assert.equal(await isProcessAlive(child.pid,stamp),false);
});
