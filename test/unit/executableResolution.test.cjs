const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {spawn}=require('node:child_process');

// Virtual Windows filesystem tests run on every platform; the final test checks
// actual Node launch selection on Windows rather than a second resolver oracle.
function windows(entries={},parent={PATH:'C:\\inherited'},hooks={}){
 const file=path.resolve('out/services/executable.js'),realRequire=createRequire(file),exports={},calls=[];
 const key=file=>path.win32.normalize(file).toLowerCase(),files=new Map(Object.entries(entries).map(([file,value])=>[key(file),value]));
 const missing=file=>Object.assign(new Error(`missing ${file}`),{code:'ENOENT'});
 const fake={
  async lstat(file){calls.push(['lstat',file]);await hooks.lstat?.(file);const value=files.get(key(file));if(value===undefined)throw missing(file);if(value instanceof Error)throw value;return{isFile:()=>!value?.directory&&!value?.link,isDirectory:()=>!!value?.directory,isSymbolicLink:()=>!!value?.link};},
  async stat(file){calls.push(['stat',file]);await hooks.stat?.(file);const value=files.get(key(file));if(value===undefined)throw missing(file);if(value instanceof Error)throw value;return{isFile:()=>value?.directory!==true};},
  async realpath(file){calls.push(['realpath',file]);await hooks.realpath?.(file);const value=files.get(key(file));if(value===undefined)throw missing(file);return value?.real??path.win32.normalize(file);},
  async access(){throw new Error('Windows resolution must not use POSIX execute bits');}
 };
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,process:{platform:'win32',env:parent},
  require:name=>name==='node:fs/promises'?fake:name==='node:path'?path.win32:realRequire(name)});
 return{...exports,calls,files,key,resolve:(command,env={Path:'C:\\bin'},cwd='C:\\work',signal)=>exports.resolveNodeExecutable(command,env,cwd,signal)};
}

test('Windows env lookup matches Node sorted duplicate precedence including undefined winners',()=>{
 const f=windows();
 assert.equal(f.processEnvironmentValue({Path:'mixed'},'PATH'),'mixed');
 for(const env of [{Path:'ignored',PATH:'selected'},{PATH:'selected',Path:'ignored'}])assert.equal(f.processEnvironmentValue(env,'path'),'selected');
 assert.equal(f.processEnvironmentValue({Path:'ignored',PATH:undefined},'PATH'),undefined);
 assert.equal(f.processEnvironmentValue({Path:'ignored',PATH:''},'PATH'),'');
 assert.equal(f.processEnvironmentValue(Object.assign(Object.create({PATH:'inherited'}),{Path:'ignored'}),'PATH'),'inherited');
 assert.deepEqual(f.calls,[]);
});

test('direct Windows lookup uses Path and inherited fallback but preserves an empty effective PATH',async()=>{
 const f=windows({'C:\\bin\\tool.exe':{},'C:\\inherited\\tool.exe':{}});
 assert.equal(await f.resolve('tool',{Path:'C:\\bin'}),'C:\\bin\\tool.exe');
 assert.equal(await f.resolve('tool',{Path:'C:\\bin',PATH:undefined}),'C:\\inherited\\tool.exe');
 assert.equal(await f.resolve('tool',{Path:'C:\\bin',PATH:''}),undefined);
 assert.equal(await f.resolve('tool',{}),'C:\\inherited\\tool.exe');
});

test('Windows lookup checks cwd before PATH and .com before .exe without PATHEXT expansion',async()=>{
 const f=windows({'C:\\work\\tool.exe':{},'C:\\bin\\tool.com':{},'C:\\bin\\tool.exe':{},'C:\\bin\\tool.bat':{}});
 assert.equal(await f.resolve('tool',{Path:'C:\\bin',PATHEXT:'.BAT;.EXE'}),'C:\\work\\tool.exe');
 f.files.delete(f.key('C:\\work\\tool.exe'));
 assert.equal(await f.resolve('tool',{Path:'C:\\bin',PATHEXT:'.BAT;.EXE'}),'C:\\bin\\tool.com');
 assert.ok(f.calls.every(([,file])=>!file.endsWith('.bat')));
});

test('Windows extension and directory handling matches direct Node forms and ignores shadow directories',async()=>{
 const f=windows({'C:\\work\\tool.exe':{directory:true},'C:\\bin\\tool.exe':{},'C:\\work\\sub\\tool.exe':{},'C:\\bin\\tool.exe.com':{}});
 assert.equal(await f.resolve('tool.exe'),'C:\\bin\\tool.exe');
 assert.equal(await f.resolve('./sub/tool.exe'),'C:\\work\\sub\\tool.exe');
 assert.equal(await f.resolve('.\\sub\\tool.exe'),'C:\\work\\sub\\tool.exe');
 assert.equal(await f.resolve('C:/work/sub/tool.exe'),'C:\\work\\sub\\tool.exe');
 f.files.delete(f.key('C:\\bin\\tool.exe'));
 assert.equal(await f.resolve('tool.exe'),'C:\\bin\\tool.exe.com');
});

test('relative Windows PATH entries resolve freshly against each project cwd',async()=>{
 const f=windows({'C:\\left\\bin\\tool.exe':{},'C:\\right\\bin\\tool.exe':{}});
 assert.equal(await f.resolve('tool',{Path:'bin'},'C:\\left'),'C:\\left\\bin\\tool.exe');
 assert.equal(await f.resolve('tool',{Path:'bin'},'C:\\right'),'C:\\right\\bin\\tool.exe');
});

test('ambiguous Windows path and cwd-search forms decline instead of selecting a guessed host',async()=>{
 const f=windows({'C:\\bin\\tool.exe':{}});
 for(const command of ['C:tool.exe','/bin/tool.exe','./bin/tool','tool.','"tool.exe"','tool:stream.exe',
  '\\\\?\\UNC\\server\\share\\sub\\..\\tool.exe','\\\\.\\C:\\bin\\tool.exe'])assert.equal(await f.resolve(command),undefined,command);
 for(const Path of ['"C:\\bin"','C:bin','\\rooted'])assert.equal(await f.resolve('tool',{Path}),undefined,Path);
 const changed=windows({'C:\\work\\tool.exe':{},'C:\\bin\\tool.exe':{}},{PATH:'C:\\bin',NoDefaultCurrentDirectoryInExePath:'1'});
 assert.equal(await changed.resolve('tool'),undefined);
 assert.equal(await changed.resolve('C:\\bin\\tool.exe'),'C:\\bin\\tool.exe','explicit paths do not depend on cwd search policy');
});

test('a selected Windows candidate is never replaced by a later one after identity failure',async()=>{
 const denied=Object.assign(new Error('selected file denied'),{code:'EACCES'});
 const f=windows({'C:\\work\\tool.exe':{},'C:\\bin\\tool.exe':{}},undefined,{realpath:()=>{throw denied;}});
 await assert.rejects(f.resolve('tool'),error=>error===denied);
 assert.ok(!f.calls.some(([,file])=>file.startsWith('C:\\bin')),'launch cannot fall through after choosing a file');
});

test('uncertain Windows candidates decline while ordinary file symlinks retain canonical identity',async()=>{
 const denied=Object.assign(new Error('unknown candidate metadata'),{code:'EACCES'});
 const f=windows({'C:\\work\\tool.com':denied,'C:\\bin\\tool.exe':{}});
 assert.equal(await f.resolve('tool'),undefined);assert.ok(!f.calls.some(([,file])=>file.startsWith('C:\\bin')));
 const linked=windows({'C:\\work\\tool.exe':{link:true,real:'C:\\installed\\tool.exe'},'C:\\installed\\tool.exe':{},'C:\\bin\\tool.exe':{}});
 assert.equal(await linked.resolve('tool'),'C:\\installed\\tool.exe');
 const broken=windows({'C:\\work\\tool.exe':{link:true},'C:\\bin\\tool.exe':{}},undefined,{realpath:()=>{throw Object.assign(new Error('broken link'),{code:'ENOENT'});}});
 await assert.rejects(broken.resolve('tool'),{code:'ENOENT'});assert.ok(!broken.calls.some(([,file])=>file.startsWith('C:\\bin')));
});

test('resolver cancellation checks before I/O and after an admitted filesystem operation',{timeout:5000},async t=>{
 const early=new AbortController();early.abort();const f=windows();
 await assert.rejects(f.resolve('tool',undefined,undefined,early.signal),{name:'AbortError'});assert.deepEqual(f.calls,[]);
 let finish,entered;const gate=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 t.after(()=>finish());
 const abort=new AbortController(),pendingFs=windows({'C:\\work\\tool.exe':{}},undefined,{realpath:async()=>{entered();await gate;}});
 const pending=pendingFs.resolve('tool',undefined,undefined,abort.signal),rejected=assert.rejects(pending,{name:'AbortError'});
 let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
 await started;abort.abort();await Promise.resolve();assert.equal(settled,false,'the admitted filesystem operation is drained');
 finish();await rejected;
});

test('POSIX resolution retains case-sensitive PATH, execute checks and explicit relative paths',{skip:process.platform==='win32'},async t=>{
 const {resolveNodeExecutable,processEnvironmentValue}=require('../../out/services/executable');
 const root=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'testy-executable-')));t.after(()=>io.rm(root,{recursive:true,force:true}));
 for(const name of ['first','second'])await io.mkdir(path.join(root,name));
 const shadow=path.join(root,'first','tool'),tool=path.join(root,'second','tool');
 await io.writeFile(shadow,'not executable',{mode:0o644});await io.writeFile(tool,'#!/bin/sh\n',{mode:0o755});
 assert.equal(await resolveNodeExecutable('tool',{PATH:['first','second'].join(path.delimiter)},root),tool);
 assert.equal(await resolveNodeExecutable('./second/tool',{},root),tool);
 assert.equal(await resolveNodeExecutable('tool',{},path.dirname(tool)),undefined,'missing PATH does not prove a cwd search');
 assert.equal(await resolveNodeExecutable('tool',{PATH:''},path.dirname(tool)),tool,'an explicit empty PATH does search cwd');
 const escaped=path.join(root,'second','tool\\name');await io.symlink(tool,escaped);
 assert.equal(await resolveNodeExecutable('tool\\name',{PATH:path.dirname(tool)},root),tool,'backslashes remain ordinary POSIX filename characters');
 assert.equal(processEnvironmentValue({Path:'ignored',PATH:'selected'},'PATH'),'selected');
 assert.equal(processEnvironmentValue({Path:'ignored'},'PATH'),undefined);
});

test('POSIX identity preserves symlink-sensitive parent traversal in commands and PATH',
 {skip:process.platform==='win32',timeout:10000},async t=>{
 const {resolveNodeExecutable}=require('../../out/services/executable');
 const root=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'testy-executable-traversal-')));
 t.after(()=>io.rm(root,{recursive:true,force:true}));
 const actual=path.join(root,'actual','tool');await io.mkdir(path.join(root,'actual','sub'),{recursive:true});
 await io.symlink(path.join(root,'actual','sub'),path.join(root,'link'));
 await io.writeFile(actual,'#!/bin/sh\nprintf actual',{mode:0o755});
 await io.writeFile(path.join(root,'tool'),'#!/bin/sh\nprintf wrong',{mode:0o755});
 const execute=require('node:util').promisify(require('node:child_process').execFile);
 const {preparationToolIdentity}=require('../../out/services/preparedOutputCache');
 const expectedIdentity=await preparationToolIdentity(actual,{});
 for(const [command,env] of [[`${root}/link/../tool`,{}],['./link/../tool',{}],['tool',{PATH:'link/..'}]]){
  assert.equal(await resolveNodeExecutable(command,env,root),actual);
  assert.equal(await preparationToolIdentity(command,env,undefined,root),expectedIdentity,'preparation hashes the same actual executable');
  assert.equal((await execute(command,[],{cwd:root,env,timeout:5000})).stdout,'actual','identity follows the real Node launch');
 }
 await assert.rejects(preparationToolIdentity('tool',{},undefined,root),/Cannot identify preparation tool/,'missing PATH cannot prove a cwd executable identity');
});

test('Windows source analysis uses direct Path lookup and declines ambiguous owned commands',{skip:process.platform!=='win32'},async t=>{
 const {sourceAnalysisContext}=require('../../out/services/analysisContext');
 const root=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'testy-analysis-resolution-'))),cwd=path.join(root,'project'),host=path.join(root,'dotnet.exe'),analyzer=path.join(root,'Testy.Analysis.dll');
 t.after(()=>io.rm(root,{recursive:true,force:true}));
 await io.mkdir(cwd);await io.mkdir(path.join(root,'host','fxr','10.0.0'),{recursive:true});await io.mkdir(path.join(root,'shared','Microsoft.NETCore.App','10.0.0'),{recursive:true});
 await io.writeFile(host,Buffer.from('4d5a01020304','hex'));await io.writeFile(analyzer,'analysis helper fixture');
 await io.writeFile(analyzer.replace('.dll','.runtimeconfig.json'),JSON.stringify({runtimeOptions:{framework:{name:'Microsoft.NETCore.App',version:'10.0.0'}}}));
 // Identity-only fixture: fake native bytes are never executed. Preserve the
 // explicit decline tests for CLR/native injection in sourceAnalysisProvenance.
 const prior=new Map(Object.keys(process.env).filter(key=>key.toUpperCase()==='PATH'||key.toUpperCase()==='NODEFAULTCURRENTDIRECTORYINEXEPATH').map(key=>[key,process.env[key]]));
 for(const key of prior.keys())delete process.env[key];
 t.after(()=>{for(const [key,value] of prior)process.env[key]=value;});
 const runtime=/^(?:CORECLR_|COR_|COMPlus_|DOTNET_(?:STARTUP_HOOKS|ADDITIONAL_DEPS|SHARED_STORE|ROOT(?:_|$)|MULTILEVEL_LOOKUP|ROLL_FORWARD|RUNTIME_ID))/i;
 const injection=/^(?:LD_(?:PRELOAD|LIBRARY_PATH|AUDIT|ORIGIN_PATH)|DYLD_(?:INSERT_LIBRARIES|(?:FALLBACK_|VERSIONED_)?(?:LIBRARY|FRAMEWORK)_PATH|ROOT_PATH|IMAGE_SUFFIX|SHARED_CACHE_DIR))$/i;
 const env={...Object.fromEntries(Object.keys(process.env).filter(key=>runtime.test(key)||injection.test(key)).map(key=>[key,undefined])),Path:root,Pathext:'.BAT;.EXE'};
 const options={cwd,env,cleanupDescendants:false};
 const first=await sourceAnalysisContext('dotnet',analyzer,options);assert.ok(first);
 assert.equal(await sourceAnalysisContext(host,analyzer,options),first,'host aliases bind the same exact native file and analyzer assets');
 await io.appendFile(analyzer,'changed helper');assert.notEqual(await sourceAnalysisContext('dotnet',analyzer,options),first);
 assert.equal(await sourceAnalysisContext('dotnet',analyzer,{...options,cleanupDescendants:true}),undefined,'a direct-node result cannot prove bare CreateProcess lookup');
 assert.ok(await sourceAnalysisContext(host,analyzer,{...options,cleanupDescendants:true}),'existing explicit absolute host paths avoid owned search ambiguity');
 await io.writeFile(path.join(root,'dotnet.com'),Buffer.from('4d5a05060708','hex'));
 assert.equal(await sourceAnalysisContext('dotnet',analyzer,options),undefined,'the selected COM candidate is not skipped in favor of a later eligible EXE');
});

test('Windows resolver agrees with actual shell:false launch for cwd and COM/EXE precedence',{skip:process.platform!=='win32',timeout:15000},async t=>{
 const {resolveNodeExecutable}=require('../../out/services/executable');
 const root=await io.realpath(await io.mkdtemp(path.join(os.tmpdir(),'testy-executable-'))),bin=path.join(root,'bin');
 const children=new Set();
 t.after(async()=>{await Promise.all([...children].map(child=>new Promise(resolve=>{child.once('close',resolve);child.kill();})));await io.rm(root,{recursive:true,force:true});});
 await io.mkdir(bin);
 const parentKeys=Object.keys(process.env).filter(key=>key.toUpperCase()==='NODEFAULTCURRENTDIRECTORYINEXEPATH');
 const prior=new Map(parentKeys.map(key=>[key,process.env[key]]));for(const key of parentKeys)delete process.env[key];
 t.after(()=>{for(const [key,value] of prior)process.env[key]=value;});
 const duplicate=async destination=>{try{await io.link(process.execPath,destination);}catch(error){if(error.code!=='EXDEV')throw error;await io.copyFile(process.execPath,destination);}};
 for(const file of [path.join(root,'probe.exe'),path.join(bin,'probe.com'),path.join(bin,'probe.exe')])await duplicate(file);
 const env={...process.env};for(const key of Object.keys(env))if(['PATH','PATHEXT'].includes(key.toUpperCase()))delete env[key];
 env.Path=bin;env.Pathext='.BAT;.EXE';
 const launch=command=>new Promise((resolve,reject)=>{
  const child=spawn(command,['-p','process.execPath'],{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});children.add(child);
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>{stdout+=value;});child.stderr.on('data',value=>{stderr+=value;});
  let failure;child.once('error',error=>{failure=error;});child.once('close',code=>{children.delete(child);if(failure)reject(failure);else if(code!==0)reject(new Error(stderr||`exit ${code}`));else resolve(stdout.trim());});
 });
 const expected=[path.join(root,'probe.exe'),path.join(bin,'probe.com')];
 for(const file of expected){
  const resolved=await resolveNodeExecutable('probe',env,root);assert.equal(resolved?.toLowerCase(),file.toLowerCase());
  assert.equal((await io.realpath(await launch('probe'))).toLowerCase(),resolved.toLowerCase());
  if(file===expected[0])await io.rm(file);
 }
 const explicit=path.join(bin,'probe.exe');assert.equal((await launch(explicit)).toLowerCase(),(await resolveNodeExecutable(explicit,env,root)).toLowerCase());
});
