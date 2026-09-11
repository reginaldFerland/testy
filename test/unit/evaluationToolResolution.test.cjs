const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {evaluationToolContext}=require('../../out/services/projectEvaluationCache');

function environment(t,search){
 const relevant=key=>['PATH','PATHEXT','NODEFAULTCURRENTDIRECTORYINEXEPATH'].includes(key.toUpperCase())
  || /^(?:MSBUILD.*SDKRESOLVER|DOTNET_MSBUILD_SDK_RESOLVER|MSBuildSDKsPath|MsBuildCacheFileExistence$)/i.test(key);
 const previous=new Map(Object.keys(process.env).filter(relevant).map(key=>[key,process.env[key]]));
 for(const key of previous.keys())delete process.env[key];
 if(search!==undefined)process.env[process.platform==='win32'?'Path':'PATH']=search;
 t.after(()=>{for(const key of Object.keys(process.env).filter(relevant))delete process.env[key];for(const [key,value]of previous)process.env[key]=value;});
}

async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-evaluation-resolution-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const analyzer=path.join(root,'Testy.Analysis.dll');await fs.writeFile(analyzer,'analyzer fixture');
 const install=async(name,version)=>{
  const directory=path.join(root,name),host=path.join(directory,process.platform==='win32'?'dotnet.exe':'dotnet');
  await fs.mkdir(path.join(directory,'sdk'),{recursive:true});await fs.mkdir(path.join(directory,'host','fxr'),{recursive:true});
  // Native identity fixtures only: these bytes are never executed.
  await fs.writeFile(host,Buffer.from(`7f454c4600${version}`,'hex'),{mode:0o755});
  return{directory,host};
 };
 return{root,analyzer,install,read:(command,cwds,signal)=>evaluationToolContext(command,analyzer,cwds,signal)};
}

test('evaluation identity resolves each inspection cwd and declines different relative-PATH hosts',async t=>{
 const f=await fixture(t),left=await f.install('left/tools','01'),right=await f.install('right/tools','02');
 environment(t,'tools');
 const leftProject=path.dirname(left.directory),rightProject=path.dirname(right.directory);
 const expected=await f.read(left.host,[leftProject]);assert.ok(expected);
 assert.deepEqual(await f.read('dotnet',[leftProject,leftProject]),expected);
 assert.equal(await f.read('dotnet',[leftProject,rightProject]),undefined,'one graph context cannot fingerprint only one of two selected hosts');
 assert.equal((await f.read('dotnet',[rightProject])).root,right.directory);
});

test('evaluation identity preserves POSIX symlink-sensitive parent traversal in commands and PATH',
 {skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),left=await f.install('left','01'),right=await f.install('right','02');
 await fs.mkdir(path.join(right.directory,'sub'));await fs.symlink(path.join(right.directory,'sub'),path.join(left.directory,'link'));
 environment(t,'link/..');
 const expected=await f.read(right.host,[left.directory]);assert.ok(expected);
 for(const command of [`${left.directory}/link/../dotnet`,'./link/../dotnet','dotnet']){
  assert.deepEqual(await f.read(command,[left.directory]),expected,'the lexical left/dotnet shadow is not the executable Node selects');
 }
});

test('evaluation identity preserves literal POSIX backslashes and declines missing PATH evidence',
 {skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),installation=await f.install('installation','01'),project=path.join(f.root,'project');await fs.mkdir(project);
 await fs.symlink(installation.host,path.join(installation.directory,'dotnet\\alias'));
 environment(t,installation.directory);
 const expected=await f.read(installation.host,[project]);assert.ok(expected);
 assert.deepEqual(await f.read('dotnet\\alias',[project]),expected,'backslash in a bare POSIX command is part of its filename');
 delete process.env.PATH;
 assert.equal(await f.read('dotnet',[installation.directory]),undefined,'the platform default search must not be guessed as cwd');
 assert.deepEqual(await f.read(installation.host,[project]),expected,'an explicit host does not need PATH');
});

test('Windows evaluation identity uses mixed-case Path, cwd precedence and selected COM refusal',
 {skip:process.platform!=='win32'},async t=>{
 const f=await fixture(t),left=await f.install('left','01'),right=await f.install('right','02');
 environment(t,right.directory);process.env.Pathext='.BAT;.EXE';
 const leftIdentity=await f.read(left.host,[left.directory]),rightIdentity=await f.read(right.host,[left.directory]);
 assert.ok(leftIdentity);assert.ok(rightIdentity);
 assert.deepEqual(await f.read('dotnet',[left.directory]),leftIdentity,'cwd EXE precedes PATH entries');
 await fs.rm(left.host);
 assert.deepEqual(await f.read('dotnet',[left.directory]),rightIdentity,'mixed-case Path resolves the current host after the cwd shadow disappears');
 await fs.writeFile(path.join(left.directory,'dotnet.com'),Buffer.from('4d5a01020304','hex'));
 assert.equal(await f.read('dotnet',[left.directory]),undefined,'an ineligible selected COM is not skipped for a later eligible dotnet.exe');
});

test('evaluation identity drains admitted reads on cancellation and never returns partial context',
 {timeout:5000},async t=>{
 const f=await fixture(t),installation=await f.install('installation','01');environment(t,undefined);
 const early=new AbortController();early.abort();
 await assert.rejects(f.read(installation.host,[installation.directory],early.signal),{name:'AbortError'});
 let finish,enter;const gate=new Promise(resolve=>{finish=resolve;}),entered=new Promise(resolve=>{enter=resolve;});
 const read=fs.readFile;let admitted=false;
 fs.readFile=async(file,...args)=>{
  if(file===installation.host&&!admitted){admitted=true;enter();await gate;}
  return read(file,...args);
 };
 t.after(()=>{finish();fs.readFile=read;});
 const abort=new AbortController(),pending=f.read(installation.host,[installation.directory],abort.signal);
 const rejected=assert.rejects(pending,{name:'AbortError'});let settled=false;
 void pending.then(()=>{settled=true;},()=>{settled=true;});
 await entered;abort.abort();await Promise.resolve();assert.equal(settled,false,'cache fallback waits for its admitted reader');
 finish();await rejected;
});
