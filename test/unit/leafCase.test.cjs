// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {normalizePath,normalizePathAsync,pathNormalizer,clearPathCache}=require('../../out/core/paths');

async function temporary(/** @type {import('node:test').TestContext} */t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-case-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('macOS leaf names take the on-disk case, sync and async',{skip:process.platform!=='darwin'},async t=>{
 const root=await temporary(t);await fs.writeFile(path.join(root,'Foo.cs'),'');clearPathCache();
 const expected=normalizePath(path.join(root,'Foo.cs'));
 assert.equal(path.basename(expected),'Foo.cs');
 assert.equal(normalizePath(path.join(root,'foo.cs')),expected);
 assert.equal(await normalizePathAsync(path.join(root,'FOO.CS')),expected);
 assert.equal(pathNormalizer()(path.join(root,'foo.cs')),expected);
 await fs.writeFile(path.join(root,'Bar.cs'),'');
 assert.equal(path.basename(normalizePath(path.join(root,'bar.cs'))),'Bar.cs','files created after the listing was cached are found');
 assert.equal(path.basename(normalizePath(path.join(root,'missing.cs'))),'missing.cs');
});
