const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {loadUi}=require('./support/ui.cjs');
const {createTesty}=require('./support/controller.cjs');
const manifest=require('../../package.json'),nls=require('../../package.nls.json');

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('manifest: numeric navigation order, context menus with localized titles, limited trust and .slnf activation',()=>{
 const {menus,commands,configuration}=manifest.contributes;
 assert.deepEqual(menus['view/title'].filter(item=>item.group.startsWith('navigation')).map(item=>item.group),['navigation@1','navigation@2','navigation@2']);
 const titles=new Map(commands.map(command=>[command.command,command.title]));
 for(const [menu,command] of [['testing/item/context','testy.explainSelection'],['testing/item/context','testy.excludeProject'],
  ['testing/message/context','testy.showOutput'],['editor/context','testy.runFile'],['explorer/context','testy.runFile']]) {
  assert.ok(menus[menu].some(item=>item.command===command),`${menu} offers ${command}`);
  assert.ok(nls[titles.get(command).slice(1,-1)],`${command} has a localized title`);
 }
 assert.match(menus['testing/message/context'][0].when,/testMessage == testy\.failure/);
 assert.match(menus['testing/item/context'].find(item=>item.command==='testy.excludeProject').when,/testId =~ \/\^project:\//);
 assert.ok(manifest.activationEvents.includes('workspaceContains:**/*.slnf'));
 const trust=manifest.capabilities.untrustedWorkspaces;
 assert.equal(trust.supported,'limited');
 for(const key of ['testy.dotnetPath','testy.coverageToolPath','testy.testArguments','testy.solution','testy.debugConfiguration'])assert.ok(trust.restrictedConfigurations.includes(key),key);
 for(const key of trust.restrictedConfigurations)assert.ok(configuration.properties[key],`${key} is a contributed setting`);
 for(const key of ['solution','projects.include','projects.exclude','exclude','buildConfiguration','testArguments','debugConfiguration'])assert.equal(configuration.properties[`testy.${key}`].scope,'resource',key);
});

test('failure messages carry the context value the Show Output message action is bound to',()=>{
 const ui=loadUi({vscode:{TestMessage:class{constructor(message){this.message=message;}},Uri:{file:fsPath=>({fsPath})},Position:class{},Location:class{}}});
 assert.equal(ui.failureMessage({outcome:'failed',message:'boom'},{},[]).contextValue,'testy.failure');
});

test('"Why was this selected?" explains test, file and project items from the latest selection',()=>{
 const {explainItem}=loadUi().module('ui/selectionCause');
 const group={id:'g1',project:'/w/T/T.csproj',file:'/w/T/CalcTests.cs',tests:[]},other={id:'g2',project:'/w/T/T.csproj',file:'/w/T/Other.cs',tests:[]};
 const selection={groups:[group],reason:'Files that exercised the changed code',causes:new Map([['g1',{kind:'covers',files:['/w/src/Calc.cs'],more:0}]])};
 const testIds=new Map([['g1:t1',{group:'g1',test:'t1'}]]);
 assert.equal(explainItem(undefined,testIds,'g1:t1','Adds'),'Adds: no Testy run has selected tests in this session yet.');
 assert.equal(explainItem(selection,testIds,'g1:t1','Adds'),'Adds was selected in the latest run. CalcTests.cs: covers Calc.cs (changed)');
 assert.equal(explainItem(selection,testIds,'file:g1','CalcTests.cs'),'CalcTests.cs was selected in the latest run. CalcTests.cs: covers Calc.cs (changed)');
 assert.equal(explainItem(selection,testIds,`file:${other.id}`,'Other.cs'),'Other.cs was not selected in the latest run (Files that exercised the changed code).');
 assert.equal(explainItem(selection,testIds,'project:/w/T/T.csproj','T'),'T: 1 test files were selected in the latest run. CalcTests.cs: covers Calc.cs (changed)');
 assert.equal(explainItem(selection,testIds,'project:/w/U/U.csproj','U'),'U was not selected in the latest run (Files that exercised the changed code).');
});

test('Exclude Project adds a folder-relative pattern at workspace level, or folder level in a multi-root workspace',async()=>{
 for(const multiRoot of [false,true]) {
  const updates=[],root=path.resolve('/workspace'),folder={uri:{fsPath:root},name:'workspace'};
  const f=createTesty({api:{ConfigurationTarget:{Workspace:2,WorkspaceFolder:3}},window:{showInformationMessage:async()=>undefined},workspace:{
   workspaceFolders:multiRoot?[folder,{uri:{fsPath:path.resolve('/other')},name:'other'}]:[folder],getWorkspaceFolder:()=>folder,
   getConfiguration:()=>({get:(key,fallback)=>fallback,inspect:()=>({workspaceValue:['old/**'],workspaceFolderValue:multiRoot?['mine/**']:undefined}),
    update:async(...args)=>{updates.push(args);}})}});
  f.vscode.Uri.file=fsPath=>({fsPath});
  await f.testy.excludeProject({id:`project:${path.join(root,'tests','Slow [1]','Slow.csproj')}`,label:'Slow'});
  await f.testy.excludeProject({id:'file:g1',label:'not a project'});
  assert.deepEqual(JSON.parse(JSON.stringify(updates)),[['projects.exclude',[multiRoot?'mine/**':'old/**','tests/Slow [[]1[]]/Slow.csproj'],multiRoot?3:2]]);
  await f.testy.dispose();
 }
});

test('the status bar exposes its state and details to screen readers without icon names',()=>{
 let item;
 const vscode={StatusBarAlignment:{Left:1},ThemeColor:class{},commands:{executeCommand:async()=>undefined},
  window:{createStatusBarItem:()=>(item={show(){},dispose(){}})}};
 const {StatusBar,restrictedStatus}=loadUi({vscode}).module('ui/statusBar');
 const bar=new StatusBar();
 bar.update({paused:false,running:false,scheduling:'idle',phase:undefined,lastError:'',lastSummary:{files:2,duration:1500,coverageAvailable:true},passed:3,failed:1,hasTests:true,coverageSuffix:' · 80%',continuousOverride:false});
 assert.equal(item.accessibilityInformation.label,'1 failed · 80%. 3 passed · 1 failed. Last run: 2 test files in 1.5s. Click for Testy actions.');
 assert.equal(item.accessibilityInformation.role,'button');
 restrictedStatus();
 assert.equal(item.command,'workbench.trust.manage');assert.match(item.accessibilityInformation.label,/^Testy: Restricted Mode\. /);
});

test('in Restricted Mode activation executes nothing and starts Testy once trust is granted',async()=>{
 let grant,constructed=0,started=0,item;
 const subscriptions=[];
 const vscode={StatusBarAlignment:{Left:1},workspace:{isTrusted:false,workspaceFolders:[{uri:{fsPath:'/workspace'}}],onDidGrantWorkspaceTrust:handler=>{grant=handler;return{dispose(){}};}},
  window:{createStatusBarItem:()=>(item={disposed:false,show(){},dispose(){item.disposed=true;}})}};
 class Testy {constructor(){constructed++;} start(){started++;return Promise.resolve();} snapshot(){return{started:true};} dispose(){return Promise.resolve();}}
 const extension=loadUi({vscode,stubs:{controller:{Testy}}}).module('extension');
 const api=extension.activate({subscriptions});
 assert.equal(constructed,0);assert.deepEqual({...api.snapshot()},{restricted:true});
 assert.equal(item.text,'$(shield) Testy: Restricted Mode');
 grant();await tick();
 assert.equal(constructed,1);assert.equal(started,1);assert.equal(item.disposed,true);
 assert.deepEqual({...api.snapshot()},{started:true});
 await extension.deactivate();
});
