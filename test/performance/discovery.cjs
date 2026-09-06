// Run after compilation. Measures the actual inventory/ownership paths, plus a
// real 20,001-case MTP baseline. VS Code rendering is excluded from these timings.
const fs=require('node:fs'),io=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module'),assert=require('node:assert/strict');
const {discover}=require('../../out/services/runner'),{TestEngine}=require('../../out/services/engine');
const {normalizePath}=require('../../out/core/paths');
async function measure(callback,source){
 const realpath=fs.realpathSync.native;let calls=0,last=performance.now(),gap=0;
 fs.realpathSync.native=(...args)=>{if(!source||args[0]===source)calls++;return realpath(...args);};
 const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},1),start=performance.now();
 try{const value=await callback(),durationMs=performance.now()-start;await new Promise(resolve=>setTimeout(resolve,5));return{value,durationMs,realpathCalls:calls,maxTimerGapMs:gap};}
 finally{clearInterval(timer);fs.realpathSync.native=realpath;}
}
async function main(){
 const source=normalizePath(path.resolve('test/fixtures/ImpactDemo/ImpactDemo.Tests/CalculatorTests.cs'));
 for(const count of [20000,100000]){
  const nodes=Array.from({length:count},(_,i)=>({uid:`row${i}`,'display-name':`Case ${i}`,'location.file':source}));
  const result=await measure(async()=>{const groups=await discover({file:path.join(path.dirname(source),'ImpactDemo.Tests.csproj'),framework:'net10.0',assembly:'/unused/Tests.dll',sourceFiles:[source]}, {},nodes);assert.equal(groups[0].tests.length,count);},source);
  assert.equal(result.realpathCalls,1);console.log(JSON.stringify({kind:'discovery-inventory',count,...result}));
 }
 for(const located of [false,true]){
  const file=path.resolve('out/services/runner.js'),realRequire=createRequire(file),exports={},mtp=realRequire('./mtp');
  const groups=Array.from({length:50},(_,i)=>({id:`g${i}`,project:'/workspace/Tests.csproj',framework:'net10.0',assembly:'/workspace/Tests.dll',file:`/workspace/Source${i}.cs`,
   tests:[mtp.discoveredTest({uid:`parent${i}`,'location.type':`Class${i}`,'location.method':'Theory'})]}));
  const rows=Array.from({length:1000},(_,i)=>({uid:`runtime${i}`,'location.type':`Class${i%50}`,'location.method':'Theory','execution-state':'passed',...(located?{'location.file':groups[i%50].file}:{})}));
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports,require:name=>name==='./mtp'?{...mtp,requestTests:async options=>{rows.forEach(options.onNode);return rows;}}:realRequire(name)});
  let reported=0;const session=new exports.RunnerSession({dotnet:'dotnet',storage:'.',testArguments:[],onResult:(group,result)=>{assert.equal(group.id,`g${Number(result.id.slice(7))%50}`);reported++;}});
  const nodes=groups.flatMap(group=>group.tests.map(test=>test.node));
  session.prepared.set('/workspace/Tests.csproj\0net10.0',{root:'.',output:{directory:'.',restore:async()=>{}},session:'fixture',coverage:false,nodes,nativeById:new Map(nodes.map(node=>[node.uid,node])),byKey:new Map(),groups,runs:0});
  try{const result=await measure(async()=>{await session.run(groups,new Map());});assert.equal(reported,rows.length);assert.ok(result.realpathCalls<300);console.log(JSON.stringify({kind:'runtime-ownership',located,groups:groups.length,count:rows.length,...result}));}
  finally{session.prepared.clear();await session.dispose();}
 }
 const root=await io.mkdtemp(path.join(os.tmpdir(),'testy-discovery-scale-'));
 try{
  const workspace=path.join(root,'workspace');await io.cp(path.resolve('test/fixtures/ImpactDemo'),workspace,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
  const file=normalizePath(path.join(workspace,'ImpactDemo.Tests/CalculatorTests.cs'));
  await io.writeFile(file,'using Microsoft.VisualStudio.TestTools.UnitTesting; [TestClass] public class CalculatorTests { public static System.Collections.Generic.IEnumerable<object[]> Cases => System.Linq.Enumerable.Range(0,20000).Select(i=>new object[]{i}); [TestMethod][DynamicData(nameof(Cases))] public void Value(int value)=>Assert.IsTrue(value>=0); }');
  const engine=new TestEngine({roots:[workspace],storage:path.join(root,'state'),tools:path.join(root,'tools'),analyzer:path.resolve('dist/analyzer/Testy.Analysis.dll'),
   configuration:()=>({dotnet:'dotnet',configuration:'Debug',mode:'affected',coverage:false,excludes:[],testArguments:[],timeout:60000}),
   events:{output(){},phase(){},discovered(){},selected(){},result(){},started(){},coverage(){},invalidated(){}}});
  const result=await measure(()=>engine.run({files:[],full:true},new AbortController().signal),file);assert.equal(result.value.passed,20001);assert.ok(result.realpathCalls<20);
  console.log(JSON.stringify({kind:'real-mtp-discovery',...result}));
 }finally{await io.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
