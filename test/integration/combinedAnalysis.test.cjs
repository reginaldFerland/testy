const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const analysis=require('../../out/services/analysis'),processes=require('../../out/services/process');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');

test('combined Roslyn analysis matches separate calls through alias additions, edits, and removals',{timeout:60000},async t=>{
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'testy combined Roslyn '));t.after(()=>fs.rm(storage,{recursive:true,force:true}));
 const files=['Aliases.cs','Excluded.cs','Implementation.cs','Ordinary.cs','Invalid.cs','Missing.cs'].map(name=>normalizePath(path.join(storage,name)));
 const source='global /* comment */ using \\u0042lind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;';
 await fs.writeFile(files[0],source);await fs.writeFile(files[1],'namespace N { [Blind] public partial class C {} }');
 await fs.writeFile(files[2],'namespace N; public partial class C { public int Value()=>1; }');
 await fs.writeFile(files[3],'public class Ordinary { public int Value()=>1; }');await fs.writeFile(files[4],'public class Invalid {');
 const analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll'),options={cwd:storage};
 const aliases=await analysis.sourceAliases('dotnet',analyzer,[source],storage,options);
 const expected=await analysis.sourceAnalyses('dotnet',analyzer,files,storage,options,aliases,4);
 const run=processes.runProcess,calls=[];processes.runProcess=async(...args)=>{calls.push(args);return run(...args);};t.after(()=>{processes.runProcess=run;});
 const initial=await analysis.sourceAnalysisBatch('dotnet',analyzer,[files[0]],storage,options,[],4,{sources:[source],allFiles:files});
 assert.equal(calls.length,1,'alias extraction and all declaration analysis share one process');
 assert.deepEqual(initial.aliases,aliases);assert.deepEqual(initial.analyses,expected);
 assert.deepEqual(analysis.resolveShapes(initial.analyses),analysis.resolveShapes(expected));
 assert.equal(analysis.resolveShapes(initial.analyses).get(files[2]),initial.analyses.get(files[2]).body,'partial exclusions span unchanged files');
 assert.equal(initial.analyses.get(files[4]),null);assert.equal(initial.analyses.get(files[5]),null);
 const comments=source+' // changed comment';await fs.writeFile(files[0],comments);
 const same=await analysis.sourceAnalysisBatch('dotnet',analyzer,[files[0]],storage,options,initial.aliases,4,{sources:[comments],allFiles:files});
 assert.deepEqual([...same.analyses.keys()],[files[0]],'unchanged resolved aliases preserve incremental analysis');
 const addition=comments+'\n#if UNKNOWN\nglobal using HiddenAttribute = System.Diagnostics.DebuggerHiddenAttribute;\n#endif';
 await fs.writeFile(files[0],addition);
 const added=await analysis.sourceAnalysisBatch('dotnet',analyzer,[files[0]],storage,options,same.aliases,2,{sources:[addition],allFiles:files});
 assert.deepEqual(new Set(added.aliases),new Set(['Blind','Hidden','HiddenAttribute']));assert.equal(added.analyses.size,files.length);
 const ordinary='global using Blind = System.ObsoleteAttribute;';await fs.writeFile(files[0],ordinary);
 const removed=await analysis.sourceAnalysisBatch('dotnet',analyzer,[files[0]],storage,options,added.aliases,4,{sources:[ordinary],allFiles:files});
 assert.deepEqual(removed.aliases,[]);assert.equal(removed.analyses.size,files.length);
 assert.equal(analysis.resolveShapes(removed.analyses).get(files[2]),removed.analyses.get(files[2]).signature);
 await fs.unlink(files[0]);
 const deleted=await analysis.sourceAnalysisBatch('dotnet',analyzer,[],storage,options,['Blind'],4,{sources:[],allFiles:files.slice(1)});
 assert.deepEqual(deleted.aliases,[]);assert.deepEqual([...deleted.analyses.keys()],files.slice(1));
});

test('failed alias batches clear stale signatures and retry without publishing the candidate alias stamp',{timeout:120000},async t=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy combined engine ')),root=path.join(temp,'workspace'),storage=path.join(temp,'state');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const file=name=>normalizePath(path.join(root,'ImpactDemo',name)),alias=file('Aliases.cs'),declaration=file('Hidden.cs'),body=file('Hidden.Body.cs');
 await fs.writeFile(alias,'global using Blind = System.ObsoleteAttribute;');
 await fs.writeFile(declaration,'[Blind] public partial class Hidden {}');await fs.writeFile(body,'public partial class Hidden { public int Value()=>1; }');
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2};
 const output=[],control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]);
 const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
 const batch=analysis.sourceAnalysisBatch;
 t.after(async()=>{control.abort();analysis.sourceAnalysisBatch=batch;await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 assert.equal((await engine.run({files:[],full:true},signal)).passed,3,output.join(''));
 const stamp=engine.aliasStamp;assert.equal(engine.shapes.get(body),engine.analyses.get(body).signature);
 await fs.writeFile(alias,'global using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;');
 const manual=()=>({groups:new Set(engine.groups.map(group=>group.id))});
 let update;analysis.sourceAnalysisBatch=async(...args)=>{update=args[7];throw new Error('controlled incomplete alias analysis');};
 assert.equal((await engine.run({files:[],full:false},signal,manual())).passed,3,output.join(''));
 assert.ok(update.sources.some(source=>source.includes('ExcludeFromCodeCoverageAttribute')));
 assert.equal(engine.aliasStamp,stamp,'a failed combined request cannot commit its new alias stamp');
 for(const file of update.allFiles){assert.equal(engine.analyses.get(file),null);assert.equal(engine.analyzedHashes.has(file),false);}
 assert.ok(output.some(line=>line.includes('controlled incomplete alias analysis')));
 let retried=false;analysis.sourceAnalysisBatch=async(...args)=>{retried=!!args[7];return batch(...args);};
 assert.equal((await engine.run({files:[],full:false},signal,manual())).passed,3,output.join(''));
 assert.equal(retried,true);assert.notEqual(engine.aliasStamp,stamp);
 assert.equal(analysis.resolveShapes(engine.analyses,engine.projects).get(body),engine.analyses.get(body).body,
  'retry propagates the alias exclusion to the unchanged partial implementation');
});
