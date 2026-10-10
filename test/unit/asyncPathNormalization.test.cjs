const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {normalizePath,normalizePathsAsync,preparePathNormalizer}=require('../../out/core/paths');
const {discover}=require('../../out/services/runner');

/**
 * Count synchronous filesystem calls made by path normalization while `work` runs.
 * @template T
 * @param {import('node:test').TestContext} t
 * @param {() => T | Promise<T>} work
 */
async function syncCalls(t,work){
 // The fs module's exports are patched in place to count calls.
 const fsm=/** @type {any} */ (fs);
 const original=/** @type {any} */ ({lstatSync:fs.lstatSync,readdirSync:fs.readdirSync,native:fs.realpathSync.native});let calls=0;
 fsm.lstatSync=(/** @type {any[]} */ ...args)=>{calls++;return original.lstatSync(...args);};
 fsm.readdirSync=(/** @type {any[]} */ ...args)=>{calls++;return original.readdirSync(...args);};
 fs.realpathSync.native=(/** @type {any[]} */ ...args)=>{calls++;return original.native(...args);};
 const restore=()=>{fsm.lstatSync=original.lstatSync;fsm.readdirSync=original.readdirSync;fs.realpathSync.native=original.native;};
 t.after(restore);
 try{return{result:await work(),calls:()=>calls};}finally{restore();}
}

/** @param {import('node:test').TestContext} t */
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
 assert.equal(normalize(/** @type {string} */ (prepared[0])),prepared[0],'normalized results are fixed points');
 assert.deepEqual(await normalizePathsAsync(files),prepared);
});

test('discovery resolves test locations without blocking the extension host',async t=>{
 const root=await workspace(t),project=/** @type {import('../../out/core/model').Project} */ (/** @type {unknown} */ ({file:path.join(root,'alias','Tests.csproj'),framework:'net10.0',assembly:path.join(root,'Tests.dll'),sourceFiles:[]})); // minimal project: discovery reads only these fields
 const nodes=Array.from({length:400},(_,index)=>({uid:`t${index}`,'display-name':`T${index}`,'location.file':path.join(root,'alias',`File${index%40}.cs`)}));
 const {result:groups,calls}=await syncCalls(t,()=>discover(project,/** @type {any} */ ({testArguments:[],cwd:root}) /* partial runner options */,nodes));
 assert.equal(calls(),0);
 assert.equal(groups.length,40);
 assert.ok(groups.every(group=>{const file=/** @type {string} */ (group.file);return file===normalizePath(file)&&file.includes('/real/');}));
});

test('prepared normalization observes cancellation',async t=>{
 const root=await workspace(t),abort=new AbortController();abort.abort();
 await assert.rejects(preparePathNormalizer([path.join(root,'alias','File0.cs')],abort.signal),{name:'AbortError'});
});

test('SDK grouping and build planning can resolve their paths without synchronous filesystem calls',async t=>{
 const {sdkContextGroups,buildRoots,buildSnapshotTargets,buildWaves,prepareBuildPaths}=require('../../out/services/projects');
 const root=await workspace(t);
 await io.mkdir(path.join(root,'real','pinned'));await io.writeFile(path.join(root,'real','pinned','global.json'),'{}');
 const files=[path.join(root,'alias','A.csproj'),path.join(root,'alias','pinned','B.csproj'),path.join(root,'real','C.csproj')];
 const {result:groups,calls:groupCalls}=await syncCalls(t,()=>sdkContextGroups(files));
 assert.equal(groupCalls(),0);
 assert.deepEqual(groups.map(group=>group.files.length).sort(),[1,2],'the pinned project uses its own SDK context');
 const shared=path.join(root,'alias','bin');
 /** @type {(name:string,test:boolean)=>import('../../out/core/model').Project} */
 const project=(name,test)=>({runner:'mtp',file:path.join(root,'alias',`${name}.csproj`),framework:'net10.0',assembly:path.join(shared,`${name}.dll`),isTestProject:test,entryPoint:true,
  references:[],sourceFiles:[],outputDirectories:[shared],binaryReferences:test?[path.join(root,'real','bin','Lib.dll')]:[]});
 const projects=[project('Tests',true),project('Lib',false)],roots=buildRoots(projects);
 const expected={targets:[...buildSnapshotTargets(projects,roots)],waves:buildWaves(projects,roots).map(wave=>wave.map(item=>item.file))};
 const {result:normalize,calls:prepareCalls}=await syncCalls(t,()=>prepareBuildPaths(projects));
 const {result:planned,calls:planCalls}=await syncCalls(t,async()=>({targets:[...buildSnapshotTargets(projects,roots,normalize)],
  waves:buildWaves(projects,roots,undefined,normalize).map(wave=>wave.map(item=>item.file))}));
 assert.equal(prepareCalls()+planCalls(),0);
 assert.deepEqual(planned,expected);assert.equal(planned.targets.length,1,'the shared output is snapshotted');
});
