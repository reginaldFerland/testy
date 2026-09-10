const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {setImmediate:turn,setTimeout:delay}=require('node:timers/promises');
const {PreparedOutput,removeOutput}=require('../../out/services/output');

function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
async function fixture(t,lanes=1,files=24){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-output-reset-')),template=path.join(root,'template');
 await fs.mkdir(path.join(template,'nested','child'),{recursive:true});
 for(let index=0;index<files;index++)await fs.writeFile(path.join(template,`asset-${String(index).padStart(2,'0')}`),'original');
 await fs.writeFile(path.join(template,'nested','child','data'),'nested original');
 const outputs=[];
 for(let index=0;index<lanes;index++){
  const output=new PreparedOutput(template,path.join(root,`lane-${index}`));await output.initialize();outputs.push(output);
 }
 t.after(()=>removeOutput(root));
 return{root,template,outputs};
}

test('unchanged output reset inventories each directory once and avoids unchanged child chmods',async t=>{
 const {outputs:[output]}=await fixture(t),read=fs.readdir,chmod=fs.chmod,reads=new Map(),writes=[];
 fs.readdir=async function(file,...args){if(String(file).startsWith(output.directory)){reads.set(String(file),(reads.get(String(file))??0)+1);}return read.call(this,file,...args);};
 fs.chmod=async function(file,...args){writes.push(String(file));return chmod.call(this,file,...args);};
 try{await output.restore();}finally{fs.readdir=read;fs.chmod=chmod;}
 assert.deepEqual([...reads.values()],[1,1,1],'permission repair and inventory share directory enumeration');
 assert.deepEqual([...reads.keys()].sort(),[output.directory,path.join(output.directory,'nested'),path.join(output.directory,'nested','child')].sort());
 assert.ok(writes.every(file=>file===output.directory),'only a necessary root clock advance can write unchanged modes');
 assert.equal(await fs.readFile(path.join(output.directory,'nested','child','data'),'utf8'),'nested original');
});

test('concurrent lane inventories share one metadata bound and actually overlap',async t=>{
 const {root,outputs}=await fixture(t,4,32),originals=new Map();let active=0,peak=0;
 for(const name of ['lstat','readdir','chmod']){
  const original=fs[name];originals.set(name,original);
  fs[name]=async function(file,...args){
   if(!String(file).startsWith(path.join(root,'lane-')))return original.call(this,file,...args);
   active++;peak=Math.max(peak,active);
   try{await delay(1);return await original.call(this,file,...args);}finally{active--;}
  };
 }
 try{await Promise.all(outputs.map(output=>output.restore()));}
 finally{for(const [name,original]of originals)fs[name]=original;}
 assert.ok(peak>1,'metadata calls overlap within the shared pool');assert.ok(peak<=8,`all lanes share eight metadata operations, saw ${peak}`);
 assert.equal(active,0,'metadata work drains before reset resolves');
});

test('cancelled inventory stops admission and drains pending metadata before retry',{timeout:10000},async t=>{
 const {outputs:[output]}=await fixture(t,1,32),original=fs.lstat,entered=deferred(),release=deferred(),abort=new AbortController();
 let active=0,started=0,settled=false;
 t.after(()=>{release.resolve();fs.lstat=original;});
 await fs.writeFile(path.join(output.directory,'asset-00'),'modified');
 fs.lstat=async function(file,...args){
  if(!String(file).startsWith(path.join(output.directory,'asset-')))return original.call(this,file,...args);
  active++;if(++started===8)entered.resolve();
  try{await release.promise;return await original.call(this,file,...args);}finally{active--;}
 };
 const pending=output.restore(abort.signal),rejected=assert.rejects(pending,{name:'AbortError'}).then(()=>settled=true);
 try{
  await entered.promise;abort.abort();await turn();assert.equal(settled,false,'admitted metadata still belongs to this reset');
  release.resolve();await rejected;assert.equal(active,0);assert.equal(started,8,'cancelled workers do not start later files');
  await turn();assert.equal(started,8,'no metadata work escapes after rejection');
 }finally{release.resolve();await pending.catch(()=>{});fs.lstat=original;}
 await output.restore();assert.equal(await fs.readFile(path.join(output.directory,'asset-00'),'utf8'),'original');
});

test('metadata failure cancels sibling admission and waits for active reads',{timeout:10000},async t=>{
 const {outputs:[output]}=await fixture(t,1,32),original=fs.lstat,entered=deferred(),fail=deferred(),release=deferred();
 let active=0,started=0,settled=false;
 t.after(()=>{fail.resolve();release.resolve();fs.lstat=original;});
 fs.lstat=async function(file,...args){
  if(!String(file).startsWith(path.join(output.directory,'asset-')))return original.call(this,file,...args);
  active++;if(++started===8)entered.resolve();
  try{
   if(path.basename(String(file))==='asset-00'){await fail.promise;throw new Error('controlled metadata failure');}
   await release.promise;return await original.call(this,file,...args);
  }finally{active--;}
 };
 const pending=output.restore(),rejected=assert.rejects(pending,/controlled metadata failure/).then(()=>settled=true);
 try{
  await entered.promise;fail.resolve();await turn();assert.equal(settled,false,'failed reset drains its other admitted reads');
  release.resolve();await rejected;assert.equal(active,0);assert.equal(started,8);
 }finally{fail.resolve();release.resolve();await pending.catch(()=>{});fs.lstat=original;}
 await output.restore();
});

test('combined inventory repairs inaccessible nested directories and restores modes after children', {skip:process.platform==='win32'},async t=>{
 const {outputs:[output]}=await fixture(t),parent=path.join(output.directory,'nested'),child=path.join(parent,'child'),file=path.join(child,'data');
 const expected=new Map(await Promise.all([output.directory,parent,child].map(async directory=>[directory,(await fs.stat(directory)).mode])));
 await fs.writeFile(file,'modified');await fs.chmod(file,0o444);
 await fs.chmod(child,0);await fs.chmod(parent,0);await fs.chmod(output.directory,0);
 const original=fs.chmod,calls=[];
 fs.chmod=async function(file,mode){calls.push([String(file),mode]);return original.call(this,file,mode);};
 try{await output.restore();}finally{fs.chmod=original;}
 assert.equal(await fs.readFile(file,'utf8'),'nested original');
 for(const [directory,mode]of expected)assert.equal((await fs.stat(directory)).mode,mode);
 const restored=calls.filter(([file,mode])=>expected.get(file)===mode).map(([file])=>file);
 assert.deepEqual(restored,[child,parent,output.directory],'restrictive directory modes are restored deepest-first');
});

test('replacement directories and symlinks repair without traversing external targets', {skip:process.platform==='win32'},async t=>{
 const {root,outputs:[output]}=await fixture(t),external=path.join(root,'external'),parent=path.join(output.directory,'nested');
 await fs.mkdir(external);await fs.writeFile(path.join(external,'untouched'),'outside');
 await fs.rm(parent,{recursive:true});await fs.symlink(external,parent);
 await fs.symlink(external,path.join(output.directory,'extra-link'));
 await fs.chmod(external,0);
 const readdir=fs.readdir,chmod=fs.chmod;
 fs.readdir=async function(file,...args){assert.notEqual(String(file),external,'inventory never enumerates a link target');return readdir.call(this,file,...args);};
 fs.chmod=async function(file,...args){assert.notEqual(String(file),external,'permission repair never changes a link target');return chmod.call(this,file,...args);};
 try{await output.restore();}
 finally{fs.readdir=readdir;fs.chmod=chmod;await fs.chmod(external,0o700);}
 assert.equal(await fs.readFile(path.join(parent,'child','data'),'utf8'),'nested original');
 assert.equal(await fs.readFile(path.join(external,'untouched'),'utf8'),'outside');
 assert.equal(await fs.lstat(path.join(output.directory,'extra-link')).catch(()=>undefined),undefined);
 // A replaced root is also removed as a link, not permission-repaired through it.
 await removeOutput(output.directory);await fs.symlink(external,output.directory);await output.restore();
 assert.equal(await fs.readFile(path.join(output.directory,'asset-00'),'utf8'),'original');
 assert.equal(await fs.readFile(path.join(external,'untouched'),'utf8'),'outside');
});

test('conditional root chmod advances a same-tick cohort once without recurring writes',async t=>{
 const {outputs:[previous]}=await fixture(t,1,2),output=new PreparedOutput(previous.template,previous.directory),originalStat=fs.lstat,originalChmod=fs.chmod;
 let rootTime=1n,rootWrites=0;
 fs.lstat=async function(file,options){
  const stat=await originalStat.call(this,file,options);
  if(options?.bigint&&String(file).startsWith(output.directory)){stat.ctimeNs=String(file)===output.directory?rootTime:1n;stat.mtimeNs=1n;}
  return stat;
 };
 fs.chmod=async function(file,...args){if(String(file)===output.directory){rootWrites++;rootTime=2n;}return originalChmod.call(this,file,...args);};
 try{
  // Reinitialize the stamp baseline with a controlled filesystem clock.
  await output.initialize();
  await fs.writeFile(path.join(output.directory,'asset-00'),'modified');await output.restore();
  assert.equal(await fs.readFile(path.join(output.directory,'asset-00'),'utf8'),'original');assert.equal(rootWrites,1);
  await output.restore();assert.equal(rootWrites,1,'after the clock advances stable resets need no chmod');
 }finally{fs.lstat=originalStat;fs.chmod=originalChmod;}
});
