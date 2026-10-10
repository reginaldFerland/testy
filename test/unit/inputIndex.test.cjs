// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {InputIndex}=require('../../out/core/inputIndex');

function engineOf(/** @type {string[]} */files,/** @type {string[]} */directories){
 const engine={inputVersion:1,reads:0,
  get knownFiles(){engine.reads++;return files;},get directories(){return directories;}};
 return engine;
}

test('input index answers membership, ancestor and descendant queries from sets',()=>{
 const files=['/w/src/A.cs','/w/src/deep/B.cs','/w/srcother/C.cs','/ext/lib/D.cs','/ext/.editorconfig'];
 const index=new InputIndex(engineOf(files,['/w/src','/w/src/deep','/w/srcother','/ext/lib','/ext'])).refresh();
 assert.equal(index.has('/w/src/A.cs'),true);assert.equal(index.has('/w/src'),false);
 assert.deepEqual(index.descendants('/w/src'),['/w/src/A.cs','/w/src/deep/B.cs'],'siblings sharing a name prefix are not descendants');
 assert.deepEqual(index.descendants('/w/src/'),['/w/src/A.cs','/w/src/deep/B.cs']);
 assert.deepEqual(index.descendants('/w/src/A.cs'),[]);
 assert.equal(index.inSourceDirectory('/ext/lib/New.cs'),true);assert.equal(index.inSourceDirectory('/ext/lib/sub/dir/New.cs'),true);
 assert.equal(index.inSourceDirectory('/ext/other/New.cs'),false,'a directory holding only an inherited configuration is not a source directory');
 assert.equal(index.inSourceDirectory('/unrelated/File.cs'),false);
});

test('input index rebuilds only when the engine reports different inputs',()=>{
 const files=['/w/A.cs'],engine=engineOf(files,['/w']),index=new InputIndex(engine).refresh();
 files.push('/w/B.cs');
 assert.equal(index.refresh().has('/w/B.cs'),false,'unchanged version and arrays keep the cached sets');
 engine.inputVersion++;
 assert.equal(index.refresh().has('/w/B.cs'),true);
 const reads=engine.reads;index.refresh();assert.equal(engine.reads-reads,1,'each refresh reads the engine once');
 assert.deepEqual(index.files,files);
});

test('input index handles thousands of events without rescanning the file list',()=>{
 const files=Array.from({length:20000},(_,i)=>`/w/dir${i%200}/File${i}.cs`),index=new InputIndex(engineOf(files,[...new Set(files.map(f=>f.slice(0,f.lastIndexOf('/'))))])).refresh();
 const began=process.hrtime.bigint();
 for(let i=0;i<20000;i++){assert.equal(index.has(files[i]),true);index.inSourceDirectory(`/w/dir${i%200}/New${i}.cs`);if(i%50===0)assert.equal(index.descendants(`/w/dir${i%200}`).length,100);}
 assert.ok(Number(process.hrtime.bigint()-began)/1e6<10_000,'indexed queries stay fast');
});
