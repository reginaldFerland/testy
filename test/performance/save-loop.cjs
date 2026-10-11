// Save-loop latency: the run one save of one handler causes once the baseline is learned.
// A registry constructs every handler, so every test file's coverage reaches every handler file;
// only the tests that call the edited method should run.
// Defaults: 24 handlers in one project, one test file per handler across three test projects, eight edits of four kinds (see editKinds).
// Smoke: TESTY_SAVE_HANDLERS=6 TESTY_SAVE_EDITS=4 node test/performance/save-loop.cjs
require('./artifacts.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const {TestEngine}=require('../../out/services/engine');

/** @param {string} name @param {number} fallback */
function integer(name,fallback){const value=Number(process.env[name]??fallback);assert.ok(Number.isSafeInteger(value)&&value>0,`${name} must be a positive integer`);return value;}
const handlers=integer('TESTY_SAVE_HANDLERS',24),edits=integer('TESTY_SAVE_EDITS',8),testProjects=integer('TESTY_SAVE_PROJECTS',3);

/** @param {number} index @param {{handle?: number, unused?: number, comment?: boolean}} [version] */
const handlerSource=(index,{handle=0,unused=0,comment=false}={})=>`namespace Shop;
public sealed class Handler${index}
{
    private readonly string name;
    public Handler${index}() { name = "handler${index}"; }
    public string Name => name;
${comment?'    // Handles one request.\n':''}    public int Handle(int value)
    {
        var result = value + ${index};
        return result + ${handle} - ${handle};
    }
    public int Unused(int value) => value * ${index} + ${unused};
}
`;

/** The edits a save makes, in turn: the body a test calls, one no test calls, a comment between members, and the first body again. */
const editKinds=/** @type {const} */ (['Handle','Unused','comment','Handle again']);

/** @param {string} workspace */
async function createWorkspace(workspace){
 const app=path.join(workspace,'Shop');
 await fs.mkdir(app,{recursive:true});
 await fs.writeFile(path.join(workspace,'global.json'),'{ "test": { "runner": "Microsoft.Testing.Platform" } }');
 await fs.writeFile(path.join(app,'Shop.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
 // Several test projects reference the edited project; only the one with the edited handler's tests needs to run.
 for(let project=0;project<testProjects;project++){
  const tests=path.join(workspace,`Shop.Tests${project}`);await fs.mkdir(tests,{recursive:true});
  await fs.writeFile(path.join(tests,`Shop.Tests${project}.csproj`),'<Project Sdk="MSTest.Sdk/4.3.3"><PropertyGroup><TargetFramework>net10.0</TargetFramework><TestingExtensionsProfile>None</TestingExtensionsProfile></PropertyGroup><ItemGroup><ProjectReference Include="../Shop/Shop.csproj"/></ItemGroup></Project>');
 }
 const members=Array.from({length:handlers},(_,index)=>`    public Handler${index} H${index} { get; } = new();`).join('\n');
 await fs.writeFile(path.join(app,'Registry.cs'),`namespace Shop;\npublic sealed class Registry\n{\n${members}\n}\n`);
 for(let index=0;index<handlers;index++){
  await fs.writeFile(path.join(app,`Handler${index}.cs`),handlerSource(index));
  await fs.writeFile(path.join(workspace,`Shop.Tests${index%testProjects}`,`Handler${index}Tests.cs`),`using Microsoft.VisualStudio.TestTools.UnitTesting;
namespace Shop.Tests;
[TestClass]
public class Handler${index}Tests
{
    [TestMethod]
    public void Handles() => Assert.AreEqual(${index + 1}, new Registry().H${index}.Handle(1));
}
`);
 }
}

async function main(){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'testy-save-loop-')),workspace=path.join(temp,'workspace');
 await createWorkspace(workspace);
 /** @type {string[]} */
 let output=[];
 /** The latest selection the engine announced. @type {{selection?: import('../../out/core/selection').Selection}} */
 const seen={};
 const latest=()=>seen.selection;
 /** @type {import('../../out/core/model').EngineConfiguration} */
 const config={dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:true,excludes:[],testArguments:[],timeout:120000};
 const engine=new TestEngine({roots:[workspace],storage:path.join(temp,'state'),tools:path.join(temp,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),configuration:()=>config,
  events:{output:text=>output.push(text),phase(){},discovered(){},selected(value){seen.selection=value;},result(){},started(){},coverage(){},invalidated(){}}});
 const signal=AbortSignal.timeout(30*60*1000);
 try{
  let began=performance.now();
  const baseline=await engine.run({files:[],full:true},signal);
  console.log(`Baseline: ${baseline.files} files, ${baseline.tests} tests in ${Math.round(performance.now()-began)}ms`);
  const rows=[];
  /** @type {Map<number, {handle?: number, unused?: number, comment?: boolean}>} */
  const versions=new Map();
  for(let edit=1;edit<=edits;edit++){
   const kind=editKinds[(edit-1)%editKinds.length],index=(Math.ceil(edit/editKinds.length)*7)%handlers,file=path.join(workspace,'Shop',`Handler${index}.cs`);
   const version={...versions.get(index)};
   if(kind==='Unused')version.unused=edit;else if(kind==='comment')version.comment=!version.comment;else version.handle=edit;
   versions.set(index,version);await fs.writeFile(file,handlerSource(index,version));
   output=[];delete seen.selection;began=performance.now();
   const summary=await engine.run({files:[file],full:false},signal);
   const elapsed=Math.round(performance.now()-began);
   if(process.env.TESTY_SAVE_VERBOSE)console.log(output.join(''));
   const timings=Object.fromEntries([...output.join('').matchAll(/Testy timing: (.+?) (\d+)ms/g)].map(match=>[match[1],Number(match[2])]));
   const selected=latest()?.groups.map(group=>path.basename(group.file??group.project))??[];
   const stale=[...engine.coverage.traces.values()].filter(trace=>trace.stale).length;
   rows.push({edit:`Handler${index} ${kind}`,selected:selected.length,stale,elapsed,...timings});
   console.log(JSON.stringify({edit:`Handler${index} ${kind}`,selected,stale,elapsed,timings}));
   assert.equal(summary.failed,0,'the edit keeps every test passing');
   assert.ok(kind==='Unused'||kind==='comment'?selected.length===0:selected.length===1&&selected[0]===`Handler${index}Tests.cs`,`${kind} selects only what executed it`);
  }
  console.table(rows);
 }finally{await engine.dispose();await fs.rm(temp,{recursive:true,force:true});}
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
