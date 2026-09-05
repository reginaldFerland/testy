const fs=require('node:fs/promises'),syncfs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const assert=require('node:assert/strict'),{createRequire}=require('node:module');
const {CoverageReader}=require('../../out/services/coverageReader');
const {parseCobertura}=require('../../out/services/reports');
const {PreparedOutput}=require('../../out/services/output');
const {normalizePath}=require('../../out/core/paths');

(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy responsiveness ')), reader=new CoverageReader();
 try{
  const template=path.join(root,'template');await fs.mkdir(template);const hashes=new Map();
  await Promise.all(Array.from({length:1000},async(_,i)=>{const file=normalizePath(path.join(template,`File${i}.cs`));await fs.writeFile(file,'code');hashes.set(file,'v1');}));
  const lines=Array.from({length:100},(_,i)=>`<line number="${i+1}" hits="${i===0?1:0}"/>`).join('');
  const escaped=file=>file.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const xml='<coverage><packages><package><classes>'+[...hashes.keys()].map(file=>`<class filename="${escaped(file)}"><lines>${lines}</lines></class>`).join('')+'</classes></package></packages></coverage>';
  const report=path.join(root,'coverage.xml');await fs.writeFile(report,xml);
  let start=performance.now();parseCobertura(xml,root,new Set(hashes.keys()));const synchronousMs=performance.now()-start;
  const reads=[];
  for(let i=0;i<3;i++){
   let previous=performance.now(),maxTimerGapMs=0,ticks=0;
   const timer=setInterval(()=>{const now=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,now-previous);previous=now;ticks++;},5);
   start=performance.now();const coverage=await reader.read(report,root,hashes);const elapsedMs=performance.now()-start;clearInterval(timer);
   assert.equal(coverage.length,1000);assert.equal(coverage[0].lines.length,100);
   reads.push({elapsedMs,maxTimerGapMs,ticks});
  }
  const output=new PreparedOutput(template,path.join(root,'output'));await output.initialize();const restoreMs=[];
  for(let i=0;i<5;i++){start=performance.now();await output.restore();restoreMs.push(performance.now()-start);}
  console.log(JSON.stringify({kind:'coverage-and-output',files:1000,linesPerFile:100,reportBytes:Buffer.byteLength(xml),synchronousMs,workerReads:reads,unchangedRestoreMs:restoreMs}));

  const runnerFile=path.resolve('out/services/runner.js'), runnerRequire=createRequire(runnerFile), runnerExports={};
  const nodes=Array.from({length:50000},(_,i)=>({uid:`node${i}`,'display-name':`Row ${i}`,'location.type':`Class${Math.floor(i/500)}`,'location.method':`Test${i}`,'location.method-arity':0}));
  const mtp=runnerRequire('./mtp');
  vm.runInNewContext(syncfs.readFileSync(runnerFile,'utf8'),{exports:runnerExports,require:name=>name==='./mtp'?{...mtp,requestTests:async(_options,_operation,selected)=>(selected??nodes).map(node=>({...node,'execution-state':'passed'}))}:runnerRequire(name)});
  const session=new runnerExports.RunnerSession({cwd:root,dotnet:'dotnet',storage:root,testArguments:[]});
  const assembly=path.join(root,'Tests.dll'),preparedRoot=path.join(root,'prepared');await fs.mkdir(preparedRoot);
  const nativeById=new Map(nodes.map(node=>[node.uid,node])),byKey=new Map();
  for(const node of nodes)byKey.set(JSON.stringify(['display-name','location.type','location.method','location.method-arity'].map(key=>node[key]??null)),[node]);
  session.prepared.set(assembly,{root:preparedRoot,output:{directory:preparedRoot,restore:async()=>{}},session:'benchmark',coverage:false,nodes,nativeById,byKey,runs:0});
  const durations=[];start=performance.now();
  for(let i=0;i<100;i++){
   const group={id:`group${i}`,project:path.join(root,'Tests.csproj'),assembly,framework:'net10.0',file:path.join(root,`Tests${i}.cs`),tests:nodes.slice(i*500,(i+1)*500).map(node=>({id:node.uid,name:node['display-name'],node,line:1}))};
   const began=performance.now();await session.run([group],new Map());durations.push(performance.now()-began);
  }
  const elapsedMs=performance.now()-start;await session.dispose();durations.sort((a,b)=>a-b);
  console.log(JSON.stringify({kind:'runner-selection',projectCases:50000,testFiles:100,elapsedMs,medianFileMs:durations[50],maximumFileMs:durations.at(-1),scope:'actual run method with cached preparation and mocked MTP/output I/O'}));

  const uiFile=path.resolve('out/extension.js'),uiRequire=createRequire(uiFile),uiExports={};let publications=0;
  const vscode={Uri:{file:fsPath=>({fsPath})},FileCoverage:class {},window:{visibleTextEditors:[]}};
  vm.runInNewContext(syncfs.readFileSync(uiFile,'utf8')+'\nexports.Testy=Testy;',{exports:uiExports,require:name=>name==='vscode'?vscode:name==='./configuration'?{}:uiRequire(name),Buffer,setTimeout,clearTimeout});
  const summaries=Array.from({length:5000},(_,i)=>({file:`/File${i}.cs`,stale:false,covered:1,total:1,lines:[{line:1,hits:1}]}));
  const context={disposed:false,engine:{coverage:{summarize:()=>summaries},hashes:new Map()},productionSources:new Set(summaries.map(s=>s.file)),publishedCoverage:new Map(),details:new WeakMap(),activeRun:{addCoverage(){publications++;}},queueDecorations(){},updateStatus(){}};
  start=performance.now();for(let i=0;i<100;i++)uiExports.Testy.prototype.publishCoverage.call(context);
  assert.equal(publications,5000);
  console.log(JSON.stringify({kind:'coverage-publication',files:5000,callbacks:100,publications,elapsedMs:performance.now()-start,scope:'actual method with mocked VS Code API; excludes IPC'}));
 }finally{await reader.dispose();await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
