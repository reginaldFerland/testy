// @ts-check
const {test}=require('node:test'),assert=require('node:assert/strict');

test('a formerly absent build dependency invalidates retained coverage when created',()=>{
 const {CoverageStore}=require('../../out/core/coverage'),{sourceVersion}=require('../../out/core/paths');
 const store=new CoverageStore(),initial=new Map([['/Code.cs','code']]);
 store.replace([{groupId:'file',dependencies:['/Code.cs','/.editorconfig'],inputs:{'/Code.cs':'code','/.editorconfig':sourceVersion(initial,'/.editorconfig')},
  coverage:[{file:'/Code.cs',hash:'code',lines:[{line:1,hits:1}]}],reliable:true,timestamp:0}],new Set(['file']));
 assert.equal(store.summarize(initial)[0].stale,false);
 const created=new Map([...initial,['/.editorconfig','new']]);store.applyHashes(created);
 assert.equal(store.summarize(created)[0].stale,true);
});
