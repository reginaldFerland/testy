// Actual editor method with mocked VS Code rendering; aggregation remains real.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const file=path.resolve('out/extension.js'),realRequire=createRequire(file),exports_={};
vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nexports.Testy=Testy;',{
 exports:exports_,require:name=>name==='vscode'?{Range:class{}}:name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
});
const {CoverageStore}=require('../../out/core/coverage'),{normalizePath}=require('../../out/core/paths');
(async()=>{
 for(const count of [1000,5000,10000]){
  const store=new CoverageStore(),file=normalizePath('/Common.cs'),hashes=new Map([[file,'v1']]);
  const lines=Array.from({length:1000},(_,i)=>({line:i+1,hits:1}));
  const traces=Array.from({length:count},(_,i)=>({groupId:`g${i}`,dependencies:[file],inputs:{[file]:'v1'},timestamp:1,reliable:true,coverage:[{file,hash:'v1',lines}]}));
  const live=new Set(traces.map(trace=>trace.groupId));
  await store.replaceAsync(traces,live);await store.summarizeAsync(hashes);store.markStale(live);
  const aggregation=store.summarizeAsync(hashes);await new Promise(resolve=>setImmediate(resolve));
  const context={config:{showCoverage:true},engine:{coverage:store,hashes},lifetime:new AbortController(),decorations:{covered:{},uncovered:{},stale:{}}};
  let decorated=0,last=performance.now(),gap=0;
  const editor={document:{uri:{fsPath:file},lineCount:1000,isDirty:true},setDecorations(_kind,entries){decorated+=entries.length;}};
  const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},1);
  const start=performance.now();const pending=exports_.Testy.prototype.decorate.call(context,[editor]);const synchronousMs=performance.now()-start;
  try{await pending;await aggregation;}finally{clearInterval(timer);}
  console.log(JSON.stringify({contributingTestFiles:count,coveredLinesPerContribution:1000,synchronousMs,maxTimerGapMs:gap,decorated}));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
