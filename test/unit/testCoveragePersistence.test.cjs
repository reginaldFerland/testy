const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {TestCoverageStore,restoredRecords}=require('../../out/core/testCoverage');
const {CoverageCache}=require('../../out/services/cache');
const {cacheDirectory}=require('../../out/services/cacheFormat');

/** @typedef {import('../../out/core/model').FileCoverage} FileCoverage */

/** @param {string} file @param {string} hash @param {[number, number][]} lines @returns {FileCoverage} */
const entry=(file,hash,lines)=>({file,hash,lines:lines.map(([line,hits])=>({line,hits}))});
const records=()=>new Map([
 ['t1',[entry('/w/Calc.cs','v1',[[3,2],[4,0],[7,0]]),entry('/w/Other.cs','v9',[[1,0]])]],
 ['t2',[entry('/w/Calc.cs','v1',[[3,0],[4,0],[7,5]]),entry('/w/Other.cs','v9',[[1,0]])]]
]);
const geometry=(/** @type {string} */ file,/** @type {string} */ hash)=>file==='/w/Calc.cs'&&hash==='v1'?{lines:[3,4,7],declarations:[{name:'Add()',start:3,end:7}]}:undefined;

test('the store saves what runs set and deleted since the last save, and retries a failed save',()=>{
 const store=new TestCoverageStore();
 store.set('a',records());store.set('b',records());store.delete('b');store.delete('never');
 const delta=store.take();
 assert.deepEqual(delta.saved.map(item=>item.groupId),['a']);assert.deepEqual(delta.removed,['b']);
 assert.deepEqual(store.take(),{saved:[],removed:[]});
 store.retry(delta);
 assert.deepEqual(store.take().saved.map(item=>item.groupId),['a']);
 store.retain(new Set());
 assert.deepEqual(store.take().removed,['a'],'a file that no longer exists loses its saved records');
});

test('restored records never replace what a run decided, and records that cannot be restored are removed by the next save',()=>{
 const store=new TestCoverageStore();
 store.delete('ran');
 assert.equal(store.restore('ran',records()),false);assert.equal(store.get('ran'),undefined);
 assert.equal(store.restore('idle',records()),true);assert.ok(store.get('idle'));
 assert.deepEqual(store.take(),{saved:[],removed:[]},'restoring writes nothing');
 store.discardSaved('gone');store.discardSaved('idle');
 assert.deepEqual(store.take().removed,['gone']);
});

test('restored records rebuild each version\'s geometry from the saved hits, and reject versions the trace does not cover',()=>{
 const saved=new Map([['t1',[{file:'/w/Calc.cs',hash:'v1',hits:new Map([[3,2]])},{file:'/w/Other.cs',hash:'v9',hits:new Map()}]]]);
 const trace={coverage:[entry('/w/Calc.cs','v1',[[3,2]])]};
 assert.deepEqual(restoredRecords(saved,trace,geometry),new Map([['t1',[{file:'/w/Calc.cs',hash:'v1',lines:[{line:3,hits:2},{line:4,hits:0},{line:7,hits:0}],
  declarations:[{name:'Add()',start:3,end:7}]}]]]),'a file the test did not run and the trace does not cover is left out');
 assert.equal(restoredRecords(saved,{coverage:[entry('/w/Calc.cs','v2',[[3,2]])]},geometry),undefined,'another version');
 assert.equal(restoredRecords(new Map([['t1',[{file:'/w/Calc.cs',hash:'v1',hits:new Map([[5,1]])}]]]),trace,geometry),undefined,'a line outside the geometry');
 assert.equal(restoredRecords(new Map([['t1',[{file:'/w/New.cs',hash:'v1',hits:new Map([[1,1]])}]]]),trace,geometry),undefined,'a ran file the trace does not cover');
});

test('the cache saves per-test coverage with only the lines that ran, restores it, and removes it',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-test-coverage-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cache=new CoverageCache(root,()=>{}),empty={sources:[],removedSources:[],traces:[],removedTraces:[]};
 await cache.save({...empty,tests:{saved:[{groupId:'file-a',records:records()}],removed:[]}});
 const restored=await new CoverageCache(root,()=>{}).restoreTests();
 const hits=(/** @type {string} */ test)=>restored.get('file-a')?.get(test)?.map(item=>[item.file,item.hash,[...item.hits]]);
 assert.deepEqual(hits('t1'),[['/w/Calc.cs','v1',[[3,2]]],['/w/Other.cs','v9',[]]]);
 assert.deepEqual(hits('t2'),[['/w/Calc.cs','v1',[[7,5]]],['/w/Other.cs','v9',[]]]);
 // A damaged record is skipped; the others restore.
 const directory=path.join(root,cacheDirectory,'tests');
 await fs.writeFile(path.join(directory,`${'0'.repeat(64)}.json`),'{"format":');
 assert.deepEqual([...(await cache.restoreTests()).keys()],['file-a']);
 await cache.save({...empty,tests:{saved:[],removed:['file-a']}});
 assert.equal((await cache.restoreTests()).size,0);
});
