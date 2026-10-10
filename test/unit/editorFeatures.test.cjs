const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {parseSln,parseSlnx,parseSlnf,parseSolution}=require('../../out/core/solution');
const {parseBuildDiagnostic,diagnosticKey,LineSplitter}=require('../../out/core/diagnostics');
const {parseStackTrace,failingFrame}=require('../../out/core/stackTrace');
const {testResult,discoveredTest,requestTests}=require('../../out/services/mtp');
const {Scheduler}=require('../../out/core/scheduler');
const {filterEntryPoints}=require('../../out/services/projects');
const {CoverageStore}=require('../../out/core/coverage');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');

/** @typedef {import('../../out/core/diagnostics').BuildDiagnostic} BuildDiagnostic */
/** @typedef {import('../../out/core/model').TestResult} TestResult */
const root=path.resolve('/repo');

test('classic solutions list project paths and skip solution folders',()=>{
 const content=['Microsoft Visual Studio Solution File, Format Version 12.00',
  'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"','EndProject',
  'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "tests", "tests", "{22222222-2222-2222-2222-222222222222}"','EndProject',
  'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "App.Tests", "tests/App.Tests/App.Tests.csproj", "{33333333-3333-3333-3333-333333333333}"','EndProject'].join('\r\n');
 assert.deepEqual(parseSln(content,root).projects,[path.join(root,'src','App','App.csproj'),path.join(root,'tests','App.Tests','App.Tests.csproj')]);
});

test('XML solutions find nested projects, decode entities and ignore comments',()=>{
 const content=`<Solution>
  <!-- <Project Path="old/Old.csproj" /> -->
  <Folder Name="/src/"><Project Path="src/A&amp;B/AB.csproj" Type="Classic C#" /></Folder>
  <Project Id="x" Path='tests\\T/T.csproj'/>
  <Project Path="docs/readme.md" />
 </Solution>`;
 assert.deepEqual(parseSlnx(content,root).projects,[path.join(root,'src','A&B','AB.csproj'),path.join(root,'tests','T','T.csproj')]);
});

test('solution filters resolve projects against their solution and reject malformed files',()=>{
 const filter=parseSlnf('\uFEFF'+JSON.stringify({solution:{path:'../All.sln',projects:['src\\App\\App.csproj','tests/T/T.csproj']}}),path.join(root,'filters'));
 assert.equal(filter.solution,path.join(root,'All.sln'));
 assert.deepEqual(filter.projects,[path.join(root,'src','App','App.csproj'),path.join(root,'tests','T','T.csproj')]);
 assert.throws(()=>parseSlnf('{"solution":{}}',root),/solution.path/);
 assert.throws(()=>parseSolution(path.join(root,'a.txt'),''),/not a \.sln/);
});

test('entry points are limited by solution, then include and exclude globs; the filter files become inputs',async t=>{
 const dir=normalizePath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-solution-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const project=(/** @type {string} */ name)=>normalizePath(path.join(dir,name,`${name}.csproj`));
 const found=[project('App'),project('App.Tests'),project('Other.Tests'),project('Slow.Tests')];
 await fs.writeFile(path.join(dir,'All.sln'),found.map((file,index)=>`Project("{X}") = "P${index}", "${path.relative(dir,file)}", "{G${index}}"`).join('\n'));
 await fs.writeFile(path.join(dir,'Fast.slnf'),JSON.stringify({solution:{path:'All.sln',projects:[path.relative(dir,found[0]),path.relative(dir,found[1]),path.relative(dir,found[3])]}}));
 const filtered=await filterEntryPoints(found,{solution:path.join(dir,'Fast.slnf'),exclude:['**/Slow.Tests/**']},[dir]);
 assert.deepEqual(filtered.entryPoints,[found[0],found[1]]);
 assert.deepEqual(filtered.inputs,[normalizePath(path.join(dir,'Fast.slnf')),normalizePath(path.join(dir,'All.sln'))]);
 assert.deepEqual((await filterEntryPoints(found,{include:['**/*.Tests.csproj']},[dir])).entryPoints,found.slice(1));
 assert.deepEqual((await filterEntryPoints(found,{},[dir])).entryPoints,found);
 await assert.rejects(filterEntryPoints(found,{include:['nothing/**']},[dir]),/exclude every project/);
 await assert.rejects(filterEntryPoints(found,{solution:path.join(dir,'Missing.sln')},[dir]),/could not be read/);
});

test('build diagnostics parse compiler and MSBuild locations, node prefixes and projects',()=>{
 assert.deepEqual(parseBuildDiagnostic('/w/App/Calc.cs(12,17): error CS0103: The name \'x\' does not exist in the current context [/w/App/App.csproj]'),
  {file:'/w/App/Calc.cs',line:12,column:17,severity:'error',code:'CS0103',message:'The name \'x\' does not exist in the current context',project:'/w/App/App.csproj'});
 assert.deepEqual(parseBuildDiagnostic('  3>C:\\src\\A.cs(4,1,4,9): warning CS0168: The variable \'e\' is declared but never used'),
  {file:'C:\\src\\A.cs',line:4,column:1,endLine:4,endColumn:9,severity:'warning',code:'CS0168',message:'The variable \'e\' is declared but never used'});
 assert.equal(/** @type {BuildDiagnostic} */ (parseBuildDiagnostic('/w/App/App.csproj(10): error MSB4025: The project file could not be loaded.')).column,1);
 assert.equal(parseBuildDiagnostic('MSBUILD : error MSB1009: Project file does not exist.'),undefined);
 assert.equal(parseBuildDiagnostic('Build succeeded.'),undefined);
 const a=/** @type {BuildDiagnostic} */ (parseBuildDiagnostic('/a.cs(1,2): error CS1: m [/p.csproj]')),b=/** @type {BuildDiagnostic} */ (parseBuildDiagnostic('/a.cs(1,2): error CS1: m [/q.csproj]'));
 assert.equal(diagnosticKey(a),diagnosticKey(b),'the summary repeat of a message is one diagnostic');
 const lines=new LineSplitter();
 assert.deepEqual(lines.push('first\r\nsec'),['first']);assert.deepEqual(lines.push('ond\nthird'),['second']);
 assert.deepEqual(lines.flush(),['third']);assert.deepEqual(lines.flush(),[]);
});

test('stack traces yield clickable frames and the innermost workspace frame',()=>{
 const frames=parseStackTrace([
  '   at Xunit.Assert.Equal[T](T expected, T actual) in /_/src/Assert.cs:line 40',
  '   at Demo.Tests.ArithmeticTests.Adds() in /w/Tests/ArithmeticTests.cs:line 12',
  '--- End of stack trace from previous location ---',
  '   at System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)',
  '  à Demo.Lib.Calc.Add(Int32 a, Int32 b) dans C:\\w\\Lib\\Calc.cs:ligne 3'].join('\n'));
 assert.deepEqual(frames,[
  {label:'Xunit.Assert.Equal[T](T expected, T actual)',file:'/_/src/Assert.cs',line:40},
  {label:'Demo.Tests.ArithmeticTests.Adds()',file:'/w/Tests/ArithmeticTests.cs',line:12},
  {label:'System.Runtime.CompilerServices.TaskAwaiter.ThrowForNonSuccess(Task task)'},
  {label:'Demo.Lib.Calc.Add(Int32 a, Int32 b)',file:'C:\\w\\Lib\\Calc.cs',line:3}]);
 assert.equal(/** @type {import('../../out/core/stackTrace').StackFrame} */ (failingFrame(frames,file=>file.startsWith('/w/'))).line,12);
 assert.equal(failingFrame(frames,()=>false),undefined);
 assert.deepEqual(parseStackTrace(undefined),[]);
});

test('MTP assertion values and declaration end lines are retained',()=>{
 const result=/** @type {TestResult} */ (testResult({uid:'a','display-name':'Adds','execution-state':'failed','error.message':'Values differ','assert.expected':'3','assert.actual':'4'}));
 assert.equal(result.expected,'3');assert.equal(result.actual,'4');
 assert.equal(/** @type {TestResult} */ (testResult({uid:'b','execution-state':'failed','assert.expected':'3'})).expected,undefined,'a diff needs both values');
 assert.equal(/** @type {TestResult} */ (testResult({uid:'b','execution-state':'failed','assert.expected':'','assert.actual':''})).expected,undefined,'MSTest sends empty values');
 assert.equal(discoveredTest({uid:'c','location.file':'/a.cs','location.line-start':5,'location.line-end':9}).endLine,9);
 assert.equal(discoveredTest({uid:'c','location.file':'/a.cs','location.line-start':5,'location.line-end':2}).endLine,undefined);
});

test('a debugged test host reports its process before connecting, and attaches once',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'testy-debug-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const marker=path.join(dir,'attached'),/** @type {number[]} */ attached=[];
 const options={dotnet:process.execPath,assembly:path.resolve('test/fixtures/mtp-peer.cjs'),cwd:process.cwd(),timeoutMs:15000,
  env:{TESTY_ATTACHED_FILE:marker,TESTY_UPDATES:JSON.stringify([{uid:'t','node-type':'action','display-name':'t','execution-state':'passed'}])},
  debug:async (/** @type {number} */ processId)=>{attached.push(processId);await fs.writeFile(marker,'');}};
 const nodes=await requestTests(options,'run');
 assert.equal(attached.length,1);assert.ok(Number.isSafeInteger(attached[0])&&attached[0]>0);
 assert.equal(nodes[0]['execution-state'],'passed');
 await fs.rm(marker);attached.length=0;
 const discovered=await requestTests({...options,env:{...options.env,TESTY_UPDATES:'[]'}},'discover');
 assert.equal(attached.length,0,'discovery never waits for a debugger');assert.deepEqual(discovered,[]);
 await assert.rejects(requestTests({...options,debug:async()=>{throw new Error('no debugger');}},'run'),/no debugger/);
});

test('scheduler exposes pending changes for an immediate run and cancels the active run without losing them',async()=>{
 let release=/** @type {(()=>void)|undefined} */ (undefined),signalSeen=/** @type {AbortSignal|undefined} */ (undefined);
 const scheduler=new Scheduler({debounce:0,schedule:callback=>{callback();return()=>{};},run:async(_batch,signal)=>{signalSeen=signal;await new Promise(resolve=>{release=/** @type {()=>void} */ (resolve);signal.addEventListener('abort',resolve);});}});
 scheduler.setPaused(true);scheduler.request(['/a.cs']);scheduler.request([],true);
 const batch=scheduler.pendingBatch;assert.deepEqual(batch.files,['/a.cs']);assert.equal(batch.full,true);assert.ok(batch.generation);
 scheduler.setPaused(false);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(scheduler.isRunning,true);scheduler.cancel();assert.equal(/** @type {AbortSignal} */ (signalSeen).aborted,true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(scheduler.pendingBatch.files,['/a.cs'],'cancelled changes stay pending');release?.();scheduler.dispose();
});

test('per-test-file coverage contributions use the displayed source geometry',()=>{
 const store=new CoverageStore(),file=normalizePath('/w/Calc.cs'),hashes=new Map([[file,'v1']]);
 const trace=(/** @type {string} */ groupId,/** @type {number[]} */ hits)=>({groupId,dependencies:[file],coverage:[{file,hash:'v1',lines:[1,2,3].map(line=>({line,hits:hits.includes(line)?1:0}))}],reliable:true,timestamp:1,inputs:{[file]:'v1'}});
 store.replace([trace('a',[1]),trace('b',[2])],new Set(['a','b']));
 assert.deepEqual(store.contribution(file,new Set(['a']),hashes),[{line:1,hits:1},{line:2,hits:0},{line:3,hits:0}]);
 assert.deepEqual(/** @type {readonly import('../../out/core/model').CoveredLine[]} */ (store.contribution(file,new Set(['a','b']),hashes)).map(line=>line.hits),[1,1,0]);
 assert.equal(store.contribution(normalizePath('/w/None.cs'),new Set(['a']),hashes),undefined);
});

test('failure messages use assertion diffs, stack frames and the failing workspace line',()=>{
 /** @type {string[]} */ const created=[];
 class TestMessage{constructor(/** @type {string} */ message){this.message=message;}static diff(/** @type {string} */ message,/** @type {string} */ expected,/** @type {string} */ actual){return Object.assign(new TestMessage(message),{expectedOutput:expected,actualOutput:actual});}}
 const vscode={l10n:{t:(/** @type {string} */ message)=>message},TestMessage,Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},Position:class{constructor(/** @type {number} */ line,/** @type {number} */ character){Object.assign(this,{line,character});}},
  Location:class{constructor(/** @type {unknown} */ uri,/** @type {unknown} */ range){Object.assign(this,{uri,range});}},TestMessageStackFrame:class{constructor(/** @type {string} */ label,/** @type {unknown} */ uri,/** @type {unknown} */ position){created.push(label);Object.assign(this,{label,uri,position});}}};
 const exports={failureMessage:loadUi({vscode}).failureMessage};
 const workspace=normalizePath(path.resolve('/w')),test=normalizePath(path.join(workspace,'Tests','T.cs'));
 const item={uri:{fsPath:test},range:{start:0}};
 const message=exports.failureMessage({message:'Values differ',expected:'3',actual:'4',stack:`   at Lib.Assert.Equal() in /lib/Assert.cs:line 9\n   at Tests.T.Adds() in ${test}:line 12`},item,[workspace]);
 assert.equal(message.expectedOutput,'3');assert.equal(message.actualOutput,'4');assert.equal(message.message,'Values differ');
 assert.deepEqual(created,['Lib.Assert.Equal()','Tests.T.Adds()']);
 assert.equal(message.location.uri.fsPath,test);assert.equal(message.location.range.line,11);
 const plain=exports.failureMessage({message:'Boom',stack:'unparseable stack'},item,[workspace]);
 assert.equal(plain.message,'Boom\n\nunparseable stack');assert.equal(plain.expectedOutput,undefined);assert.equal(plain.location.range,item.range);
 assert.deepEqual([message.contextValue,plain.contextValue],['testy.failure','testy.failure'],'failure messages can carry testing/message/context menu items');
});
