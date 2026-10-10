const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');

const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(choose=()=>undefined) {
 const shown=[],commands=[];
 const show=severity=>async(message,...actions)=>{shown.push({severity,message,actions:[...actions]});return choose(actions);};
 let folders;
 const f=createTesty({window:{showErrorMessage:show('error'),showWarningMessage:show('warning')},
  workspace:{onDidChangeWorkspaceFolders:handler=>{folders=handler;return{dispose(){}};}}});
 f.vscode.commands.executeCommand=async(...args)=>{commands.push(args);};
 return{...f,shown,commands,changeFolders:()=>folders()};
}

test('environment failures are recognized; routine build and test failures are not',()=>{
 const {environmentError}=createTesty().ui.module('controller');
 for(const message of ['Cannot find dotnet on PATH; the working directory /w is not searched. Configure an absolute path.',
  'Could not start /usr/bin/dotnet: permission denied','Testy requires .NET SDK 10 or later; /w selects 8.0.100. Check its global.json.',
  'Analyzing C# declarations failed.\nUnhandled exception','The command exceeded its time limit: analyzer',
  'testy.solution could not be read: /w/A.sln. ENOENT','No test project can run under Testy.\nA: not MTP'])
  assert.equal(environmentError(message),true,message);
 for(const message of ['Build failed (exit 1).\nerror CS1002: ; expected','The test application exited during run (exit 3).','The command exceeded its time limit: dotnet build'])
  assert.equal(environmentError(message),false,message);
});

test('startup and environment errors notify once per distinct error with Show Output and Open Settings; routine failures stay quiet',async()=>{
 const f=fixture(actions=>actions[1]);
 f.testy.reportError(new Error('Build failed (exit 1).\nerror CS1002'));
 assert.equal(f.shown.length,0,'routine run failures only update the status bar');
 assert.equal(f.testy.snapshot().error,'Build failed (exit 1).\nerror CS1002');
 f.testy.reportError(new Error('Cannot find dotnet on PATH; configure an absolute path.'));
 f.testy.reportError(new Error('Cannot find dotnet on PATH; configure an absolute path.'));
 await tick();
 assert.equal(f.shown.length,1,'the same error is shown once per session');
 assert.deepEqual(f.shown[0],{severity:'error',message:'Testy: Cannot find dotnet on PATH; configure an absolute path.',actions:['Show Output','Open Settings']});
 assert.deepEqual(f.commands.filter(([command])=>command!=='setContext').map(args=>[...args]),[['workbench.action.openSettings','@ext:reginaldFerland.testy']]);
 f.testy.reportError(new Error('The restore failed\nwith details'),true);
 await tick();
 assert.equal(f.shown.length,2,'explicit startup failures notify too');assert.equal(f.shown[1].message,'Testy: The restore failed');
 const abort=new Error('cancelled');abort.name='AbortError';f.testy.reportError(abort,true);
 assert.equal(f.shown.length,2);
 await f.testy.dispose();
});

test('a failing workspace-folder change is reported instead of escaping the event handler',async()=>{
 const f=fixture();
 f.vscode.workspace.workspaceFolders=[{uri:{fsPath:'/workspace'}}];
 f.testy.engine.setRoots=()=>{throw new Error('roots exploded');};
 assert.doesNotThrow(()=>f.changeFolders());
 await tick();
 assert.equal(f.testy.snapshot().error,'roots exploded');
 assert.equal(f.shown.length,1);
 await f.testy.dispose();
});
