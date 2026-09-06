// Real engine/UI/transport methods; synthetic scale, with VS Code rendering mocked.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const assert=require('node:assert/strict'),{setTimeout:delay}=require('node:timers/promises');
const {TestEngine}=require('../../out/services/engine'),{ProjectIndex}=require('../../out/core/selection');
const {startProcess}=require('../../out/services/process'),{requestTests}=require('../../out/services/mtp');
const file=path.resolve('out/extension.js'),realRequire=createRequire(file),exports_={};
vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nexports.Testy=Testy;',{
 exports:exports_,require:name=>name==='vscode'?{Uri:{file:fsPath=>({fsPath})},Range:class{}}:name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
});
async function measure(callback) {
 let previous=performance.now(),maxTimerGapMs=0,ticks=0;
 const timer=setInterval(()=>{const now=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,now-previous);previous=now;ticks++;},1);
 const start=performance.now();
 try{const value=await callback(),durationMs=performance.now()-start;await delay(10);return{value,durationMs,maxTimerGapMs,ticks};}finally{clearInterval(timer);}
}
(async()=>{
 for(const count of [50000,100000]) {
  const groups=Array.from({length:100},(_,i)=>({id:`g${i}`,project:'/w/Tests.csproj',framework:'net10.0',file:`/w/Test${i}.cs`,tests:Array.from({length:count/100},(_,j)=>({id:`t${j}`,name:`Case ${j}`,file:`/w/Test${i}.cs`,line:1}))}));
  let replacements=0;
  const context={items:new Map(),testIds:new Map(),treeFiles:new Map(),treeProjects:new Map(),treeRoots:[],engine:{projects:[],knownTests:g=>TestEngine.prototype.knownTests.call({runtime:new Map()},g)},watch(){},updateStatus(){},setOutcome(){},
   controller:{items:{replace(){replacements++;}},createTestItem(id,label,uri){return{id,label,uri,children:{replace(){replacements++;}}};}},item:exports_.Testy.prototype.item};
  const initial=await measure(()=>exports_.Testy.prototype.updateTree.call(context,groups));
  const before=replacements,unchanged=[];
  for(let i=0;i<3;i++)unchanged.push(await measure(()=>exports_.Testy.prototype.updateTree.call(context,groups)));
  const rediscovered=groups.map(group=>({...group,tests:group.tests.map(test=>({...test}))}));
  const discovery=await measure(()=>exports_.Testy.prototype.updateTree.call(context,rediscovered));assert.equal(replacements,before);
  console.log(JSON.stringify({kind:'tree',count,initial,unchanged,rediscovered:discovery,unchangedReplacements:replacements-before}));
 }
 const engine=new TestEngine({roots:['/w'],storage:osUnused(),tools:osUnused(),analyzer:'unused',configuration:()=>({mode:'affected'}),events:{coverage(){},output(){}}});
 const count=3000,sources=Array.from({length:1000},(_,i)=>`/w/Source${i}.cs`),hashes=new Map(sources.map(file=>[file,'v1']));
 engine.projects=[{file:'/w/Lib.csproj',assembly:'/w/Lib.dll',sourceFiles:sources,references:[]},{file:'/w/Tests.csproj',assembly:'/w/Tests.dll',sourceFiles:[],references:['/w/Lib.csproj']}];engine.index=new ProjectIndex(engine.projects);
 engine.groups=Array.from({length:count},(_,i)=>({id:`g${i}`,project:'/w/Tests.csproj',file:`/w/Test${i}.cs`,tests:[]}));engine.sources.current=hashes;
 await engine.coverage.replaceAsync(engine.groups.map((g,i)=>({groupId:g.id,dependencies:[sources[i%sources.length]],inputs:{[sources[i%sources.length]]:'v1'},reliable:true,timestamp:1,
  coverage:sources.map((file,j)=>({file,hash:'v1',lines:[{line:1,hits:i%sources.length===j?1:0}]}))})),new Set(engine.groups.map(g=>g.id)));
 await engine.coverage.summarizeAsync(hashes);await engine.coverage.takeDeltaAsync();
 let synchronousMarkMs,synchronousDeltaMs;
 const mark=await measure(async()=>{const start=performance.now(),pending=engine.markChanged(['/w/Lib.csproj']);synchronousMarkMs=performance.now()-start;await pending;});
 const delta=await measure(async()=>{const start=performance.now(),pending=engine.coverage.takeDeltaAsync();synchronousDeltaMs=performance.now()-start;const value=await pending;assert.equal(value.traces.length,count);return{sources:value.sources.length,traces:value.traces.length};});
 console.log(JSON.stringify({kind:'live-coverage',testFiles:count,sourceMemberships:count*sources.length,synchronousMarkMs,synchronousDeltaMs,mark,delta}));
 for(const located of [false,true]) {
  const tests=Array.from({length:20000},(_,i)=>({uid:`case${i}`,'display-name':`Case ${i}`,'location.type':'Tests','location.method':`Case${i}`,...(located?{'location.file':path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/CalculatorTests.cs')}:{})}));
  const result=await measure(async()=>{const nodes=await requestTests({dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-scale-peer.cjs'),cwd:process.cwd(),timeoutMs:30000},'run',tests);assert.equal(nodes.length,tests.length);});
  console.log(JSON.stringify({kind:'result-transport',located,count:tests.length,...result}));
 }
 const script='const chunk=Buffer.alloc(65536,65);let left=1024;function write(){while(left-->0){if(!process.stdout.write(chunk)){process.stdout.once("drain",write);return;}}}write();';
 const output=await measure(async()=>{const result=await startProcess(process.execPath,['-e',script],{cwd:process.cwd(),timeoutMs:30000}).done;assert.equal(result.code,0);assert.equal(result.stdout.length,8*1024*1024);});
 console.log(JSON.stringify({kind:'64MiB-output',...output}));
})().catch(error=>{console.error(error);process.exitCode=1;});
function osUnused(){return path.join(require('node:os').tmpdir(),'testy-unused-benchmark');}
