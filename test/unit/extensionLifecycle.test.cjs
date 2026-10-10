const {test}=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {loadUi}=require('./support/ui.cjs');

const folders=['/one','/two','/three'].map(fsPath=>({uri:{fsPath},name:fsPath.slice(1)}));
const folderOf=uri=>folders.find(folder=>uri.fsPath.startsWith(`${folder.uri.fsPath}/`));
const item=(fsPath,parent)=>({uri:fsPath&&{fsPath},parent});

test('debugging attaches in the workspace folder that contains the run\'s tests',async()=>{
 const started=[],custom=new Map();
 const {Testy}=loadUi({vscode:{workspace:{workspaceFolders:folders,getWorkspaceFolder:folderOf,
   getConfiguration:(section,scope)=>({get:(key,fallback)=>custom.get(scope?.fsPath)??fallback})},
  debug:{startDebugging:async(folder,configuration,options)=>{started.push({folder,configuration,options});return true;}}}});
 const proto=Testy.prototype,activeRun={};
 const attach=async include=>{
  const context={activeRun,activeRequest:include&&{include}};context.debugFolder=()=>proto.debugFolder.call(context);
  await proto.attachDebugger.call(context,4242);return started.at(-1);
 };
 const second=await attach([item('/two/Tests/A.cs')]);
 assert.equal(second.folder,folders[1]);assert.equal(second.configuration.processId,'4242');assert.equal(second.options.testRun,activeRun);
 assert.equal((await attach([item('/elsewhere/Linked.cs'),item('/three/Tests/B.cs')])).folder,folders[2],'the first included item inside a folder decides');
 const project=item('/three/Tests/Tests.csproj');
 assert.equal((await attach([item(undefined,project)])).folder,folders[2],'an item without a location uses its project');
 assert.equal((await attach([item('/elsewhere/Linked.cs')])).folder,folders[0],'tests outside every folder fall back to the first folder');
 assert.equal((await attach(undefined)).folder,folders[0],'a run of everything falls back to the first folder');
 assert.equal((await attach([])).folder,folders[0]);
 assert.deepEqual({...second.configuration},{type:'coreclr',name:'Testy: Debug tests',request:'attach',processId:'4242'});
 custom.set('/two',{justMyCode:false,type:'monovsdbg',request:'launch',processId:1,name:'Mine'});
 assert.deepEqual({...(await attach([item('/two/Tests/A.cs')])).configuration},{type:'monovsdbg',name:'Mine',justMyCode:false,request:'attach',processId:'4242'},
  'testy.debugConfiguration of the folder is merged; request and process stay Testy\'s');
 custom.set('/two',['not','an','object']);
 assert.equal((await attach([item('/two/Tests/A.cs')])).configuration.type,'coreclr');
});

test('disposing resets the context keys that enable the extension\'s menus',async()=>{
 const disposable=()=>({dispose(){}}),keys=new Map(),commands=[];
 const output={...disposable(),append(){},appendLine(){},info(){},warn(){},error(){},show(){}};
 const vscode={tests:{createTestController:()=>({...disposable(),createRunProfile:()=>({}),items:{replace(){}}})},TestRunProfileKind:{Run:1,Coverage:3,Debug:2},StatusBarAlignment:{Left:1},
  languages:{createDiagnosticCollection:()=>({...disposable(),clear(){},set(){}})},ThemeColor:class{},Uri:{joinPath:()=>({})},
  commands:{registerCommand:disposable,executeCommand:async(command,key,value)=>{commands.push(command);if(command==='setContext')keys.set(key,value);}},
  window:{visibleTextEditors:[],createOutputChannel:()=>output,createStatusBarItem:()=>({...disposable(),show(){}}),createTextEditorDecorationType:disposable,onDidChangeVisibleTextEditors:disposable},
  workspace:{onDidSaveTextDocument:disposable,onDidDeleteFiles:disposable,onDidRenameFiles:disposable,onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidChangeTextDocument:disposable,
   getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
 const state=()=>{const values=new Map();return{get:key=>values.get(key),update:async(key,value)=>{values.set(key,value);}};};
 const {Testy}=loadUi({vscode,stubs:{configuration:{configuration:()=>({enabled:true,trigger:'save',showCoverage:false,debounce:100,pattern:'**/*.cs',excludes:[],folderConflicts:[],additionalConfigurations:[]})}}});
 const ui=new Testy({extensionUri:{},storageUri:{fsPath:os.tmpdir()},globalStorageUri:{fsPath:os.tmpdir()},extensionPath:process.cwd(),workspaceState:state(),globalState:state()},['/workspace']);
 assert.equal(keys.get('testy.active'),true);
 ui.updateStatus();
 assert.equal(keys.has('testy.paused'),true);
 await ui.dispose();
 assert.equal(keys.get('testy.active'),false);assert.equal(keys.get('testy.paused'),false);assert.equal(keys.get('testy.running'),false);
});
