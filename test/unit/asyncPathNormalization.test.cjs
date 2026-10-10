const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {normalizePath,normalizePathsAsync,preparePathNormalizer}=require('../../out/core/paths');
const {discover}=require('../../out/services/runner');

/** Count synchronous filesystem calls made by path normalization while `work` runs. */
async function syncCalls(t,work){
 const original={lstatSync:fs.lstatSync,readdirSync:fs.readdirSync,native:fs.realpathSync.native};let calls=0;
 fs.lstatSync=(...args)=>{calls++;return original.lstatSync(...args);};
 fs.readdirSync=(...args)=>{calls++;return original.readdirSync(...args);};
 fs.realpathSync.native=(...args)=>{calls++;return original.native(...args);};
 const restore=()=>{fs.lstatSync=original.lstatSync;fs.readdirSync=original.readdirSync;fs.realpathSync.native=original.native;};
 t.after(restore);
 try{return{result:await work(),calls:()=>calls};}finally{restore();}
}

async function workspace(t){
 const root=await io.mkdtemp(path.join(os.tmpdir(),'testy-async-paths-'));t.after(()=>io.rm(root,{recursive:true,force:true}));
 await io.mkdir(path.join(root,'real'));await io.symlink(path.join(root,'real'),path.join(root,'alias'),'junction');
 for(let index=0;index<40;index++)await io.writeFile(path.join(root,'real',`File${index}.cs`),'');
 return root;
}

test('prepared normalization matches normalizePath without synchronous filesystem calls',async t=>{
 const root=await workspace(t);
 const files=[...Array.from({length:40},(_,index)=>path.join(root,'alias',`File${index}.cs`)),path.join(root,'alias','Missing.cs'),path.join(root,'gone','Deep.cs'),
  ...process.platform==='darwin'?[path.join(root,'alias','file3.CS')]:[]];
 const {result:normalize,calls}=await syncCalls(t,()=>preparePathNormalizer([...files,...files]));
 const prepared=files.map(normalize);
 assert.equal(calls(),0,'resolution happened before lookup, asynchronously');
 assert.deepEqual(prepared,files.map(normalizePath));
 assert.equal(normalize(prepared[0]),prepared[0],'normalized results are fixed points');
 assert.deepEqual(await normalizePathsAsync(files),prepared);
});

test('discovery resolves test locations without blocking the extension host',async t=>{
 const root=await workspace(t),project={file:path.join(root,'alias','Tests.csproj'),framework:'net10.0',assembly:path.join(root,'Tests.dll'),sourceFiles:[]};
 const nodes=Array.from({length:400},(_,index)=>({uid:`t${index}`,'display-name':`T${index}`,'location.file':path.join(root,'alias',`File${index%40}.cs`)}));
 const {result:groups,calls}=await syncCalls(t,()=>discover(project,{testArguments:[],cwd:root},nodes));
 assert.equal(calls(),0);
 assert.equal(groups.length,40);
 assert.ok(groups.every(group=>group.file===normalizePath(group.file)&&group.file.includes('/real/')));
});

test('prepared normalization observes cancellation',async t=>{
 const root=await workspace(t),abort=new AbortController();abort.abort();
 await assert.rejects(preparePathNormalizer([path.join(root,'alias','File0.cs')],abort.signal),{name:'AbortError'});
});
