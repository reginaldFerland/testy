const {test}=require('node:test'),assert=require('node:assert/strict'),os=require('node:os');
const {loadUi}=require('./support/ui.cjs');


function editor(config={}) {
 const disposable=()=>({dispose(){}}),invalidated=[],patterns=[],handlers={};
 const controller={...disposable(),createRunProfile:()=>({}),invalidateTestResults:items=>invalidated.push(...items.map(item=>item.id))};
 const vscode={l10n:{t:(message,...args)=>message.replace(/\{(\d+)\}/g,(_,index)=>String(args[index]))},tests:{createTestController:()=>controller},TestRunProfileKind:{Run:1,Coverage:3,Debug:2},StatusBarAlignment:{Left:1},TestTag:class{constructor(id){this.id=id;}},
  languages:{createDiagnosticCollection:()=>({...disposable(),clear(){},set(){}})},
  ThemeColor:class {},RelativePattern:class {constructor(base,pattern){Object.assign(this,{base,pattern});}},Uri:{joinPath:()=>({})},
  commands:{registerCommand:disposable,executeCommand:async()=>{}},
  window:{visibleTextEditors:[],createOutputChannel:()=>({...disposable(),append(){},appendLine(){},info(){},warn(){},error(){},show(){}}),createStatusBarItem:()=>({...disposable(),show(){}}),
   createTextEditorDecorationType:disposable,onDidChangeVisibleTextEditors:disposable},
  workspace:{onDidSaveTextDocument:callback=>{handlers.save=callback;return disposable();},onDidDeleteFiles:disposable,onDidRenameFiles:disposable,
   onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidChangeTextDocument:disposable,
   createFileSystemWatcher:pattern=>{patterns.push(pattern);return {...disposable(),onDidChange(){},onDidCreate(){},onDidDelete(){}};}}
 };
 const {Testy}=loadUi({vscode,stubs:{configuration:{configuration:()=>({enabled:true,trigger:'save',showCoverage:false,debounce:100,
   pattern:require('../../package.json').contributes.configuration.properties['testy.fileWatcherPattern'].default,excludes:[],...config})}}});
 const state=()=>{const values=new Map();return{get:key=>values.get(key),update:async(key,value)=>{values.set(key,value);}};};
 const ui=new Testy({extensionUri:{},storageUri:{fsPath:os.tmpdir()},globalStorageUri:{fsPath:os.tmpdir()},extensionPath:process.cwd(),workspaceState:state(),globalState:state()},['/workspace']);
 return {ui,invalidated,patterns,handlers};
}

test('manual leaf results preserve unselected runtime failures until those rows actually rerun',t=>{
 const {selectManual}=require('../../out/services/engine'),{ui,invalidated}=editor();t.after(()=>ui.dispose());
 const node=id=>({id,name:id,node:{uid:id},line:1}),ordinary=node('ordinary'),row=node('deferred-failure');
 const group={id:'file-id',project:'/workspace/Tests.csproj',framework:'net10.0',file:'/workspace/Tests.cs',tests:[ordinary]};
 ui.engine.groups=[group];ui.engine.runtime.set(group.id,new Map([[row.id,row]]));
 for(const test of [ordinary,row])ui.tree.items.set(`${group.id}:${test.id}`,{id:`${group.id}:${test.id}`});
 ui.tree.setOutcome(`${group.id}:${ordinary.id}`,'passed');ui.tree.setOutcome(`${group.id}:${row.id}`,'failed');
 const groups=selectManual([group],{groups:new Set([group.id]),tests:new Map([[group.id,new Set([ordinary.id])]])},g=>ui.engine.knownTests(g));
 ui.engine.options.events.selected({groups,reason:'Manual run',fallback:false});
 ui.tree.publishResult(group,{id:ordinary.id,name:ordinary.name,outcome:'passed',duration:0});
 assert.deepEqual(invalidated,[`${group.id}:${ordinary.id}`]);assert.equal(ui.tree.outcomes.get(`${group.id}:${row.id}`),'failed');assert.equal(ui.tree.failed,1);
 ui.engine.options.events.selected({groups:[group],reason:'Containing file',fallback:true});
 assert.equal(ui.tree.outcomes.get(`${group.id}:${row.id}`),'failed','a discovered parent does not prove the deferred row will run');
 ui.tree.publishResult(group,{id:row.id,name:row.name,outcome:'passed',duration:0});assert.equal(ui.tree.failed,0);
});
