const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {HashMemo,hashMemoTiming}=require('../../out/services/hashMemo');

/** Partial fs.Stats: HashMemo only reads these five fields, so a deliberate partial mock. @param {{dev?: number, ino?: number, size?: number, mtimeMs?: number, ctimeMs?: number}} [changes] @returns {any} */
const stat=(changes={})=>({dev:1,ino:2,size:3,mtimeMs:1_000,ctimeMs:1_000,...changes});
const later=10_000;

test('a remembered hash is reused only while identity, size and both timestamps are unchanged',()=>{
 const memo=new HashMemo(10);memo.set('a',stat(),'digest',later);
 assert.equal(memo.get('a',stat()),'digest');
 for(const changes of [{dev:9},{ino:9},{size:9},{mtimeMs:1_001},{ctimeMs:1_001}])assert.equal(memo.get('a',stat(changes)),undefined,JSON.stringify(changes));
});

test('files changed within the racy window are never remembered, judged by the later of modification and change time',()=>{
 const memo=new HashMemo(10);
 memo.set('mtime',stat({mtimeMs:later-hashMemoTiming.racyMs}),'digest',later);
 memo.set('ctime',stat({ctimeMs:later-1}),'digest',later);
 memo.set('old',stat(),'digest',later);
 assert.equal(memo.get('mtime',stat({mtimeMs:later-hashMemoTiming.racyMs})),undefined);
 assert.equal(memo.get('ctime',stat({ctimeMs:later-1})),undefined,'an old modification time with a fresh change time is uncertain');
 assert.equal(memo.get('old',stat()),'digest');
 // A racy rehash also drops an older entry for the same file.
 memo.set('old',stat({ctimeMs:later}),'other',later);assert.equal(memo.get('old',stat()),undefined);
});

test('hits refresh recency, so eviction removes the least recently used entry',()=>{
 const memo=new HashMemo(2);memo.set('a',stat(),'A',later);memo.set('b',stat(),'B',later);
 assert.equal(memo.get('a',stat()),'A');
 memo.set('c',stat(),'C',later);
 assert.equal(memo.size,2);assert.equal(memo.get('b',stat()),undefined,'b was least recently used');
 assert.equal(memo.get('a',stat()),'A');assert.equal(memo.get('c',stat()),'C');
 memo.clear();assert.equal(memo.size,0);
});

test('number and bigint file stats both identify a file',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-hash-memo-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'file');await fs.writeFile(file,'content');
 const memo=new HashMemo(10),readAt=Date.now()+hashMemoTiming.racyMs+1_000;
 const plain=await fs.stat(file),big=await fs.stat(file,{bigint:true});
 memo.set('plain',plain,'P',readAt);memo.set('big',big,'B',readAt);
 assert.equal(memo.get('plain',await fs.stat(file)),'P');assert.equal(memo.get('big',await fs.stat(file,{bigint:true})),'B');
 await fs.writeFile(file,'CONTENT');
 assert.equal(memo.get('plain',await fs.stat(file)),undefined);assert.equal(memo.get('big',await fs.stat(file,{bigint:true})),undefined);
});
