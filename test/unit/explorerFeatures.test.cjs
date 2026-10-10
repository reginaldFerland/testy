const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadUi}=require('./support/ui.cjs');
const {createTesty}=require('./support/controller.cjs');
const {normalizePath}=require('../../out/core/paths');
const {mapDeterministicPath}=require('../../out/core/stackTrace');
const manifest=require('../../package.json'),nls=require('../../package.nls.json');

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const collection=()=>({values:/** @type {any[]} */ ([]),replace(/** @type {Iterable<any>} */ values){this.values=[...values];},add(/** @type {any} */ value){this.values.push(value);}});
class Range {constructor(/** @type {number} */ startLine,/** @type {number} */ startCharacter,/** @type {number} */ endLine,/** @type {number} */ endCharacter){Object.assign(this,{start:{line:startLine,character:startCharacter},end:{line:endLine,character:endCharacter}});}}

/** A real TestTree over a stub controller. */
function tree(engine={}) {
 const roots=collection();
 const vscode={Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},Range,TestMessage:class{constructor(/** @type {string} */ message){this.message=message;}},Position:class{constructor(/** @type {number} */ line){this.line=line;}},
  Location:class{constructor(/** @type {unknown} */ uri,/** @type {unknown} */ range){Object.assign(this,{uri,range});}},TestMessageStackFrame:class{constructor(/** @type {string} */ label,/** @type {unknown} */ uri,/** @type {unknown} */ position){Object.assign(this,{label,uri,position});}}};
 const controller={items:roots,createTestItem:(/** @type {string} */ id,/** @type {string} */ label,/** @type {unknown} */ uri)=>({id,label,uri,tags:[],children:collection()}),invalidateTestResults(){}};
 const ui=loadUi({vscode});
 const host={disposed:false,activeRun:undefined,roots:['/w'],updateStatus(){}};
 return{tree:new ui.TestTree(controller,{knownTests:(/** @type {{tests:unknown[]}} */ group)=>group.tests,hashes:new Map(),...engine},host),roots,host,ui};
}

test('class items span their tests for the gutter glyph and Go to Test; Other and Unmapped nodes sort last; projects show busy',async()=>{
 const {tree:testTree,roots}=tree();
 const node=(/** @type {string} */ type)=>({'location.type':type});
 const group={id:'g',project:'/w/T.csproj',framework:'net10.0',file:'/w/CalcTests.cs',tests:[
  {id:'a',name:'Adds',file:'/w/CalcTests.cs',line:12,endLine:15,node:node('N.CalcTests')},{id:'b',name:'Subtracts',file:'/w/CalcTests.cs',line:20,node:node('N.CalcTests')},
  {id:'c',name:'Elsewhere',file:'/w/Partial.cs',line:3,node:node('N.CalcTests')},{id:'d',name:'Nested',file:'/w/CalcTests.cs',line:40,endLine:44,node:node('N.CalcTests+Inner')}]};
 const other={id:'o',project:'/w/T.csproj',framework:'net10.0',tests:[]};
 await testTree.update([group,other]);
 const calc=testTree.items.get('class:g:N.CalcTests'),inner=testTree.items.get('class:g:N.CalcTests+Inner');
 assert.deepEqual([calc.range.start.line,calc.range.end.line],[11,20],'from the first test line to the last test end, in the class item\'s file');
 assert.deepEqual([inner.range.start.line,inner.range.end.line],[39,44]);
 assert.equal(testTree.items.get('file:g').sortText,undefined);
 assert.match(testTree.items.get('file:o').sortText,/^￿Other tests/);
 testTree.publishResult({id:'u',project:'/w/T.csproj',framework:'net10.0',runtimeOnly:true,tests:[]},{id:'r',name:'Row',outcome:'passed'});
 assert.match(testTree.items.get('file:u').sortText,/^￿Unmapped runtime tests/);
 testTree.setBusy(true);assert.deepEqual(roots.values.map(item=>item.busy),[true]);
 testTree.setBusy(false);assert.deepEqual(roots.values.map(item=>item.busy),[false]);
});

test('deterministic /_/ stack paths link to the one workspace file they stand for',()=>{
 const known=['/repo/src/Calc/Calc.cs','/repo/tests/CalcTests.cs','/repo/a/Dup.cs','/repo/b/Dup.cs'];
 const named=(/** @type {string} */ name)=>known.filter(file=>path.basename(file).toLowerCase()===name);
 assert.equal(mapDeterministicPath('/_/src/Calc/Calc.cs',named),'/repo/src/Calc/Calc.cs');
 assert.equal(mapDeterministicPath('/_1/Calc/Calc.cs',named),'/repo/src/Calc/Calc.cs','a source root below the workspace root still matches');
 assert.equal(mapDeterministicPath('/_/Dup.cs',named),undefined,'ambiguous paths stay unlinked');
 assert.equal(mapDeterministicPath('/_/src/Missing.cs',named),undefined);
 assert.equal(mapDeterministicPath('/repo/src/Calc/Calc.cs',named),undefined,'real paths are left alone');
 const {ui}=tree();
 const message=ui.failureMessage({message:'boom',stack:'   at Calc.Divide() in /_/src/Calc/Calc.cs:line 9\n   at CalcTests.Divides() in /_/tests/CalcTests.cs:line 30'},{id:'g:t'},['/repo'],named);
 assert.deepEqual(message.stackTrace.map((/** @type {{uri:{fsPath:string}}} */ frame)=>frame.uri.fsPath),['/repo/src/Calc/Calc.cs','/repo/tests/CalcTests.cs']);
 assert.equal(message.location.uri.fsPath,'/repo/src/Calc/Calc.cs');assert.equal(message.location.range.line,8);
});

test('build diagnostics reach the Problems panel per testy.problems.publishBuildDiagnostics',()=>{
 for(const [mode,csharp,published] of [['always',true,true],['never',false,false],['auto',true,false],['auto',false,true],[undefined,true,false]]) {
  const set=[];
  const vscode={languages:{createDiagnosticCollection:()=>({clear(){},set:(/** @type {any[]} */ ...args)=>set.push(args),dispose(){}})},extensions:{getExtension:()=>csharp?{isActive:true}:undefined},
   Position:class{},Range:class{},Diagnostic:class{},DiagnosticSeverity:{Error:0,Warning:1},Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})}};
  const {DiagnosticsPublisher}=loadUi({vscode}).module('diagnosticsPublisher');
  const publisher=new DiagnosticsPublisher({info(){},warn(){},error(){}},()=>['/w'],()=>mode);
  publisher.push('/w/A.cs(3,5): error CS1002: ; expected [/w/A.csproj]\n');
  publisher.publish();
  assert.equal(set.length>0,published,`${mode} with the C# extension ${csharp?'active':'absent'}`);
 }
});

test('Run Affected Tests for a project or folder runs the C# sources Testy knows in it',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'testy-folder-')),folder=normalizePath(path.join(root,'src'));
 fs.mkdirSync(folder);
 const sources=[`${folder}/A.cs`,`${folder}/Deep/B.cs`],project=`${folder}/Lib.csproj`;
 const f=createTesty({window:{showInformationMessage:async()=>undefined}});
 Object.defineProperty(f.testy.engine,'projects',{value:[{file:project,sourceFiles:sources},{file:`${root}/Other/Other.csproj`,sourceFiles:[`${root}/Other/C.cs`]}]});
 /** @type {unknown[]} */ const batches=[];f.testy.engine.run=async (/** @type {{files:unknown}} */ batch)=>{batches.push(batch.files);return{files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};};
 await f.testy.runFiles([{scheme:'file',fsPath:project}]);
 await f.testy.runFiles([{scheme:'file',fsPath:folder}]);
 await f.testy.runFiles([{scheme:'file',fsPath:path.join(root,'Unknown.csproj')}]);
 assert.deepEqual(JSON.parse(JSON.stringify(batches)),[sources,sources,[normalizePath(path.join(root,'Unknown.csproj'))]]);
 assert.deepEqual(f.runs.map(run=>run.name),['Testy · run file: Lib.csproj','Testy · run file: src','Testy · run file: Unknown.csproj']);
 await f.testy.dispose();fs.rmSync(root,{recursive:true,force:true});
});

test('profiles open their settings; refresh marks projects busy; a workspace without test projects shows the Testing welcome',async()=>{
 /** @type {unknown[][]} */ const opened=[];
 const f=createTesty({window:{showErrorMessage:async()=>undefined}});
 f.vscode.commands.executeCommand=async(/** @type {string} */ command,/** @type {any[]} */ ...args)=>{if(command==='setContext')f.keys.set(args[0],args[1]);else opened.push([command,...args]);};
 for(const profile of f.profiles)profile.configureHandler();
 assert.deepEqual(opened.map(([,query])=>query),['@id:testy.additionalConfigurations,testy.buildConfiguration,testy.testArguments',
  '@id:testy.runWithCoverage,testy.showCoverage,testy.additionalConfigurations','@id:testy.debugConfiguration,testy.additionalConfigurations']);
 /** @type {boolean[]} */ const busy=[];f.testy.tree.setBusy=(/** @type {boolean} */ value)=>busy.push(value);
 f.testy.engine.run=async()=>({files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true});
 await f.testy.controller.refreshHandler({isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})});
 assert.deepEqual(busy,[true,false]);
 const {EnvironmentError}=require('../../out/core/errors');
 f.testy.reportError(new EnvironmentError('no-test-project','No test project can run under Testy.'));await tick();
 assert.equal(f.keys.get('testy.noTestProjects'),true);
 f.testy.updateTree=async()=>undefined;
 f.events.discovered([{id:'g',project:'/workspace/T.csproj',framework:'net10.0',tests:[]}]);await tick();
 assert.equal(f.keys.get('testy.noTestProjects'),false);
 const welcome=/** @type {{view:string,contents:string}} */ (manifest.contributes.viewsWelcome.find(entry=>entry.when==='testy.noTestProjects'));
 assert.equal(welcome.view,'workbench.view.testing');assert.match(/** @type {Record<string,string>} */ (nls)[welcome.contents.slice(1,-1)],/command:testy\.showOutput/);
 await f.testy.dispose();
});

test('keybindings avoid VS Code\'s Testing chords; the rebuild command does not look like Refresh',()=>{
 // VS Code binds Ctrl/Cmd+; followed by A, C, E, F, L and their Ctrl/Shift variants, plus Ctrl+I/M/O/R/X.
 const builtIn=new Set(['a','c','e','f','l','ctrl+a','ctrl+c','ctrl+e','ctrl+f','ctrl+l','ctrl+i','ctrl+m','ctrl+o','ctrl+r','ctrl+x','ctrl+shift+a','ctrl+shift+c','ctrl+shift+f','ctrl+shift+i','ctrl+shift+l']);
 const {keybindings,commands,menus}=manifest.contributes;
 assert.deepEqual(keybindings.map(binding=>binding.command).sort(),['testy.runAffected','testy.runCoveringTests']);
 for(const binding of keybindings) {
  const [first,second]=binding.key.split(' ');
  assert.equal(first,'ctrl+;');assert.equal(binding.mac,binding.key.replace(/ctrl/g,'cmd'));
  assert.ok(!builtIn.has(second),`${binding.key} is free`);assert.match(binding.when,/testy\.active/);
 }
 assert.equal(/** @type {{icon:string}} */ (commands.find(command=>command.command==='testy.refreshTests')).icon,'$(run-all)');
 assert.match(nls['command.refreshTests'],/Run All/);
 assert.ok(menus['explorer/context'].some(item=>item.command==='testy.runFolder'&&/explorerResourceIsFolder/.test(item.when)&&/\.csproj/.test(item.when)));
 assert.match(nls['config.additionalConfigurations'],/Debug \(Release\)/);
 assert.match(manifest.contributes.configuration.properties['testy.fileWatcherPattern'].default,/razor,cshtml,xaml,axaml,proto/);
 assert.equal(manifest.contributes.configuration.properties['testy.problems.publishBuildDiagnostics'].default,'auto');
});
