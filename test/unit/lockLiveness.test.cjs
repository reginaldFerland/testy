const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {currentProcessStamp,isProcessAlive}=require('../../out/services/processStamp');
const {withLock,lockTiming,LockTimeoutError,LockLostError}=require('../../out/services/lock');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');

/**
 * @param {import('node:test').TestContext} t
 * @param {string} name
 */
async function temporary(t,name){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`testy-${name}-`)));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
// Lock heartbeats are unreferenced, so a test that only waits for one needs something else to keep the loop alive.
/** @param {import('node:test').TestContext} t */
function keepAlive(t){const timer=setInterval(()=>undefined,1000);t.after(()=>clearInterval(timer));}
// Restore the defaults, not the values a previous call in the same test replaced.
const defaults={...lockTiming};
/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, number>} changes
 */
function timing(t,changes){Object.assign(lockTiming,changes);t.after(()=>Object.assign(lockTiming,defaults));}
const gate=()=>{
 /** @type {any} */ let open;const closed=new Promise(resolve=>open=resolve);return{closed,open};
};

test('a live holder whose heartbeat pauses past the stale limit keeps its lock',async t=>{
 if((await currentProcessStamp()).start===undefined){t.skip('this platform cannot verify process identity');return;}
 const root=await temporary(t,'lock-paused'),lock=path.join(root,'state.lock');
 /** @type {string[]} */ const order=[];
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
 // The takeover leaves an ownerless directory, which the next holder reclaims after ownerlessMs.
 timing(t,{heartbeatMs:20,ownerlessMs:200});keepAlive(t);
 /** @type {any} */ let reason;
 await assert.rejects(withLock(lock,undefined,async signal=>{
  const lockSignal=/** @type {AbortSignal} */ (signal);
  await takeOver();
  await new Promise(resolve=>lockSignal.addEventListener('abort',resolve,{once:true}));
  reason=lockSignal.reason;return 'finished';
 }),LockLostError);
 assert.ok(reason instanceof LockLostError,'the work is told through its signal');
 // A takeover between heartbeats is still caught before success is reported.
 timing(t,{heartbeatMs:60_000,ownerlessMs:200});
 await assert.rejects(withLock(lock,undefined,async()=>{await takeOver();return 'finished';}),LockLostError);
 assert.equal(await withLock(lock,undefined,async()=>'ordinary locks still work'),'ordinary locks still work');
});

test('lock waits can be bounded, and shutdown paths skip a hung live holder',async t=>{
 const root=await temporary(t,'lock-timeout'),lock=path.join(root,'state.lock'),storage=path.join(root,'prepared');
 /** @type {string[]} */ const messages=[];
 const lease=await claimPreparedStorage(storage,undefined,{log:(/** @type {string} */ message)=>messages.push(message)});
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
 assert.equal(await isProcessAlive(/** @type {number} */ (child.pid),stamp),true);
 assert.equal(await isProcessAlive(/** @type {number} */ (child.pid),{...stamp,start:'another process that reused this PID'}),false);
 const {start:_start,...older}=stamp;
 assert.equal(await isProcessAlive(/** @type {number} */ (child.pid),older),true,'stamps from older versions fall back to the boot check');
 const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
 assert.equal(await isProcessAlive(/** @type {number} */ (child.pid),stamp),false);
});

/** An owner file for this live process, as a Windows holder writes it (no start time), with an old heartbeat. */
/** @param {string} root */
async function silentHolder(root){
 const lock=path.join(root,'state.lock'),{randomUUID}=require('node:crypto'),owner=path.join(lock,`${process.pid}-${randomUUID()}`);
 await fs.mkdir(lock);await fs.writeFile(owner,JSON.stringify({pid:process.pid,boot:(await currentProcessStamp()).boot}));
 const old=new Date(Date.now()-3_600_000);await fs.utimes(owner,old,old);
 return {lock,owner};
}
/**
 * @param {import('node:test').TestContext} t
 * @param {string} value
 */
function platform(t,value){
 const original=/** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process,'platform'));
 Object.defineProperty(process,'platform',{...original,value});t.after(()=>Object.defineProperty(process,'platform',original));
}

test('POSIX still takes over a start-less live holder after the stale limit',{skip:process.platform==='win32'},async t=>{
 const root=await temporary(t,'lock-posix-stale'),{lock,owner}=await silentHolder(root);
 assert.equal(await withLock(lock,undefined,async()=>'taken over',{timeoutMs:2000}),'taken over');
 await assert.rejects(fs.access(owner),{code:'ENOENT'});
});

test('Windows does not take over a live holder because its heartbeat was silent before the contender arrived',async t=>{
 const root=await temporary(t,'lock-windows-resume'),{lock,owner}=await silentHolder(root);
 platform(t,'win32');
 // An hour-old heartbeat, as seen right after a resume from sleep: the holder still gets its turn.
 await assert.rejects(withLock(lock,undefined,async()=>assert.fail('a live holder must keep its lock'),{timeoutMs:300}),LockTimeoutError);
 await fs.access(owner);
 // Silence that this contender watched continuously for the Windows limit does prove abandonment.
 timing(t,{windowsStaleMs:150});
 assert.equal(await withLock(lock,undefined,async()=>'taken over',{timeoutMs:5000}),'taken over');
 await assert.rejects(fs.access(owner),{code:'ENOENT'});
});

test('Windows restarts its watch when the contender itself was suspended or the heartbeat moved',async t=>{
 const root=await temporary(t,'lock-windows-gap'),{lock,owner}=await silentHolder(root);
 platform(t,'win32');timing(t,{windowsStaleMs:150,heartbeatMs:1000});
 const realNow=Date.now;let offset=0;t.after(()=>{Date.now=realNow;});
 Date.now=()=>realNow()+offset;
 // Each jump is longer than a heartbeat: the contender cannot vouch for the time it was away.
 const jumps=setInterval(()=>{offset+=1500;},20);t.after(()=>clearInterval(jumps));
 await assert.rejects(withLock(lock,AbortSignal.timeout(500),async()=>assert.fail('suspended time is not observed silence')),{name:/^(AbortError|TimeoutError)$/});
 clearInterval(jumps);Date.now=realNow;
 await fs.access(owner);
 // A refreshed heartbeat also restarts the watch.
 const refresh=setInterval(()=>{const now=new Date();void fs.utimes(owner,now,now).catch(()=>undefined);},20);t.after(()=>clearInterval(refresh));
 await assert.rejects(withLock(lock,AbortSignal.timeout(500),async()=>assert.fail('a beating holder keeps its lock')),{name:/^(AbortError|TimeoutError)$/});
 clearInterval(refresh);await fs.access(owner);
});

test('in-process contenders for one lock run in arrival order and a queued waiter honours its timeout and signal',async t=>{
 const root=await temporary(t,'lock-queue'),directory=path.join(root,'lock');
 const first=gate(),order=/** @type {string[]} */ ([]);
 const holder=withLock(directory,undefined,async()=>{order.push('first');await first.closed;});
 const second=withLock(directory,undefined,async()=>{order.push('second');});
 const third=withLock(directory,undefined,async()=>{order.push('third');});
 await assert.rejects(withLock(directory,undefined,async()=>undefined,{timeoutMs:20}),LockTimeoutError);
 const abort=new AbortController(),aborted=withLock(directory,abort.signal,async()=>undefined);abort.abort();
 await assert.rejects(aborted,{name:'AbortError'});
 first.open();await Promise.all([holder,second,third]);
 assert.deepEqual(order,['first','second','third']);
 assert.equal(await withLock(directory,undefined,async()=>'free'),'free');
});
