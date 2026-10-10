// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {AnalyzerServers,AnalyzerServerUnavailable}=require('../../out/services/analyzerServer');
const {sourceAnalyses,sourceLocations}=require('../../out/services/analysis');
const {runProcess}=require('../../out/services/process');
const {normalizePath}=require('../../out/core/paths');

// Roslyn comes from the SDK, so the helper must work with every SDK the machine has.
const analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');
const installedRoslyn=()=>execFileSync('dotnet',['--list-sdks'],{encoding:'utf8'}).split(/\r?\n/).flatMap(line=>{
 const match=/^(\d+)\.\d+\.\d+\S*\s+\[(.+)\]$/.exec(line.trim());
 return match&&Number(match[1])>=10?[{version:line.split(' ')[0],directory:path.join(match[2],line.split(' ')[0],'Roslyn','bincore')}]:[];
});

/** @param {import('node:test').TestContext} t */
async function workspace(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy roslyn loader ')));
 const servers=new AnalyzerServers();
 t.after(async()=>{await servers.dispose();await fs.rm(directory,{recursive:true,force:true});});
 return{directory,servers};
}

test('the helper ships without Roslyn and loads the Roslyn of each installed SDK, in server and one-shot mode',{timeout:180000},async t=>{
 const shipped=await fs.readdir(path.dirname(analyzer));
 assert.deepEqual(shipped.filter(name=>/^Microsoft\.CodeAnalysis/i.test(name)),[],'Roslyn must not be bundled');
 const sdks=installedRoslyn();
 assert.ok(sdks.length>0,'an installed .NET 10 SDK is required');
 const {directory,servers}=await workspace(t);
 const file=normalizePath(path.join(directory,'Sample.cs'));
 await fs.writeFile(file,'namespace N; [System.Diagnostics.CodeAnalysis.ExcludeFromCodeCoverage] public partial class C<T> { public int M(int x) { return x; } public int P => 1; }');
 const request=JSON.stringify({files:[file],excludedAliases:[],provenance:true});
 for(const sdk of sdks){
  const env={...process.env,TESTY_ROSLYN_DIR:sdk.directory};
  const served=JSON.parse(await servers.request('dotnet',analyzer,request,{cwd:directory,env}));
  assert.equal(typeof served.analyses[file].signature,'string',sdk.version);
  assert.deepEqual(served.analyses[file].excludedTypes,['N:C`1'],sdk.version);
  // The one-shot fallback loads the same Roslyn and answers the same.
  const input=path.join(directory,'request.json'),output=path.join(directory,'response.json');
  await fs.writeFile(input,request);
  const result=await runProcess('dotnet',[analyzer,input,output],{cwd:directory,env});
  assert.equal(result.code,0,`${sdk.version}: ${result.stderr}`);
  assert.deepEqual(JSON.parse(await fs.readFile(output,'utf8')),served,sdk.version);
 }
});

test('without TESTY_ROSLYN_DIR the helper finds the SDK beside its runtime',{timeout:60000},async t=>{
 const {directory,servers}=await workspace(t);
 const env={...process.env};delete env.TESTY_ROSLYN_DIR;
 const file=normalizePath(path.join(directory,'Sample.cs'));await fs.writeFile(file,'public class C { public int M() { return 1; } }');
 const response=JSON.parse(await servers.request('dotnet',analyzer,JSON.stringify({files:[file],excludedAliases:[]}),{cwd:directory,env}));
 assert.equal(typeof response[file].signature,'string');
});

test('a missing or unusable Roslyn fails analysis with the reason, but not requests that do not need it',{timeout:120000},async t=>{
 const {directory,servers}=await workspace(t);
 const empty=path.join(directory,'empty');await fs.mkdir(empty);
 const file=normalizePath(path.join(directory,'Sample.cs'));await fs.writeFile(file,'public class C {}');
 for(const bad of [empty,path.join(directory,'missing')]){
  const env={...process.env,TESTY_ROSLYN_DIR:bad};
  // A server that cannot load Roslyn never reports ready, so callers fall back to a one-shot process.
  await assert.rejects(servers.request('dotnet',analyzer,JSON.stringify({files:[file],excludedAliases:[]}),{cwd:directory,env}),
   error=>error instanceof AnalyzerServerUnavailable&&/Roslyn 5\.0\.0\.0 or newer was not found/.test(error.message),bad);
  await assert.rejects(sourceAnalyses('dotnet',analyzer,[file],directory,{cwd:directory,env}),/Roslyn 5\.0\.0\.0 or newer was not found/,bad);
  // Reading portable symbols needs no Roslyn.
  assert.ok((await sourceLocations('dotnet',analyzer,analyzer,directory,{cwd:directory,env})).size>0,bad);
 }
});
