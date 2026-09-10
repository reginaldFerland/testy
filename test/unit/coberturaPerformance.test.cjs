const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parseCobertura}=require('../../out/services/reports');
const {normalizePath}=require('../../out/core/paths');

const escape=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const report=(classes,attributes='')=>`<coverage ${attributes}><packages><package><classes>${classes}</classes></package></packages></coverage>`;
const cls=(file,lines,methods='')=>`<class filename="${escape(file)}"><methods>${methods}</methods><lines>${lines}</lines></class>`;
const line=(number,hits)=>`<line number="${number}" hits="${hits}"/>`;

test('class lines preserve max hits, sorted geometry and zero-hit files regardless of duplicate method details',()=>{
 const cwd=process.cwd(),file=normalizePath(path.join(cwd,'Shared.cs')),zero=normalizePath(path.join(cwd,'Uncovered.cs'));
 const methods=`<method name="Ignored"><lines>${line(2,999)}${line('not-a-number','not-a-number')}${line(999,20)}</lines></method>`;
 const xml=report(cls('Shared.cs',line(3,0)+line(2,1),methods)+cls('Shared.cs',line(2,4)+line(1,0),methods)+cls('Uncovered.cs',line(7,0),methods));
 assert.deepEqual([...parseCobertura(xml,cwd,new Set([file,zero]))],[[file,[{line:1,hits:0},{line:2,hits:4},{line:3,hits:0}]],[zero,[{line:7,hits:0}]]]);
});

test('unused method trees still undergo full XML validation and entity declaration rejection',()=>{
 const file=normalizePath('Code.cs'),allowed=new Set([file]);
 for(const methods of ['<method><lines></method></lines>','<method name="unterminated></method>','<method><line number="1" hits="2"></method>']){
  assert.throws(()=>parseCobertura(report(cls('Code.cs',line(1,1),methods)),process.cwd(),allowed),/valid, safe XML/);
 }
 for(const declaration of ['<!DOCTYPE coverage [<!ENTITY secret "value">]>','<!ENTITY secret "value">']){
  assert.throws(()=>parseCobertura(declaration+report(cls('Code.cs',line(1,1))),process.cwd(),allowed),/valid, safe XML/);
 }
 assert.throws(()=>parseCobertura(report(cls('Code.cs',line(0,1),'<method/>')),process.cwd(),allowed),/invalid line/);
 assert.throws(()=>parseCobertura(report(cls('Code.cs',line(1,-1),'<method/>')),process.cwd(),allowed),/invalid line/);
});

test('method content with comments, CDATA and nested method tags cannot hide following class lines',()=>{
 const file=normalizePath('Code.cs');
 const methods='<!-- </methods> --><method name="A"><text><![CDATA[</methods><line number="900" hits="900"/>]]></text><methods><method name="Nested"/></methods></method>';
 assert.deepEqual([...parseCobertura(report(cls('Code.cs',line(8,0)+line(9,2),methods)),process.cwd(),new Set([file]))],[[file,[{line:8,hits:0},{line:9,hits:2}]]]);
});

test('Unicode, escaped paths and symlink aliases resolve to the same allowed source file',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-cobertura-paths-'))),directory=path.join(root,'sources');
 await fs.mkdir(directory);const file=path.join(directory,'Déjà & 中文.cs');await fs.writeFile(file,'// source');
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const alias=path.join(root,'alias');await fs.symlink(directory,alias,process.platform==='win32'?'junction':'dir');
 const canonical=normalizePath(file),xml=report(cls(path.relative(root,file),line(5,0))+cls(path.join(alias,path.basename(file)),line(5,2)+line(6,0)));
 assert.deepEqual([...parseCobertura(xml,root,new Set([canonical]))],[[canonical,[{line:5,hits:2},{line:6,hits:0}]]]);
 const other=path.join(root,'other');await fs.mkdir(other);await fs.writeFile(path.join(other,path.basename(file)),'// different source');
 await fs.unlink(alias);await fs.symlink(other,alias,process.platform==='win32'?'junction':'dir');
 const redirected=normalizePath(path.join(other,path.basename(file)));
 assert.deepEqual([...parseCobertura(report(cls(path.join(alias,path.basename(file)),line(9,1))),root,new Set([redirected]))],[[redirected,[{line:9,hits:1}]]],'path memoization cannot outlive a report');
});

test('empty methods, default namespaces and unrelated metadata preserve existing class-level behavior',()=>{
 const file=normalizePath('Code.cs'),allowed=new Set([file]),cwd=process.cwd();
 for(const methods of ['','<methods/>','<methods><method><lines>'+line(99,9)+'</lines></method></methods>']){
  const xml=report(`<class filename="Code.cs">${methods}<custom><lines>${line(100,8)}</lines></custom><lines>${line(1,0)}</lines></class>`,'xmlns="urn:cobertura"');
  assert.deepEqual([...parseCobertura(xml,cwd,allowed)],[[file,[{line:1,hits:0}]]]);
 }
 assert.throws(()=>parseCobertura('<c:coverage xmlns:c="urn:cobertura"><c:packages/></c:coverage>',cwd,allowed),/no packages/,'prefixed report roots retain their existing unsupported behavior');
 assert.deepEqual([...parseCobertura(report('<class filename="NotAllowed.cs"><lines>'+line(0,-1)+'</lines></class>'),cwd,allowed)],[],'unselected source files retain their existing filtering');
});
