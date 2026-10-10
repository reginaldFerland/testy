const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

function fixture({deferTask=false}={}) {
 const calls=[],reports=[],listeners=[];let task,finished=false,started=0;
 const token={onCancellationRequested:listener=>{listeners.push(listener);return{dispose(){}};}};
 const progress={report:value=>reports.push({...value})};
 const vscode={ProgressLocation:{Notification:15,Window:10},window:{withProgress:(options,callback)=>{
  started++;calls.push(options);task=()=>callback(progress,token).then(()=>{finished=true;});
  if(!deferTask)return task();
  return new Promise(()=>undefined);}}};
 let cancelled=0;
 const {BaselineProgress}=loadUi({vscode}).module('ui/baselineProgress');
 const baseline=new BaselineProgress(()=>cancelled++);
 return{baseline,calls,reports,listeners,get finished(){return finished;},get started(){return started;},get cancelled(){return cancelled;},run:()=>task()};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));

test('baseline progress uses window progress with an incrementing percentage and ends with the run',async()=>{
 const f=fixture();
 f.baseline.update(undefined);
 assert.equal(f.started,0,'incremental runs have no baseline and show nothing');
 f.baseline.update({completed:0,total:40});
 f.baseline.update({completed:10,total:40});
 f.baseline.update({completed:10,total:40});
 f.baseline.update({completed:40,total:40});
 assert.equal(f.started,1);
 assert.equal(f.calls[0].location,10,'window location, not a popup notification');
 assert.equal(f.calls[0].cancellable,true);
 assert.deepEqual(plain(f.reports),[
  {message:'0% · 0/40 files learned'},{message:'25% · 10/40 files learned',increment:25},{message:'100% · 40/40 files learned',increment:75}]);
 assert.equal(f.baseline.active,true);
 f.baseline.end();await tick();
 assert.equal(f.finished,true);assert.equal(f.baseline.active,false);
 f.baseline.end();
 f.baseline.update({completed:1,total:2});
 assert.equal(f.started,2,'a later baseline run starts a new progress');
 f.baseline.end();
});

test('cancelling the progress cancels the run, but not after it has ended',async()=>{
 const f=fixture();
 f.baseline.update({completed:1,total:4});
 assert.equal(f.listeners.length,1);
 f.listeners[0]();assert.equal(f.cancelled,1);
 f.baseline.end();await tick();
 f.listeners[0]();assert.equal(f.cancelled,1);
});

test('progress reported before VS Code starts the task is delivered when it starts',async()=>{
 const f=fixture({deferTask:true});
 f.baseline.update({completed:2,total:4});
 assert.equal(f.reports.length,0);
 f.run();
 assert.deepEqual(plain(f.reports),[{message:'50% · 2/4 files learned',increment:50}]);
 f.baseline.end();await tick();assert.equal(f.finished,true);
 const ended=fixture({deferTask:true});
 ended.baseline.update({completed:1,total:4});ended.baseline.end();ended.run();await tick();
 assert.equal(ended.finished,true,'a session that ended before the task started still completes');
});

test('an unknown total reports zero percent',()=>{
 const f=fixture();f.baseline.update({completed:0,total:0});
 assert.deepEqual(plain(f.reports),[{message:'0% · 0/0 files learned'}]);f.baseline.end();
});

test('the controller shows baseline progress for automatic runs only, and ends it with the run',async()=>{
 const os=require('node:os');
 const disposable=()=>({dispose(){}}),started=[];
 const output={...disposable(),append(){},appendLine(){},info(){},warn(){},error(){},show(){}};
 const vscode={tests:{createTestController:()=>({...disposable(),createRunProfile:()=>({}),items:{replace(){}}})},TestRunProfileKind:{Run:1,Coverage:3,Debug:2},StatusBarAlignment:{Left:1},
  ProgressLocation:{Window:10},languages:{createDiagnosticCollection:()=>({...disposable(),clear(){},set(){}})},ThemeColor:class{},Uri:{joinPath:()=>({})},
  commands:{registerCommand:disposable,executeCommand:async()=>undefined},
  window:{visibleTextEditors:[],createOutputChannel:()=>output,createStatusBarItem:()=>({...disposable(),show(){}}),createTextEditorDecorationType:disposable,onDidChangeVisibleTextEditors:disposable,
   withProgress:(options,task)=>{started.push(options);return task({report(){}},{onCancellationRequested:()=>disposable()});}},
  workspace:{onDidSaveTextDocument:disposable,onDidDeleteFiles:disposable,onDidRenameFiles:disposable,onDidChangeConfiguration:disposable,onDidChangeWorkspaceFolders:disposable,onDidChangeTextDocument:disposable,
   getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
 const state=()=>{const values=new Map();return{get:key=>values.get(key),update:async(key,value)=>{values.set(key,value);}};};
 const {Testy}=loadUi({vscode,stubs:{configuration:{configuration:()=>({enabled:true,trigger:'save',showCoverage:false,debounce:100,pattern:'**/*.cs',excludes:[],folderConflicts:[],additionalConfigurations:[]})}}});
 const ui=new Testy({extensionUri:{},storageUri:{fsPath:os.tmpdir()},globalStorageUri:{fsPath:os.tmpdir()},extensionPath:process.cwd(),workspaceState:state(),globalState:state()},['/workspace']);
 const events=ui.engine.options.events;
 ui.engine.groups=[{id:'a'},{id:'b'}];
 events.phase({kind:'building'});
 assert.equal(started.length,0,'no baseline, no progress');
 ui.engine.baseline={completed:new Set(['a'])};
 ui.baselineRun=false;events.phase({kind:'testing'});
 assert.equal(started.length,0,'a manual run does not advance the baseline');
 ui.baselineRun=true;events.phase({kind:'testing'});
 assert.equal(started.length,1);assert.equal(started[0].location,10);
 assert.equal(ui.baselineProgress.active,true);
 await ui.dispose();
 assert.equal(ui.baselineProgress.active,false);
});

test('the cancellation listener is disposed when the baseline ends',async()=>{
 let disposed=0;
 const vscode={ProgressLocation:{Window:10},window:{withProgress:(options,callback)=>callback({report(){}},{onCancellationRequested:()=>({dispose(){disposed++;}})})}};
 const {BaselineProgress}=loadUi({vscode}).module('ui/baselineProgress');
 const baseline=new BaselineProgress(()=>undefined);
 baseline.update({completed:1,total:2});
 assert.equal(disposed,0);
 baseline.end();await tick();
 assert.equal(disposed,1);
});
