const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {SourceTracker}=require('../../out/services/sources');
const {normalizePath}=require('../../out/core/paths');

/** @param {import('node:test').TestContext} t */
async function temporary(t){const root=normalizePath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-sources-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('only real global using directives keep their full source',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),write=(/** @type {string} */ name,/** @type {string} */ text)=>fs.writeFile(path.join(root,name),text).then(()=>path.join(root,name));
 const files=[
  await write('Real.cs','global using Alias = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;'),
  await write('Spaced.cs','global /* note */ using static System.Math;'),
  await write('Line.cs','// global using Commented = System.Object;\nclass A {}'),
  await write('Block.cs','/* global using Commented = System.Object; */\nclass B {}'),
  await write('Prose.cs','// a global approach\nclass C { string global = "x"; }')];
 sources.setFiles(files);await sources.refresh(files);
 assert.deepEqual([...sources.aliasSources.keys()].sort(),[files[0],files[1]].sort());
 assert.equal(/** @type {string} */ (sources.aliasSources.get(files[0])).startsWith('global using Alias'),true);
});

test('derived source maps are reused until the tracker changes',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),file=path.join(root,'A.cs');
 await fs.writeFile(file,'global using X = System.Object;');sources.setFiles([file]);await sources.refresh([file]);
 const hashes=sources.analysisHashes,aliases=sources.aliasSources;
 assert.equal(sources.analysisHashes,hashes);assert.equal(sources.aliasSources,aliases);
 await fs.writeFile(file,'class A {}');sources.mark([file]);await sources.refresh([file]);
 assert.notEqual(sources.analysisHashes,hashes);assert.equal(sources.aliasSources.size,0);assert.equal(aliases.size,1,'earlier snapshots are not mutated');
 sources.setFiles([]);assert.equal(sources.analysisHashes.size,0);
});

test('transient read errors make a version unknown and are retried without failing the batch',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),locked=path.join(root,'Locked.cs'),other=path.join(root,'Other.cs');
 await fs.writeFile(locked,'class Locked {}');await fs.writeFile(other,'class Other {}');
 sources.setFiles([locked,other]);await sources.refresh([locked,other]);
 const before=sources.hashes.get(locked);assert.ok(before);
 await fs.writeFile(locked,'class Locked { int Changed; }');await fs.writeFile(other,'class Other { int Changed; }');
 const read=fs.readFile;
 /** @type {any} */ (fs).readFile=async(/** @type {any} */ file,/** @type {any[]} */ ...rest)=>{if(file===locked){throw Object.assign(new Error('busy'),{code:'EBUSY'});}return /** @type {any} */ (read)(file,...rest);}; // fs.readFile is monkey-patched; the wrapper forwards arbitrary overloads
 let changed;
 try{changed=await sources.refresh([locked,other]);}finally{/** @type {any} */ (fs).readFile=read;}
 assert.deepEqual([...changed].sort(),[locked,other].sort());
 assert.equal(sources.hashes.get(locked),undefined,'the unknown version cannot match a recorded trace');
 assert.ok(sources.hashes.get(other));
 const retried=await sources.refresh([]);
 assert.deepEqual(retried,[locked]);assert.ok(sources.hashes.get(locked));assert.notEqual(sources.hashes.get(locked),before);
 assert.deepEqual(await sources.refresh([]),[],'a resolved file is no longer retried');
});

test('aborts still reject the batch',async t=>{
 const root=await temporary(t),sources=new SourceTracker(),file=path.join(root,'A.cs');
 await fs.writeFile(file,'class A {}');sources.setFiles([file]);
 const abort=new AbortController();abort.abort();
 await assert.rejects(sources.refresh([file],abort.signal),{name:'AbortError'});
});
