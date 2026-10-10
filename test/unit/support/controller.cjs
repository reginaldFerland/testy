const os=require('node:os');
const {loadUi}=require('./ui.cjs');

/**
 * A `Testy` controller built against a recording stub of the VS Code API.
 * `window`, `workspace`, `tests` and `configuration` replace or extend the defaults; `api` adds other namespaces.
 */
function createTesty({window={},workspace={},tests={},settings={},configuration={},roots=['/workspace'],api={}}={}) {
 const disposable=()=>({dispose(){}}),profiles=[],output=[],keys=new Map(),runs=[];
 const channel={...disposable(),append(){},appendLine(){},info:text=>output.push(text),warn:text=>output.push(text),error:text=>output.push(text),show(){}};
 const vscode={TestRunProfileKind:{Run:1,Coverage:3,Debug:2},StatusBarAlignment:{Left:1},ProgressLocation:{Window:10,Notification:15},
  TestRunRequest:class{constructor(include,exclude,profile,continuous){Object.assign(this,{include,exclude,profile,continuous});}},
  tests:{createTestController:()=>({...disposable(),items:{replace(){}},invalidateTestResults(){},createTestRun:(request,name,persist)=>{const run={request,name,persist,token:{onCancellationRequested:()=>({dispose(){}})},appendOutput(){},end(){},enqueued(){}};runs.push(run);return run;},
   createRunProfile:(label,kind,handler,isDefault,tag,supportsContinuousRun)=>{const profile={label,kind,handler,isDefault,supportsContinuousRun,disposed:false,...disposable()};profile.dispose=()=>{profile.disposed=true;};profiles.push(profile);return profile;},...tests})},
  languages:{createDiagnosticCollection:()=>({...disposable(),clear(){},set(){}})},ThemeColor:class{},Uri:{joinPath:()=>({})},
  commands:{registerCommand:disposable,executeCommand:async(command,key,value)=>{if(command==='setContext')keys.set(key,value);}},
  window:{visibleTextEditors:[],createOutputChannel:()=>channel,createStatusBarItem:()=>({...disposable(),show(){}}),createTextEditorDecorationType:disposable,onDidChangeVisibleTextEditors:disposable,...window},
  workspace:{onDidSaveTextDocument:disposable,onDidDeleteFiles:disposable,onDidRenameFiles:disposable,onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidChangeTextDocument:disposable,
   getConfiguration:()=>({get:(key,fallback)=>key in settings?settings[key]:fallback}),...workspace},...api};
 const state=()=>{const values=new Map();return{get:key=>values.get(key),update:async(key,value)=>{values.set(key,value);}};};
 const base={enabled:true,trigger:'save',showCoverage:false,debounce:100,pattern:'**/*.cs',excludes:[],configuration:'Debug',additionalConfigurations:[],folderConflicts:[],...configuration};
 const ui=loadUi({vscode,stubs:{configuration:{configuration:()=>({...base})}}});
 const testy=new ui.Testy({extensionUri:{},storageUri:{fsPath:os.tmpdir()},globalStorageUri:{fsPath:os.tmpdir()},extensionPath:process.cwd(),workspaceState:state(),globalState:state()},roots);
 return{testy,ui,vscode,profiles,output,keys,runs,events:testy.engine.options.events,settings:base};
}

module.exports={createTesty};
