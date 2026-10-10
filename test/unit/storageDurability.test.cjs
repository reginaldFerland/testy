const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {syncDirectory}=require('../../out/services/jsonWriter');
const {writeEvaluationSnapshot}=require('../../out/services/projectEvaluationStorage');

test('directory sync tolerates platforms that cannot open directories',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-durability-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await syncDirectory(root);
 const open=fs.open;
 for(const code of ['EISDIR','EPERM']){
  fs.open=async()=>{throw Object.assign(new Error(code),{code});};
  try{await syncDirectory(root);}finally{fs.open=open;}
 }
 fs.open=async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};
 try{await assert.rejects(syncDirectory(root),{code:'ENOENT'});}finally{fs.open=open;}
});

test('an evaluation snapshot is flushed before it replaces the previous one, then its directory is flushed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-durability-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const events=[],open=fs.open,rename=fs.rename;
 fs.open=async function(file,flags,...args){
  const handle=await open.call(this,file,flags,...args),name=path.basename(String(file));
  if(name.endsWith('.tmp')){const sync=handle.sync;handle.sync=function(...rest){events.push('sync file');return sync.apply(this,rest);};}
  else if(String(file)===root){events.push('open directory');}
  return handle;
 };
 fs.rename=function(from,to){events.push('rename');return rename.call(this,from,to);};
 try{await writeEvaluationSnapshot(root,new Map());}finally{fs.open=open;fs.rename=rename;}
 assert.deepEqual(events,['sync file','rename','open directory']);
});
