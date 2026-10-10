const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {PreparedOutputCache,outputManifest}=require('../../out/services/preparedOutputCache');
const outputTools=require('../../out/services/output');
const {HashMemo,hashMemoTiming}=require('../../out/services/hashMemo');

/** Old timestamps let metadata vouch for a file; fresh ones may hide a same-tick write and are always rehashed. */
/**
 * @param {import('node:test').TestContext} t
 * @param {{fresh?:boolean}} [options]
 */
async function fixture(t,{fresh=false}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-hash-reuse-'))),source=path.join(root,'build');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'Tests.dll'),'binary');await fs.writeFile(path.join(source,'asset'),'original');
 const hourAgo=new Date(Date.now()-3_600_000),age=async (/** @type {string} */ directory)=>{if(!fresh)for(const name of await fs.readdir(directory))await fs.utimes(path.join(directory,name),hourAgo,hourAgo);};
 await age(source);
 // utimes leaves each change time fresh; aged files count as settled here, fresh ones keep the real window.
 if(!fresh){const racyMs=hashMemoTiming.racyMs;hashMemoTiming.racyMs=-3_600_000;t.after(()=>{hashMemoTiming.racyMs=racyMs;});}
 const hashes=new Map(),fileHash=outputTools.fileHash;
 outputTools.fileHash=async(/** @type {string} */ file,/** @type {AbortSignal|undefined} */ signal)=>{hashes.set(file,(hashes.get(file)??0)+1);return fileHash(file,signal);};
 const cache=new PreparedOutputCache(path.join(root,'storage'),randomUUID());
 t.after(async()=>{outputTools.fileHash=fileHash;await cache.dispose();await fs.rm(root,{recursive:true,force:true});});
 /** @param {string} directory @returns {Promise<import('../../out/services/preparedOutputCache').PreparedArtifact>} */
 const create=async directory=>{
  const template=path.join(directory,'template'),output=new outputTools.PreparedOutput(template,path.join(directory,'assembly'));
  await outputTools.copyOutput(source,template);await age(template);await output.initialize();
  return{root:directory,output,session:randomUUID(),coverage:true,instrumented:[],reusable:true};
 };
 // acquire only yields undefined once the cache is closed, which these tests never do
 const acquire=(slot='target/0')=>/** @type {Promise<import('../../out/services/preparedOutputCache').PreparedArtifactLease>} */ (cache.acquire(source,'context',create,undefined,slot));
 return{root,source,hashes,cache,create,acquire,count:(/** @type {string} */ file)=>hashes.get(file)??0};
}

test('a preparation reads each unchanged build file once, including when the retained template is verified',async t=>{
 const f=await fixture(t),binary=path.join(f.source,'Tests.dll');
 const first=await f.acquire();assert.equal(first.hit,false);
 assert.equal(f.count(binary),1,'the output is fingerprinted at acquisition and confirmed unchanged after preparation without a second read');
 const template=path.join(first.artifact.output.template,'Tests.dll');assert.equal(f.count(template),1);
 await first.release();
 const second=await f.acquire();assert.equal(second.hit,true);
 assert.equal(f.count(binary),1);assert.equal(f.count(template),1,'verifying the retained template reuses the session’s hashes');
 await second.release();
});

test('metadata that changed since a file was hashed forces a new hash, even with the same size and modification time',async t=>{
 const f=await fixture(t),binary=path.join(f.source,'Tests.dll'),first=await f.acquire();
 await first.release();
 const stat=await fs.stat(binary);
 await fs.writeFile(binary,'BINARY');await fs.utimes(binary,stat.atime,stat.mtime);
 const second=await f.acquire();
 assert.equal(second.hit,false,'the rewritten output is a different build');
 assert.ok(f.count(binary)>=2);
 await second.release();
});

test('recently written files are always rehashed because a same-tick write could leave their metadata unchanged',async t=>{
 const f=await fixture(t,{fresh:true}),binary=path.join(f.source,'Tests.dll'),first=await f.acquire();
 await first.release();const before=f.count(binary);
 const second=await f.acquire();assert.equal(second.hit,true);
 assert.ok(f.count(binary)>before,'uncertain metadata is not trusted');
 await second.release();
});

test('manifests with and without a session memo agree',async t=>{
 const f=await fixture(t),memo=new HashMemo(100),plain=await outputManifest(f.source);
 assert.deepEqual(await outputManifest(f.source,undefined,true,memo),plain);
 assert.deepEqual(await outputManifest(f.source,undefined,true,memo),plain,'a warm memo gives the same answer');
 assert.ok(memo.size>0);
});
