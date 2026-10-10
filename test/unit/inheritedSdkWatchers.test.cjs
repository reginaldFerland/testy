// @ts-check
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {normalizePath}=require('../../out/core/paths');
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

test('inherited SDK candidates use bounded watchers and ignore unrelated external saves',async t=>{
 const {sdkConfigurationFiles}=require('../../out/services/projects'),{ui,patterns}=editor({trigger:'fileSystem'});t.after(()=>ui.dispose());
 const root=normalizePath(path.parse(process.cwd()).root),workspace=normalizePath(path.join(root,'workspace')),global=normalizePath(path.join(root,'global.json'));ui.roots=[workspace];
 const candidates=sdkConfigurationFiles(path.join(workspace,'Tests','Tests.csproj'));
 assert.ok(candidates.includes(global));assert.ok(candidates.includes(normalizePath(path.join(workspace,'Tests','global.json'))));
 ui.engine.setInputs([...candidates,path.join(workspace,'Tests.cs')]);
 assert.equal(patterns.some(p=>p.base===root&&p.pattern.includes('**')),false);assert.ok(patterns.some(p=>p.base===root&&p.pattern==='*'));
 const requests=[];ui.scheduler.request=(...args)=>requests.push(args);ui.engine.markChanged=async()=>{};
 await ui.changed({scheme:'file',fsPath:path.join(root,'elsewhere','Unrelated.cs')},'class C {}');assert.equal(requests.length,0);
 await ui.changed({scheme:'file',fsPath:global},'{}');assert.equal(requests.length,1);
 const count=patterns.length;ui.engine.setInputs([...candidates,path.join(workspace,'Tests.cs')]);assert.equal(patterns.length,count,'unchanged inputs preserve watchers');
});
