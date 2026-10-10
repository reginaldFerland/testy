const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),os=require('node:os');
const {normalizePath,normalizePathAsync,pathNormalizer,clearPathCache,isExcluded,matchesPattern}=require('../../out/core/paths');
const {findProjects,refreshProjectSnapshotBatches}=require('../../out/services/projects');

async function temporary(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-paths-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const link=(target,file)=>fs.symlink(target,file,process.platform==='win32'?'junction':'dir');

test('normalization resolves directory aliases for missing files, async variant included',async t=>{
 const root=await temporary(t),real=path.join(root,'real'),alias=path.join(root,'alias');
 await fs.mkdir(real);await link(real,alias);clearPathCache();
 const expected=normalizePath(path.join(real,'sub','Missing.cs'));
 assert.equal(normalizePath(path.join(alias,'sub','Missing.cs')),expected);
 assert.equal(await normalizePathAsync(path.join(alias,'sub','Missing.cs')),expected);
 assert.equal(await normalizePathAsync(path.parse(root).root),normalizePath(path.parse(root).root));
});

test('leaf symlinks resolve every time while directory resolutions are scoped to a normalizer',async t=>{
 const root=await temporary(t),first=path.join(root,'first'),second=path.join(root,'second'),alias=path.join(root,'alias');
 await fs.mkdir(first);await fs.mkdir(second);await fs.writeFile(path.join(first,'A.cs'),'');await fs.writeFile(path.join(second,'A.cs'),'');
 const leaf=path.join(root,'Leaf.cs');await fs.symlink(path.join(first,'A.cs'),leaf);
 assert.equal(normalizePath(leaf),normalizePath(path.join(first,'A.cs')));
 await fs.unlink(leaf);await fs.symlink(path.join(second,'A.cs'),leaf);
 assert.equal(normalizePath(leaf),normalizePath(path.join(second,'A.cs')),'a retargeted leaf is never cached');
 await link(first,alias);const scoped=pathNormalizer();
 assert.equal(scoped(path.join(alias,'A.cs')),normalizePath(path.join(first,'A.cs')));
 await fs.unlink(alias);await link(second,alias);
 assert.equal(pathNormalizer()(path.join(alias,'A.cs')),normalizePath(path.join(second,'A.cs')),'a new normalizer observes the retargeted directory');
 clearPathCache();assert.equal(normalizePath(path.join(alias,'A.cs')),normalizePath(path.join(second,'A.cs')));
});

test('the shared directory cache is bounded and avoids repeated realpath calls',async t=>{
 const root=await temporary(t);await fs.mkdir(path.join(root,'dir'));clearPathCache();
 const original=sync.realpathSync.native;let calls=0;
 sync.realpathSync.native=(...args)=>{calls++;return original(...args);};
 try{
  for(let i=0;i<50;i++){normalizePath(path.join(root,'dir',`File${i}.cs`));}
  assert.equal(calls,1,'one directory resolution serves every sibling, existing or not');
 }finally{sync.realpathSync.native=original;}
 for(let i=0;i<5000;i++){normalizePath(path.join(root,`missing${i}`,'A.cs'));}
});

test('exclude patterns match repeatedly and keep their case-insensitive dotfile semantics',()=>{
 for(let i=0;i<3;i++){
  assert.equal(isExcluded('/w/Bin/Debug/A.cs'),true);assert.equal(isExcluded('/w/.git/x'),true);assert.equal(isExcluded('/w/src/A.cs'),false);
 }
 assert.equal(matchesPattern('/w/proj/Skip/A.cs','Skip/**',['/w/proj']),true);
 assert.equal(matchesPattern('/w/proj/Skip/','Skip/**',['/w/proj']),true);
});

test('project discovery matches csproj case-insensitively and follows symlinked directories once',async t=>{
 const root=await temporary(t),outside=await temporary(t);
 await fs.mkdir(path.join(root,'app'));await fs.writeFile(path.join(root,'app','App.CSPROJ'),'');
 await fs.mkdir(path.join(outside,'shared'));await fs.writeFile(path.join(outside,'shared','Shared.csproj'),'');
 await link(path.join(outside,'shared'),path.join(root,'linked'));
 await link(path.join(outside,'shared'),path.join(root,'again'));
 await link(root,path.join(root,'app','loop'));
 await fs.mkdir(path.join(outside,'bin'));await fs.writeFile(path.join(outside,'bin','Hidden.csproj'),'');await link(path.join(outside,'bin'),path.join(root,'bin'));
 await fs.symlink(path.join(root,'missing-target'),path.join(root,'broken'));
 const projects=await findProjects([root]);
 assert.deepEqual(projects,[normalizePath(path.join(root,'app','App.CSPROJ')),normalizePath(path.join(outside,'shared','Shared.csproj'))].sort());
 assert.deepEqual(await findProjects([root],['**/linked/**','**/linked/','**/again/**','**/again/','**/bin/**','**/bin/']),[normalizePath(path.join(root,'app','App.CSPROJ'))]);
});

test('snapshot comparison is independent of element order, so only real changes touch dependents',async()=>{
 const node=(name,extra={})=>({file:`/w/${name}/${name}.csproj`,framework:'net10.0',assembly:`/w/${name}.dll`,sourceFiles:['b.cs','a.cs'],references:[],...extra});
 const shared=node('Shared'),roots=['A','B'].map(name=>node(name,{references:[shared.file]})),previous=new Map(roots.map(root=>[root.file,[root,shared]])),calls=[];
 const reordered={...shared,sourceFiles:['a.cs','b.cs'],properties:{y:'1',x:'2'}},original={...shared,properties:{x:'2',y:'1'}};
 const baseline=new Map(roots.map(root=>[root.file,[root,original]]));
 await refreshProjectSnapshotBatches(baseline,[...baseline.keys()],[roots[0].file],async files=>{calls.push(files);return new Map(files.map(file=>[file,[baseline.get(file)[0],reordered]]));});
 assert.deepEqual(calls,[[roots[0].file]]);calls.length=0;
 await refreshProjectSnapshotBatches(previous,[...previous.keys()],[roots[0].file],async files=>{calls.push(files);return new Map(files.map(file=>[file,[previous.get(file)[0],{...shared,sourceFiles:['a.cs','c.cs']}]]));});
 assert.deepEqual(calls,[[roots[0].file],[roots[1].file]]);
});
