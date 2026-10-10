const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {hashMemoTiming}=require('../../out/services/hashMemo');
const {ProjectEvaluationCache,evaluationInputs}=require('../../out/services/projectEvaluationCache');

/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-evaluation-hash-reuse-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sdk=path.join(root,'sdks','10.0.100'),directory=path.join(root,'app');await fs.mkdir(sdk,{recursive:true});await fs.mkdir(directory);
 const file=path.join(directory,'App.csproj'),source=path.join(directory,'Code.cs'),imported=path.join(root,'settings.props');
 await fs.writeFile(file,'<Project/>');await fs.writeFile(source,'class Code {}');await fs.writeFile(imported,'<Project/>');
 /** @type {import('../../out/core/model').Project[]} */
 const graph=[{file,sourceFiles:[source],framework:'net10.0',assembly:path.join(directory,'bin','App.dll'),references:[],isTestProject:true,runner:'mtp'}];
 /** @type {import('../../out/services/projectEvaluationCache').EvaluationInputs[]} */
 const inputs=[{reusable:true,files:[file,imported],queries:[
  {kind:'files',path:directory,pattern:'*.cs',recursive:false,values:[source]},
  {kind:'entries',path:directory,pattern:null,recursive:false,values:[file,source]},
  {kind:'directories',path:directory,pattern:null,recursive:false,values:[]}],
  excludedDirectories:[],sdkDirectory:sdk}];
 evaluationInputs.set(graph,inputs);const cache=new ProjectEvaluationCache();await cache.put(new Map([[file,graph]]),'context');
 return{root,directory,file,imported,graph,cache,get:()=>cache.get([file],'context')};
}
/** Treat every file as settled, as it would be once the racy window has passed, without waiting for it. */
/** @param {import('node:test').TestContext} t */
function settle(t){const racyMs=hashMemoTiming.racyMs;hashMemoTiming.racyMs=-3_600_000;t.after(()=>{hashMemoTiming.racyMs=racyMs;});}
// Count real reads of one path while the callback runs.
/** @param {string} file @param {() => Promise<unknown>} work */
async function reads(file,work){
 const fsAny=/** @type {any} */ (fs); // the module object is patched, so its overloaded signatures cannot be kept
 const read=fsAny.readFile;let count=0;
 /** @param {any} target @param {any[]} args */
 fsAny.readFile=function(target,...args){if(String(target)===file){count++;}return read.call(this,target,...args);};
 try{await work();}finally{fsAny.readFile=read;}
 return count;
}

test('unchanged files are not hashed again across validations, and edits that keep size and mtime are still seen',async t=>{
 const f=await fixture(t),stat=await fs.stat(f.imported);
 // Timestamps this recent might not move on a further edit, so they are never trusted.
 assert.ok(await reads(f.imported,async()=>assert.equal((await f.get()).size,1))>0);
 settle(t);
 assert.ok(await reads(f.imported,async()=>assert.equal((await f.get()).size,1))>0,'the first settled validation records the hash');
 assert.equal(await reads(f.imported,async()=>assert.equal((await f.get()).size,1)),0,'identity and timestamps are unchanged');
 await fs.writeFile(f.imported,'<Edited/>');await fs.utimes(f.imported,stat.atime,stat.mtime);
 assert.equal((await f.get()).size,0,'the new ctime exposes a same-length edit with the old mtime');
});

test('clearing the cache forgets file hashes',async t=>{
 const f=await fixture(t);settle(t);await f.get();
 assert.equal(await reads(f.imported,()=>f.get()),0);
 await f.cache.clear();
 assert.ok(await reads(f.imported,()=>f.cache.put(new Map([[f.file,f.graph]]),'context'))>0);
});

test('queries over one directory share a single listing per validation',async t=>{
 const f=await fixture(t),fsAny=/** @type {any} */ (fs),list=fsAny.readdir;let count=0; // patched module object: overloads cannot be kept
 /** @param {any} directory @param {any[]} args */
 fsAny.readdir=function(directory,...args){if(String(directory)===f.directory){count++;}return list.call(this,directory,...args);};
 try{assert.equal((await f.get()).size,1);}finally{fsAny.readdir=list;}
 assert.equal(count,1);
 // Walks still happen on every validation: a new file is observed.
 await fs.writeFile(path.join(f.directory,'New.cs'),'class New {}');assert.equal((await f.get()).size,0);
});
