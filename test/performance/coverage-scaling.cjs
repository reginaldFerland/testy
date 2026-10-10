// Scaling of per-commit coverage publication (shared-source aggregation and ownership) and of affected-test selection.
// TESTY_SCALE_FILES sets the number of test files (default 5,000).
require('./artifacts.cjs');
const assert=require('node:assert/strict');
const {CoverageStore}=require('../../out/core/coverage'),{ProjectIndex,selectTests}=require('../../out/core/selection');
const files=Number(process.env.TESTY_SCALE_FILES)||5000;
/** @param {number} seed */
const random=seed=>()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};

(async()=>{
 // A baseline commits one test file at a time and publishes coverage after each, as the engine does.
 // Every file covers 20 of the shared source's 100 lines, so the shared summary changes on every commit.
 const store=new CoverageStore(),shared='/w/Shared.cs',hashes=new Map([[shared,'v1']]),live=new Set(),next=random(0x2545f491);
 const geometry=Array.from({length:100},(_,i)=>i+1);
 /** @type {{replaceMs:number,publishMs:number}[]} */ const commits=[];
 const start=performance.now();
 for(let i=0;i<files;i++){
  live.add(`g${i}`);
  const covered=new Set(Array.from({length:20},()=>1+Math.floor(next()*100)));
  const coverage=[{file:shared,hash:'v1',lines:geometry.map(line=>({line,hits:covered.has(line)?1+Math.floor(next()*9):0}))}];
  const begin=performance.now();
  await store.replaceAsync([{groupId:`g${i}`,dependencies:[shared],inputs:{[shared]:'v1'},reliable:true,timestamp:i,coverage}],live);
  const replaced=performance.now();
  // Before applyHashes existed, summaries applied the versions themselves.
  if(store.applyHashes)store.applyHashes(hashes);await store.summarizeAsync(hashes);
  commits.push({replaceMs:replaced-begin,publishMs:performance.now()-replaced});
 }
 const totalMs=performance.now()-start,summary=/** @type {import('../../out/core/coverage').CoverageSummary} */ (store.summary(shared,hashes));
 assert.equal(summary.groupIds.length,files);
 const mean=(/** @type {typeof commits} */ values,/** @type {'replaceMs'|'publishMs'} */ key)=>values.reduce((sum,value)=>sum+value[key],0)/values.length;
 const first=commits.slice(0,100),last=commits.slice(-100);
 console.log(JSON.stringify({kind:'shared-source-baseline',testFiles:files,totalMs,firstPublishMs:mean(first,'publishMs'),lastPublishMs:mean(last,'publishMs'),lastReplaceMs:mean(last,'replaceMs')}));
 // Replacing one contribution with a lower maximum (a re-run) and removing one (a deleted file) on the full store.
 let begin=performance.now();
 await store.replaceAsync([{groupId:'g0',dependencies:[shared],inputs:{[shared]:'v1'},reliable:true,timestamp:files,coverage:[{file:shared,hash:'v1',lines:geometry.map(line=>({line,hits:line%7?0:1}))}]}],live);
 await store.summarizeAsync(hashes);const replaceMs=performance.now()-begin;
 begin=performance.now();live.delete('g1');await store.replaceAsync([],live);await store.summarizeAsync(hashes);const removeMs=performance.now()-begin;
 console.log(JSON.stringify({kind:'shared-source-update',testFiles:files,replaceMs,removeMs}));

 // Selection: 50 test projects referencing one library, 100 test files each; changes in the library.
 const projectCount=50,perProject=Math.max(1,Math.round(files/projectCount)),sources=Array.from({length:400},(_,i)=>`/w/Lib/Code${i}.cs`);
 const lib={file:'/w/Lib/Lib.csproj',framework:'net10.0',assembly:'/w/Lib/bin/Lib.dll',isTestProject:false,runner:/** @type {'mtp'} */ ('mtp'),sourceFiles:sources,references:[]};
 const projects=[lib,...Array.from({length:projectCount},(_,p)=>({file:`/w/Tests${p}/Tests${p}.csproj`,framework:'net10.0',assembly:`/w/Tests${p}/bin/Tests${p}.dll`,isTestProject:true,runner:/** @type {'mtp'} */ ('mtp'),
  sourceFiles:Array.from({length:perProject},(_,i)=>`/w/Tests${p}/Test${i}.cs`),references:[lib.file]}))];
 const groups=/** @type {import('../../out/core/model').TestFile[]} */ (/** @type {any} */ (projects.slice(1).flatMap((project,p)=>project.sourceFiles.map((file,i)=>({id:`t${p}:${i}`,project:project.file,framework:'net10.0',file,tests:[]}))))); // partial mocks: only the fields selection reads
 const pick=random(0x9e3779b9),traces=new Map(groups.map(group=>[group.id,{groupId:group.id,dependencies:[/** @type {string} */ (group.file),...Array.from({length:5},()=>/** @type {string} */ (sources[Math.floor(pick()*sources.length)]))],coverage:[],reliable:pick()>0.02,timestamp:1}]));
 const byDependency=new Map();for(const trace of traces.values())for(const file of trace.dependencies){const ids=byDependency.get(file)??new Set();ids.add(trace.groupId);byDependency.set(file,ids);}
 const dependencies=(/** @type {string} */ file)=>byDependency.get(file)??new Set(),modules=()=>new Set(),index=new ProjectIndex(projects);
 for(const [label,changes,conservative] of /** @type {[string,string[],boolean][]} */ ([['narrow',sources.slice(0,20),false],['narrow',sources.slice(0,200),false],['conservative',sources.slice(0,200),true]])){
  const times=[];let selected=0;
  for(let repeat=0;repeat<7;repeat++){
   const begin=performance.now(),selection=selectTests(groups,projects,traces,changes,'affected',false,conservative?new Set(changes):new Set(),index,dependencies,modules);
   times.push(performance.now()-begin);selected=selection.groups.length;
  }
  console.log(JSON.stringify({kind:'selection',case:label,testFiles:groups.length,changes:changes.length,selected,ms:Math.min(...times)}));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
