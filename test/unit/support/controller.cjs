const os=require('node:os');
const {loadUi}=require('./ui.cjs');

/**
 * A `Testy` controller built against a recording stub of the VS Code API.
 * `window`, `workspace`, `tests` and `configuration` replace or extend the defaults; `api` adds other namespaces.
 */
/**
 * @param {{window?: Record<string, any>, workspace?: Record<string, any>, tests?: Record<string, any>, settings?: Record<string, any>, configuration?: Record<string, any>, roots?: string[], api?: Record<string, any>}} [options]
 */
function createTesty({window={},workspace={},tests={},settings={},configuration={},roots=['/workspace'],api={}}={}) {
 const disposable=()=>({dispose(){}});
 /** @type {any[]} */ const profiles=[];
 /** @type {any[]} */ const output=[];
 /** @type {any[]} */ const runs=[];
 /** @type {Map<string, unknown>} */ const keys=new Map();
 const channel={...disposable(),append(){},appendLine(){},info:(/** @type {string} */ text)=>output.push(text),warn:(/** @type {string} */ text)=>output.push(text),error:(/** @type {string} */ text)=>output.push(text),show(){}};
 /** @type {any} Recording stub: only the VS Code surface the controller touches. */
 const vscode={TestRunProfileKind:{Run:1,Coverage:3,Debug:2},StatusBarAlignment:{Left:1},ProgressLocation:{Window:10,Notification:15},
  TestRunRequest:class{constructor(/** @type {unknown} */ include,/** @type {unknown} */ exclude,/** @type {unknown} */ profile,/** @type {unknown} */ continuous){Object.assign(this,{include,exclude,profile,continuous});}},
  tests:{createTestController:()=>({...disposable(),items:{replace(){}},invalidateTestResults(){},createTestRun:(/** @type {unknown} */ request,/** @type {unknown} */ name,/** @type {unknown} */ persist)=>{const run={request,name,persist,token:{onCancellationRequested:()=>({dispose(){}})},appendOutput(){},end(){},enqueued(){}};runs.push(run);return run;},
   createRunProfile:(/** @type {unknown} */ label,/** @type {unknown} */ kind,/** @type {unknown} */ handler,/** @type {unknown} */ isDefault,/** @type {unknown} */ tag,/** @type {unknown} */ supportsContinuousRun)=>{const profile={label,kind,handler,isDefault,supportsContinuousRun,disposed:false,...disposable()};profile.dispose=()=>{profile.disposed=true;};profiles.push(profile);return profile;},...tests})},
  languages:{createDiagnosticCollection:()=>({...disposable(),clear(){},set(){}}),registerHoverProvider:disposable},ThemeColor:class{},OverviewRulerLane:{Left:1},Uri:{joinPath:()=>({})},
  commands:{registerCommand:disposable,executeCommand:async(/** @type {string} */ command,/** @type {string} */ key,/** @type {unknown} */ value)=>{if(command==='setContext')keys.set(key,value);}},
  window:{visibleTextEditors:[],createOutputChannel:()=>channel,createStatusBarItem:()=>({...disposable(),show(){}}),createTextEditorDecorationType:disposable,onDidChangeVisibleTextEditors:disposable,...window},
  workspace:{onDidSaveTextDocument:disposable,onDidDeleteFiles:disposable,onDidRenameFiles:disposable,onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidChangeTextDocument:disposable,
   getConfiguration:()=>({get:(/** @type {string} */ key,/** @type {unknown} */ fallback)=>key in settings?settings[key]:fallback}),...workspace},...api};
 const state=()=>{/** @type {Map<string, unknown>} */ const values=new Map();return{get:(/** @type {string} */ key)=>values.get(key),update:async(/** @type {string} */ key,/** @type {unknown} */ value)=>{values.set(key,value);}};};
 const base={enabled:true,trigger:'save',showCoverage:false,inlineResults:'off',debounce:100,pattern:'**/*.cs',excludes:[],configuration:'Debug',additionalConfigurations:[],folderConflicts:[],...configuration};
 const ui=loadUi({vscode,stubs:{configuration:{configuration:()=>({...base})}}});
 const testy=new ui.Testy({extensionUri:{},storageUri:{fsPath:os.tmpdir()},globalStorageUri:{fsPath:os.tmpdir()},extensionPath:process.cwd(),workspaceState:state(),globalState:state()},roots);
 return{testy,ui,vscode,profiles,output,keys,runs,events:testy.engine.options.events,settings:base};
}

module.exports={createTesty};
