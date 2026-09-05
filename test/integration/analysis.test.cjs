const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {sourceShapes,sourceAnalyses,resolveShapes}=require('../../out/services/analysis');
const {normalizePath}=require('../../out/core/paths');

test('declaration analysis distinguishes executable edits from compile-time dependencies',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy-shapes-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const original='public class C { public const int K = 3; public int P => 1; public int Q { get { return 1; } } public int M(int x) { return x + 1; } }';
 const variants={
  original,
  body:original.replace('return x + 1','return x + 2'),
  property:original.replace('P => 1','P => 2'),
  accessor:original.replace('return 1','return 2'),
  constant:original.replace('K = 3','K = 4'),
  signature:original.replace('M(int x)','M(long x)'),
  attribute:original.replace('public int M','[System.Obsolete] public int M'),
  initializer:original.replace('public const int K = 3','public int K = 3'),
  constructor:original.replace('public int P','public C() { System.Console.WriteLine(1); } public int P'),
  directive:original.replace('return x + 1;','\n#pragma warning disable\nreturn x + 1;'),
  invalid:'public class {'
 };
 const files={};
 for(const [name,source] of Object.entries(variants)) {
  const file=normalizePath(path.join(directory,`${name}.cs`));files[name]=file;
  await fs.writeFile(file,source);
 }
 const shapes=await sourceShapes('dotnet',path.resolve('dist/analyzer/Testy.Analysis.dll'),Object.values(files),directory,{cwd:directory});
 for(const name of ['body','property','accessor']) assert.equal(shapes.get(files[name]),shapes.get(files.original),name);
 for(const name of ['constant','signature','attribute','initializer','constructor','directive']) assert.notEqual(shapes.get(files[name]),shapes.get(files.original),name);
 assert.equal(shapes.get(files.invalid),null);
});

test('partial exclusions cross namespace styles, generic/nested types and partial members incrementally',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy-partial-shapes-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const excluded=normalizePath(path.join(directory,'Excluded.cs')), implementation=normalizePath(path.join(directory,'Implementation.cs'));
 const ordinary=normalizePath(path.join(directory,'Ordinary.cs'));
 await fs.writeFile(excluded,'namespace N { public partial class Outer<T> { [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial class Inner { } } }');
 await fs.writeFile(implementation,'namespace N; public partial class Outer<T> { public partial class Inner { public int Value()=>1; } }');
 await fs.writeFile(ordinary,'namespace N; public partial class Ordinary { public int Value()=>1; }');
 const options={cwd:directory}, analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');
 const initial=await sourceAnalyses('dotnet',analyzer,[excluded,implementation,ordinary],directory,options);
 const before=resolveShapes(initial);
 await fs.writeFile(implementation,'namespace N; public partial class Outer<T> { public partial class Inner { public int Value()=>2; } }');
 await fs.writeFile(ordinary,'namespace N; public partial class Ordinary { public int Value()=>2; }');
 const changed=await sourceAnalyses('dotnet',analyzer,[implementation,ordinary],directory,options);
 const after=resolveShapes(new Map([...initial,...changed]));
 assert.notEqual(after.get(implementation),before.get(implementation));
 assert.equal(after.get(ordinary),before.get(ordinary),'ordinary partial classes must retain narrow selection');
 const isolated=resolveShapes(new Map([...initial,...changed]),[{sourceFiles:[excluded]},{sourceFiles:[implementation,ordinary]}]);
 assert.equal(isolated.get(implementation),initial.get(implementation).signature,'same-named types in unrelated projects do not share exclusions');
 await fs.writeFile(excluded,'namespace N { public partial class Outer<T> { public partial class Inner { [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial int Value(); } } }');
 const member=await sourceAnalyses('dotnet',analyzer,[excluded],directory,options);
 assert.equal(resolveShapes(new Map([...initial,...member])).get(implementation),before.get(implementation),'a partial member attribute must cover its implementation');
});


test('excluded attributes, local/global aliases, and hidden regions keep body changes conservative',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy-blind-spots-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const variants=[
  '[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public class C { public int M()=>1; }',
  'using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute; [Blind] public class C { public int M()=>1; }',
  '[ExternalBlind] public class C { public int M()=>1; }',
  'public class C { [System.Diagnostics.DebuggerHidden] public int M()=>1; }',
  'public class C {\n#line hidden\npublic int M()=>1;\n#line default\n}',
  'public class C {\n#line 200 "Virtual.cs"\npublic int M()=>1;\n#line default\n}',
  'public class C {\n#line (1, 1) - (1, 30) 1 "Virtual.cs"\npublic int M()=>1;\n#line default\n}'
 ];
 for(const [index,source] of variants.entries()) {
  const file=normalizePath(path.join(directory,`${index}.cs`));
  await fs.writeFile(file,source);
  const shape=await sourceShapes('dotnet',path.resolve('dist/analyzer/Testy.Analysis.dll'),[file],directory,{cwd:directory},['ExternalBlind']);
  await fs.writeFile(file,source.replace('M()=>1','M()=>2'));
  const changed=await sourceShapes('dotnet',path.resolve('dist/analyzer/Testy.Analysis.dll'),[file],directory,{cwd:directory},['ExternalBlind']);
  assert.notEqual(shape.get(file),changed.get(file),source);
 }
});
