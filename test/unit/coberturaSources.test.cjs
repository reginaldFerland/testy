const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parseCobertura}=require('../../out/services/reports');
const {normalizePath}=require('../../out/core/paths');

const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const cls=(file,number,hits)=>`<class filename="${escape(file)}"><methods/><lines><line number="${number}" hits="${hits}"/></lines></class>`;

test('relative class filenames resolve against the first existing report source',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-cobertura-sources-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const first=path.join(root,'first'),second=path.join(root,'second'),elsewhere=path.join(root,'cwd'),relative=path.join('src','Code.cs');
 for(const directory of [first,second,elsewhere]){await fs.mkdir(directory);}
 await fs.mkdir(path.join(second,'src'));await fs.writeFile(path.join(second,'src','Code.cs'),'// source');
 const file=normalizePath(path.join(second,'src','Code.cs')),fallback=normalizePath(path.join(elsewhere,relative));
 const report=(sources,filename=relative)=>`<coverage><sources>${sources.join('')}</sources><packages><package><classes>${cls(filename,4,1)}</classes></package></packages></coverage>`;
 const source=directory=>`<source>${escape(directory)}</source>`,expected=name=>[[name,[{line:4,hits:1}]]];
 assert.deepEqual([...parseCobertura(report([source(first),source(second)]),elsewhere,new Set([file]))],expected(file));
 assert.deepEqual([...parseCobertura(report([source(first)]),elsewhere,new Set([fallback]))],expected(fallback),'no existing candidate falls back to the working directory');
 assert.deepEqual([...parseCobertura(report([]),elsewhere,new Set([fallback]))],expected(fallback));
 assert.deepEqual([...parseCobertura(report([`<source note="x">${escape(second)}</source>`]),elsewhere,new Set([file]))],expected(file));
 assert.deepEqual([...parseCobertura(report([source(first)],path.join(second,relative)),elsewhere,new Set([file]))],expected(file),'absolute filenames ignore sources');
});

test('truncated reports are still rejected as invalid XML',()=>{
 const allowed=new Set([normalizePath('Code.cs')]);
 assert.throws(()=>parseCobertura('<coverage><packages><package></coverage>',process.cwd(),allowed),/valid, safe XML/);
 assert.deepEqual([...parseCobertura(`<coverage><packages><package><classes>${cls('Code.cs',1,2)}</classes></package></packages></coverage>`,process.cwd(),allowed)],[[normalizePath('Code.cs'),[{line:1,hits:2}]]]);
});
