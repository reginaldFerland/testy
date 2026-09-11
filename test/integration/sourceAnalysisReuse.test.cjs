const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {constants}=require('node:fs');
const {createHash}=require('node:crypto');
const analysis=require('../../out/services/analysis'),processes=require('../../out/services/process');
const {sourceAnalysisContext}=require('../../out/services/analysisContext');
const {TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('Roslyn provenance hashes the exact UTF-8, BOM, UTF-16 and UTF-32 bytes while preserving legacy syntax results',{timeout:60000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy raw analysis bytes ')));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const source='namespace Café; public partial class 秘密 { public string Value() => "<&😀>"; }';
 const utf16=Buffer.from(source,'utf16le'),utf32=Buffer.alloc([...source].length*4);[...source].forEach((char,index)=>utf32.writeUInt32LE(char.codePointAt(0),index*4));
 const contents=[Buffer.from(source),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(source)]),
  Buffer.concat([Buffer.from([0xff,0xfe]),utf16]),Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from(utf16).swap16()]),
  Buffer.concat([Buffer.from([0xff,0xfe,0,0]),utf32])];
 const files=contents.map((_,index)=>path.join(directory,`Source${index}.cs`));
 for(let index=0;index<files.length;index++)await fs.writeFile(files[index],contents[index]);
 const invalid=path.join(directory,'Invalid.cs'),missing=path.join(directory,'Missing.cs');await fs.writeFile(invalid,'class Invalid {');
 const keys=files.map(normalizePath),invalidKey=normalizePath(invalid),missingKey=normalizePath(missing);
 const alias='global using 隠す = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute; // <>&😀';
 const analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll'),options={cwd:directory,signal:t.signal};
 const aliases=await analysis.sourceAliases('dotnet',analyzer,[alias],directory,options);
 const legacy=await analysis.sourceAnalyses('dotnet',analyzer,[...files,invalid,missing],directory,options,aliases,3);
 const result=await analysis.sourceAnalysisBatch('dotnet',analyzer,[],directory,options,[],3,
  {sources:[alias],allFiles:[...files,invalid,missing]},true);
 assert.deepEqual(result.aliases,aliases);assert.deepEqual(result.analyses,legacy);
 for(let index=0;index<files.length;index++){
  assert.equal(result.sourceHashes.get(keys[index]),hash(contents[index]));
  assert.deepEqual(result.analyses.get(keys[index]),legacy.get(keys[0]),'decoding preserves declaration semantics across encodings');
 }
 assert.equal(result.analyses.get(invalidKey),null);assert.equal(result.sourceHashes.get(invalidKey),hash('class Invalid {'));
 assert.equal(result.analyses.get(missingKey),null);assert.equal(result.sourceHashes.has(missingKey),false);
 // Legacy callers could also encode the request itself with a BOM. Bind the
 // response to those raw bytes while retaining the old request decoder.
 const request=JSON.stringify({files:[files[0]],excludedAliases:aliases,concurrency:1,provenance:true}),requestFile=path.join(directory,'encoded-request.json');
 for(const bytes of [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(request)]),
  Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(request,'utf16le')])]){
  await fs.writeFile(requestFile,bytes);
  const response=await processes.runProcess('dotnet',[analyzer,requestFile],options);assert.equal(response.code,0,response.stderr);
  const value=JSON.parse(response.stdout);assert.equal(value.requestHash,hash(bytes).toUpperCase());assert.deepEqual(value.analyses[files[0]],legacy.get(keys[0]));
 }
});

async function ordinaryNativeHost(t){
 // Positive reuse cases exercise ordinary installed hosting. CI may spell PATH
 // as Path on Windows or set CLR overrides, whose decline behavior has its own tests.
 const pathKey=process.platform==='win32'?Object.keys(process.env).find(key=>key.toUpperCase()==='PATH'):'PATH';
 const executable=process.platform==='win32'?'dotnet.exe':'dotnet';
 let host;
 for(const directory of (process.env[pathKey]??'').split(path.delimiter)){
  const candidate=path.resolve(directory,executable);
  try{
   await fs.access(candidate,process.platform==='win32'?constants.F_OK:constants.X_OK);
   if((await fs.stat(candidate)).isFile()){host=await fs.realpath(candidate);break;}
  }catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
 }
 assert.ok(host,'positive reuse fixture requires a native dotnet executable on PATH');
 const runtimeOverride=/^(?:CORECLR_|COR_|COMPlus_|DOTNET_(?:STARTUP_HOOKS|ADDITIONAL_DEPS|SHARED_STORE|ROOT(?:_|$)|MULTILEVEL_LOOKUP|ROLL_FORWARD|RUNTIME_ID))/i;
 const nativeInjection=/^(?:LD_(?:PRELOAD|LIBRARY_PATH|AUDIT|ORIGIN_PATH)|DYLD_(?:INSERT_LIBRARIES|(?:FALLBACK_|VERSIONED_)?(?:LIBRARY|FRAMEWORK)_PATH|ROOT_PATH|IMAGE_SUFFIX|SHARED_CACHE_DIR))$/i;
 const overrides=Object.entries(process.env).filter(([key])=>runtimeOverride.test(key)||nativeInjection.test(key));
 t.after(()=>{for(const [key,value]of overrides)process.env[key]=value;});
 for(const [key]of overrides)delete process.env[key];
 return host;
}

async function fixture(t,{copyAnalyzer=false}={}){
 const dotnet=await ordinaryNativeHost(t);
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy source reuse '))),root=path.join(temp,'workspace'),storage=path.join(temp,'state');
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 const analyzer=copyAnalyzer?path.join(temp,'analyzer','Testy.Analysis.dll'):path.resolve('dist/analyzer/Testy.Analysis.dll');
 if(copyAnalyzer)await fs.cp(path.dirname(path.resolve('dist/analyzer/Testy.Analysis.dll')),path.dirname(analyzer),{recursive:true});
 const config={dotnet,configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000,maxParallelProjects:2,maxParallelTestFiles:2};
 const control=new AbortController(),signal=AbortSignal.any([control.signal,t.signal]),output=[],results=[],requests=[],cleanups=[];
 const engine=new TestEngine({roots:[root],storage,tools:path.join(temp,'tools'),analyzer,configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(){},result:(group,result)=>results.push([group.id,result.id,result.outcome]),started(){},coverage(){},invalidated(){}}});
 const run=processes.runProcess,batch=analysis.sourceAnalysisBatch;
 processes.runProcess=async(command,args,options)=>{
  if(args[0]===analyzer&&args[1]){
   const request=JSON.parse(await fs.readFile(args[1],'utf8'));if(request.files)requests.push(request);
  }
  return run(command,args,options);
 };
 t.after(async()=>{control.abort();analysis.sourceAnalysisBatch=batch;processes.runProcess=run;for(const cleanup of cleanups)await cleanup();await engine.dispose();await fs.rm(temp,{recursive:true,force:true});});
 assert.ok(await sourceAnalysisContext(dotnet,analyzer,{cwd:root,signal}),'real reuse fixture requires ordinary installed dotnet and bundled analyzer assets');
 return{temp,root,storage,analyzer,engine,config,signal,output,results,requests,batch,cleanup:fn=>cleanups.push(fn),
  file:relative=>normalizePath(path.join(root,relative)),
  baseline:async(signal_=signal)=>{const value=await engine.run({files:[],full:true},signal_);assert.equal(value.passed,3,output.join(''));assert.equal(value.failed,0);return value;}};
}

function rawSnapshot(engine){return new Map([...engine.analyses].map(([file,shape])=>[file,shape]));}
function assertNoReusableShapes(engine){for(const [file,shape]of engine.analyses){assert.equal(shape,null,file);assert.equal(engine.analyzedHashes.has(file),false,file);}}

test('Windows default dotnet with a mixed-case Path reuses real syntax while rediscovering and running tests',
 {skip:process.platform!=='win32',timeout:120000},async t=>{
 const f=await fixture(t),keys=Object.keys(process.env).filter(key=>key.toUpperCase()==='PATH');
 const prior=new Map(keys.map(key=>[key,process.env[key]]));
 f.cleanup(()=>{for(const key of Object.keys(process.env))if(key.toUpperCase()==='PATH')delete process.env[key];for(const [key,value]of prior)process.env[key]=value;});
 for(const key of keys)delete process.env[key];
 process.env.Path=[path.dirname(f.config.dotnet),...prior.values()].join(path.delimiter);
 assert.deepEqual(Object.keys(process.env).filter(key=>key.toUpperCase()==='PATH'),['Path'],'fixture exercises the ordinary mixed-case environment spelling');
 const mtp=require('../../out/services/mtp'),request=mtp.requestTests,calls=[];
 mtp.requestTests=(options,operation,...args)=>{calls.push(operation);return request(options,operation,...args);};
 f.cleanup(()=>{mtp.requestTests=request;});
 f.config.dotnet='dotnet';
 await f.baseline();assert.ok(f.requests.length>0,'initial baseline invokes the real syntax helper');
 const shapes=rawSnapshot(f.engine),groups=JSON.stringify(f.engine.groups),results=[...f.results].sort();
 f.requests.length=0;f.results.length=0;calls.length=0;await f.baseline();
 assert.equal(f.requests.length,0,'unchanged refresh reuses validated raw syntax');
 assert.ok(calls.includes('discover')&&calls.includes('run'),'warm syntax reuse still executes real native discovery and test requests');
 assert.equal(JSON.stringify(f.engine.groups),groups);assert.deepEqual([...f.results].sort(),results,'native cases run again');
 for(const [file,shape]of shapes)assert.equal(f.engine.analyses.get(file),shape);
});

test('full refresh reuses raw syntax and recomputes partial exclusions after source additions and deletions within each project',{timeout:120000},async t=>{
 const f=await fixture(t),core=f.file('ImpactDemo/SharedShape.cs'),tests=f.file('ImpactDemo.Tests/SharedShape.cs'),attribute=f.file('ImpactDemo/SharedShape.Attributes.g.cs');
 await fs.writeFile(core,'public partial class SharedShape { public int Value()=>1; }');
 await fs.writeFile(tests,'public partial class SharedShape { public int Other()=>2; }');
 await f.baseline();const first=rawSnapshot(f.engine),identities=JSON.stringify(f.engine.groups),firstResults=[...f.results].sort();
 f.requests.length=0;f.results.length=0;await f.baseline();
 assert.equal(f.requests.length,0,'an unchanged full refresh starts no source-analysis helper');
 assert.equal(JSON.stringify(f.engine.groups),identities);assert.deepEqual([...f.results].sort(),firstResults);
 for(const [file,shape]of first)assert.equal(f.engine.analyses.get(file),shape,'unchanged raw records retain their identity');
 await fs.writeFile(attribute,'[System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial class SharedShape {}');
 await f.baseline();assert.ok(f.requests.some(request=>request.files.includes(attribute)));
 assert.equal(f.engine.analyses.get(core),first.get(core));assert.equal(f.engine.analyses.get(tests),first.get(tests));
 assert.equal(f.engine.shapes.get(core),first.get(core).body,'new generated exclusion metadata affects the retained implementation');
 assert.equal(f.engine.shapes.get(tests),first.get(tests).signature,'the same type key in another project is isolated');
 assert.equal(f.engine.hashes.has(attribute),false);assert.equal(f.engine.analyzedHashes.has(attribute),true);
 await fs.unlink(attribute);f.requests.length=0;await f.baseline();
 assert.equal(f.engine.analyses.has(attribute),false);assert.equal(f.engine.analyzedHashes.has(attribute),false);
 assert.equal(f.engine.shapes.get(core),first.get(core).signature,'deleted exclusion metadata restores ordinary declaration selection');
 assert.equal(f.requests.length,0,'deleting a non-alias input only changes project-scoped resolution');
});

test('build-generated inputs are parsed again from the bytes emitted by every full refresh',{timeout:120000},async t=>{
 const f=await fixture(t),generated=f.file('ImpactDemo/Stamped.g.cs'),project=f.file('ImpactDemo/ImpactDemo.csproj');
 await fs.writeFile(generated,'// <auto-generated/> initial');
 const target='<Target Name="FreshGeneratedStamp" BeforeTargets="CoreCompile"><PropertyGroup><GeneratedStamp>$([System.DateTime]::UtcNow.Ticks)</GeneratedStamp></PropertyGroup><WriteLinesToFile File="$(MSBuildProjectDirectory)/Stamped.g.cs" Lines="// &lt;auto-generated/&gt; $(GeneratedStamp)" Overwrite="true" /></Target>';
 await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('</Project>',target+'</Project>'));
 await f.baseline();const before=f.engine.analyzedHashes.get(generated);assert.ok(before);f.requests.length=0;
 await f.baseline();const actual=hash(await fs.readFile(generated));
 assert.notEqual(actual,before);assert.equal(f.engine.analyzedHashes.get(generated),actual);
 assert.ok(f.requests.some(request=>request.files.includes(generated)));assert.equal(f.engine.hashes.has(generated),false);
});

test('source edits between tracking and parsing cannot seed a reusable signature or alias state',{timeout:120000},async t=>{
 const f=await fixture(t),file=f.file('ImpactDemo/Arithmetic.cs'),original=await fs.readFile(file),changed=Buffer.from('global using Race = System.Diagnostics.DebuggerHiddenAttribute;\n'+original.toString());
 let parsed;
 analysis.sourceAnalysisBatch=async(...args)=>{
  await fs.writeFile(file,changed);
  try{const result=await f.batch(...args);parsed=result.sourceHashes.get(file);return result;}
  finally{await fs.writeFile(file,original);}
 };
 await assert.rejects(f.engine.run({files:[],full:true},f.signal),{name:'AbortError'});
 assert.equal(parsed,hash(changed));assert.equal(f.engine.aliasStamp,undefined);assertNoReusableShapes(f.engine);
 assert.ok(f.output.some(line=>line.includes('Source inputs changed during analysis')));
 analysis.sourceAnalysisBatch=f.batch;f.requests.length=0;await f.baseline();
 assert.ok(f.requests.length>0,'the exact original bytes must be parsed on retry');assert.equal(f.engine.analyzedHashes.get(file),hash(original));
 assert.ok(!f.engine.excludedAliases.includes('Race'));f.requests.length=0;await f.baseline();assert.equal(f.requests.length,0);
});

test('null syntax, failed alias responses and cancellation retry without retaining incomplete analysis facts',{timeout:180000},async t=>{
 const f=await fixture(t),alias=f.file('ImpactDemo/Aliases.cs'),body=f.file('ImpactDemo/Hidden.Body.cs');
 await fs.writeFile(alias,'global using Blind = System.ObsoleteAttribute;');
 await fs.writeFile(f.file('ImpactDemo/Hidden.cs'),'[Blind] public partial class Hidden {}');
 await fs.writeFile(body,'public partial class Hidden { public int Value()=>1; }');
 analysis.sourceAnalysisBatch=async(...args)=>{const value=await f.batch(...args);return{...value,analyses:new Map([...value.analyses].map(([file,shape])=>[file,file===body?null:shape]))};};
 await f.baseline();assert.equal(f.engine.analyses.get(body),null);assert.equal(f.engine.analyzedHashes.has(body),false);
 analysis.sourceAnalysisBatch=f.batch;f.requests.length=0;await f.baseline();
 assert.ok(f.requests.some(request=>request.files.includes(body)),'a null result is retried even without a source edit');
 const stamp=f.engine.aliasStamp;await fs.writeFile(alias,'global using Blind = System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverageAttribute;');
 analysis.sourceAnalysisBatch=async()=>{throw new Error('controlled alias response failure');};
 await f.baseline();assert.equal(f.engine.aliasStamp,stamp);assertNoReusableShapes(f.engine);
 analysis.sourceAnalysisBatch=f.batch;await f.baseline();assert.equal(f.engine.shapes.get(body),f.engine.analyses.get(body).body);
 const previous=rawSnapshot(f.engine),hashes=new Map(f.engine.analyzedHashes),aliasStamp=f.engine.aliasStamp;
 await fs.appendFile(body,'\n// cancelled edit');const abort=new AbortController();
 analysis.sourceAnalysisBatch=async(...args)=>{const result=await f.batch(...args);abort.abort();return result;};
 await assert.rejects(f.engine.run({files:[],full:true},AbortSignal.any([abort.signal,f.signal])),{name:'AbortError'});
 assert.deepEqual(f.engine.analyses,previous);assert.deepEqual(f.engine.analyzedHashes,hashes);assert.equal(f.engine.aliasStamp,aliasStamp);
 analysis.sourceAnalysisBatch=f.batch;f.requests.length=0;await f.baseline();assert.ok(f.requests.some(request=>request.files.includes(body)));
 assert.equal(f.engine.analyzedHashes.get(body),hash(await fs.readFile(body)));
 assert.ok(!(await fs.readdir(f.storage)).some(name=>name.startsWith('analysis-')),'cancelled requests release their temporary files');
});

test('full refresh rejects changed tool or environment evidence and retries a helper changed during parsing',{timeout:180000},async t=>{
 const f=await fixture(t,{copyAnalyzer:true}),file=f.file('ImpactDemo/Arithmetic.cs'),runtime=f.analyzer.replace('.dll','.runtimeconfig.json');
 const key='TESTY_SOURCE_REUSE_CONTEXT_TEST',previous=process.env[key];f.cleanup(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
 await f.baseline();f.requests.length=0;await f.baseline();assert.equal(f.requests.length,0);
 process.env[key]='different environment';await f.baseline();
 assert.ok(f.requests.some(request=>request.files.length===f.engine.sources.analysisHashes.size),'changed environment forces every raw record to be parsed again');
 await fs.appendFile(file,'\n// force parsing with a stable declaration signature');const stamp=f.engine.aliasStamp;
 analysis.sourceAnalysisBatch=async(...args)=>{const result=await f.batch(...args);await fs.appendFile(runtime,'\n');return result;};
 await f.baseline();assert.equal(f.engine.aliasStamp,stamp);assertNoReusableShapes(f.engine);
 assert.ok(f.output.some(line=>line.includes('Source analysis tools changed during analysis')));
 analysis.sourceAnalysisBatch=f.batch;f.requests.length=0;await f.baseline();
 assert.ok(f.requests.some(request=>request.files.length===f.engine.sources.analysisHashes.size));
 assert.equal(f.engine.analyzedHashes.get(file),hash(await fs.readFile(file)));
});
