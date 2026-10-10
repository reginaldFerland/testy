const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {currentProcessStamp}=require('../../out/services/processStamp');
const {claimPreparedStorage}=require('../../out/services/preparedStorage');
const {claimRunOutputs,reclaimRunOutputs}=require('../../out/services/runOutputs');
const outputTools=require('../../out/services/output');

/** @param {import('node:test').TestContext} t @param {string} name */
async function temporary(t,name){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),`testy-${name}-`)));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
/** @param {string} file */
const exists=file=>fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const dead=async()=>({...await currentProcessStamp(),boot:1});
/** @param {string} file @param {number} minutes */
const aged=async(file,minutes)=>{const old=new Date(Date.now()-minutes*60_000);await fs.utimes(file,old,old);};
/** Fail removals of the given directories while the returned switch is on. */
/** @param {import('node:test').TestContext} t @param {string[]} directories */
function blocking(t,...directories){
 const remove=outputTools.removeOutput,state={on:true};
 outputTools.removeOutput=async directory=>{if(state.on&&directories.includes(directory)){throw Object.assign(new Error('EBUSY: resource busy or locked'),{code:'EBUSY'});}return remove(directory);};
 t.after(()=>{outputTools.removeOutput=remove;});
 return state;
}
/** @param {string} storage @param {Record<string, unknown>} [changes] */
async function seedParked(storage,changes={}){
 const identity=randomUUID(),directory=path.join(storage,identity);
 await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(directory+'.owner.json',JSON.stringify({version:1,identity,token:randomUUID(),pid:0,state:'parked',parkedAt:1,snapshot:{identity},retention:{entries:1,bytes:1},...changes}));
 return directory;
}

test('prepared storage cleanup that fails is skipped, logged and retried by the next claim',async t=>{
 const storage=path.join(await temporary(t,'storage-cleanup'),'prepared'),/** @type {string[]} */ messages=[];
 const crashed=randomUUID(),crashedDirectory=path.join(storage,crashed);
 await fs.mkdir(crashedDirectory,{recursive:true});
 await fs.writeFile(crashedDirectory+'.owner.json',JSON.stringify({version:1,identity:crashed,token:randomUUID(),pid:process.pid,process:await dead(),state:'active'}));
 const old=await seedParked(storage,{parkedAt:1,retention:{entries:1,bytes:1}}),recent=await seedParked(storage,{parkedAt:2,retention:{entries:1,bytes:1}});
 const stuck=blocking(t,crashedDirectory,old);
 const limits={maxEntries:1,maxBytes:100,log:(/** @type {string} */ message)=>messages.push(message)};
 const lease=await claimPreparedStorage(storage,undefined,limits);
 assert.equal(lease.directory,recent,'the claim still adopts the newest parked container');
 assert.ok(await exists(crashedDirectory)&&await exists(old),'directories that could not be removed stay for later');
 assert.equal(messages.filter((/** @type {string} */ message)=>/could not be removed yet/.test(message)).length,2);
 await lease.dispose();
 stuck.on=false;
 const next=await claimPreparedStorage(storage,undefined,limits);
 assert.equal(await exists(crashedDirectory),false,'the dead owner is reclaimed once its files can be removed');
 assert.equal(next.directory,old,'the leftover container is an ordinary parked container again');
 await next.dispose();assert.equal(await exists(old),false);
});

test('unreadable owner records are reclaimed only after a grace period',async t=>{
 const storage=path.join(await temporary(t,'storage-unreadable'),'prepared');
 const damaged=await seedParked(storage),oversized=await seedParked(storage),fresh=await seedParked(storage),unknown=await seedParked(storage,{version:99});
 await fs.writeFile(damaged+'.owner.json','{partial');await fs.writeFile(oversized+'.owner.json',' '.repeat(4*1024*1024+1));await fs.writeFile(fresh+'.owner.json','{partial');
 await aged(damaged+'.owner.json',11);await aged(oversized+'.owner.json',11);await aged(unknown+'.owner.json',60);
 const lease=await claimPreparedStorage(storage);
 assert.equal(await exists(damaged),false);assert.equal(await exists(damaged+'.owner.json'),false);
 assert.equal(await exists(oversized),false);assert.equal(await exists(oversized+'.owner.json'),false);
 assert.ok(await exists(fresh)&&await exists(fresh+'.owner.json'),'a recent record may still be mid-replacement');
 assert.ok(await exists(unknown)&&await exists(unknown+'.owner.json'),'an unknown version may belong to another release');
 await lease.dispose();
});

test('run output cleanup that fails does not block claims, and unreadable owners are reclaimed after a grace period',async t=>{
 const storage=path.join(await temporary(t,'run-cleanup'),'runs'),/** @type {string[]} */ messages=[];
 const crashed=randomUUID(),damaged=randomUUID(),fresh=randomUUID(),oversized=randomUUID();
 for(const identity of [crashed,damaged,fresh,oversized])await fs.mkdir(path.join(storage,identity),{recursive:true});
 await fs.writeFile(path.join(storage,`${crashed}.owner.json`),JSON.stringify({identity:crashed,pid:process.pid,process:await dead()}));
 await fs.writeFile(path.join(storage,`${damaged}.owner.json`),'not json');await fs.writeFile(path.join(storage,`${fresh}.owner.json`),'not json');
 await fs.writeFile(path.join(storage,`${oversized}.owner.json`),' '.repeat(128*1024));
 await aged(path.join(storage,`${damaged}.owner.json`),11);await aged(path.join(storage,`${oversized}.owner.json`),11);
 const stuck=blocking(t,path.join(storage,crashed));
 /** @param {string} message */
 const log=message=>messages.push(message),lease=await claimRunOutputs(storage,undefined,undefined,log);
 assert.ok(await exists(path.join(storage,crashed)),'the stale output that could not be removed waits for the next attempt');
 assert.ok(messages.some(message=>/could not be removed yet/.test(message)));
 assert.equal(await exists(path.join(storage,damaged)),false);assert.equal(await exists(path.join(storage,oversized)),false);
 assert.ok(await exists(path.join(storage,fresh)));
 stuck.on=false;await reclaimRunOutputs(storage,undefined,log);
 assert.equal(await exists(path.join(storage,crashed)),false);assert.equal(await exists(path.join(storage,`${crashed}.owner.json`)),false);
 await lease.dispose();
});
