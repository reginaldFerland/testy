const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {SourceTracker}=require('../../out/services/sources');
const {contentHash,normalizePath}=require('../../out/core/paths');

async function temporary(t){const root=normalizePath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-sources-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('an older slow refresh cannot replace the hashes read by a newer overlapping one',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),file=path.join(root,'A.cs');
 await fs.writeFile(file,'class A {}');sources.setFiles([file]);
 const readFile=fs.readFile;let release,blocked=true;const gate=new Promise(resolve=>{release=resolve;});
 fs.readFile=async function(...args){const bytes=await readFile.apply(this,args);if(blocked){blocked=false;await gate;}return bytes;};
 t.after(()=>{fs.readFile=readFile;release();});
 const older=sources.refresh([file]);
 while(blocked)await turn();
 // Edited after the older refresh read it, without a file event.
 await fs.writeFile(file,'class A { int changed; }');
 const newer=sources.refresh([file]);
 await new Promise(resolve=>setTimeout(resolve,50));
 release();await older;await newer;
 assert.equal(sources.hashes.get(file),contentHash(await readFile(file)));
});

test('a refresh cancelled while queued behind another stops waiting at once',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),file=path.join(root,'A.cs');
 await fs.writeFile(file,'class A {}');sources.setFiles([file]);
 const readFile=fs.readFile;let release;const gate=new Promise(resolve=>{release=resolve;});
 fs.readFile=async function(...args){const bytes=await readFile.apply(this,args);await gate;return bytes;};
 t.after(()=>{fs.readFile=readFile;release();});
 const first=sources.refresh([file]),abort=new AbortController(),queued=sources.refresh([file],abort.signal);
 abort.abort();
 await assert.rejects(queued,{name:'AbortError'});
 release();await first;
 assert.ok(sources.hashes.has(file));
});

test('a file retired while a refresh read it is not restored',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),file=path.join(root,'A.cs');
 await fs.writeFile(file,'class A {}');sources.setFiles([file]);
 const readFile=fs.readFile;let release,blocked=true;const gate=new Promise(resolve=>{release=resolve;});
 fs.readFile=async function(...args){const bytes=await readFile.apply(this,args);if(blocked){blocked=false;await gate;}return bytes;};
 t.after(()=>{fs.readFile=readFile;release();});
 const refreshing=sources.refresh([file]);
 while(blocked)await turn();
 sources.setFiles([]);release();await refreshing;
 assert.equal(sources.hashes.has(file),false);assert.equal(sources.analysisHashes.has(file),false);
});
