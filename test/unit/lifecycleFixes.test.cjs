const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createTesty}=require('./support/controller.cjs');
const {loadUi}=require('./support/ui.cjs');
const {TestEngine}=require('../../out/services/engine');
const {startProcess,Shutdown}=require('../../out/services/process');

const sleep=(/** @type {number} */ ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const summary={files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true,failedBatches:0};

/** A controller with scripted engine calls; `consent` answers the baseline question through workspace state.
 * @param {{configuration?: Record<string, any>, run?: (batch: {files: string[]}) => Promise<unknown>}} [options] */
function fixture({configuration={},run}={}) {
 const f=createTesty({configuration:{debounce:20,excludes:['**/obj/**'],...configuration},api:{extensions:{getExtension:()=>undefined}},
  window:{showInformationMessage:async()=>undefined,showErrorMessage:async()=>undefined,showWarningMessage:async()=>undefined}});
 /** @type {any[][]} */ const calls=[];
 f.testy.engine.restore=async()=>undefined;
 f.testy.engine.markChanged=async (/** @type {Iterable<string>} */ files)=>{calls.push(['mark',[...files]]);};
 f.testy.engine.run=run??(async (/** @type {{files: Iterable<string>}} */ batch)=>{calls.push(['run',[...batch.files]]);return summary;});
 void f.testy.context.workspaceState.update('testy.baselineConsent','manual');
 return{...f,calls};
}

test('requests made while the cache restores are held, then run once startup applies the configured pause', async()=>{
 const f=fixture();
 /** @type {(value?: any) => void} */ let release=()=>{}; // replaced synchronously by the promise executor

 f.testy.engine.restore=()=>new Promise(resolve=>{release=resolve;});
 const starting=f.testy.start();
 assert.equal(f.testy.scheduler.isPaused,true,'the scheduler is held from construction');
 assert.equal(f.testy.snapshot().paused,false,'the startup hold is not shown as a user pause');
 f.testy.scheduler.request(['/workspace/A.cs']);
 await sleep(120);
 assert.deepEqual(f.calls.filter(call=>call[0]==='run'),[]);
 release();await starting;await sleep(120);
 assert.deepEqual(f.calls.filter(call=>call[0]==='run'),[['run',['/workspace/A.cs']]]);
 await f.testy.dispose();
});

test('a failing restore is logged and startup still applies the pause setting', async()=>{
 const f=fixture({configuration:{enabled:false}});
 f.testy.engine.restore=async()=>{throw new Error('restore broke');};
 await f.testy.start();
 f.testy.scheduler.request(['/workspace/A.cs']);
 await sleep(120);
 assert.equal(f.testy.snapshot().paused,true);
 assert.deepEqual(f.calls.filter(call=>call[0]==='run'),[],'paused work is retained, not run');
 assert.equal(f.output.filter(line=>line==='restore broke').length,1);
 await f.testy.dispose();
});

test('a cancelled restore still rejects startup', async()=>{
 const f=fixture();
 f.testy.engine.restore=async (/** @type {AbortSignal} */ signal)=>{signal.throwIfAborted();};
 f.testy.lifetime.abort();
 await assert.rejects(f.testy.start(),{name:'AbortError'});
 await f.testy.dispose();
});

test('a failed run is reported exactly once, automatic or manual', async()=>{
 const f=fixture({run:async()=>{throw new Error('boom');}});
 f.testy.started=true;f.testy.applyPause();
 f.testy.scheduler.request(['/workspace/A.cs']);
 await sleep(120);
 assert.equal(f.output.filter(line=>line==='boom').length,1);
 const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};
 await f.testy.manual({include:undefined,exclude:undefined},token,false);
 assert.equal(f.output.filter(line=>line==='boom').length,2,'the manual failure adds one more, not two');
 await f.testy.dispose();
});

test('bursts of file events mark the engine once; build output never reaches the filesystem', async()=>{
 const f=fixture();
 const uri=(/** @type {string} */ fsPath)=>({scheme:'file',fsPath});
 await Promise.all(['A','B','C'].map(name=>f.testy.changes.changed(uri(`/workspace/${name}.cs`))));
 await f.testy.changes.changed(uri('/workspace/obj/Debug/Gen.cs'));
 assert.deepEqual(f.calls,[],'marking waits for the coalescing window');
 await sleep(150);
 assert.equal(f.calls.length,1);
 assert.deepEqual(/** @type {[string, string[]][]} */ (f.calls)[0][1].map((/** @type {string} */ file)=>file.slice(file.lastIndexOf('/')+1)).sort(),['A.cs','B.cs','C.cs']);
 await f.testy.dispose();
});

test('a run flushes pending marks before it reads sources', async()=>{
 const f=fixture();
 await f.testy.changes.changed({scheme:'file',fsPath:'/workspace/A.cs'});
 await f.testy.execute({files:['/workspace/A.cs'],full:false},new AbortController().signal);
 assert.deepEqual(f.calls.map(call=>call[0]),['mark','run']);
 await f.testy.dispose();
});

test('input directories merge into one watcher per root, keep outside directories non-recursive, and fall back to the whole root when oversized', () => {
 /** @type {any[]} */ const patterns=[];
 const ui=loadUi({vscode:{RelativePattern:class{constructor(/** @type {string} */ base,/** @type {string} */ pattern){Object.assign(this,{base,pattern});}},
  workspace:{createFileSystemWatcher:(/** @type {unknown} */ pattern)=>{patterns.push(pattern);return{dispose(){},onDidChange(){},onDidCreate(){},onDidDelete(){}};}}}});
 const context={watchers:[],roots:['/workspace'],config:{trigger:'fileSystem',pattern:'**/*.cs'},engine:{inputVersion:0,directories:[],
  knownFiles:['/workspace/a/x.props','/workspace/b/y.props','/workspace/b/z.props','/linked/c/w.props','/linked/d/v.props']}};
 ui.changeWatcher(context).watch();
 assert.deepEqual(patterns.slice(1).map(pattern=>[pattern.base,pattern.pattern]),[['/workspace','{a/*,b/*}'],['/linked/c','*'],['/linked/d','*']]);
 patterns.length=0;context.engine.inputVersion++;
 context.engine.knownFiles=Array.from({length:65},(_,index)=>`/workspace/d${index}/x.props`);
 ui.changeWatcher(context).watch();
 assert.deepEqual(patterns.map(pattern=>[pattern.base,pattern.pattern]),[['/workspace','**/*']],'only the changed root watcher is recreated');
});

test('disposal aborts runs with a shutdown reason so owned processes skip the graceful phase', async()=>{
 // Partial engine options and private members (any): only what disposal and run touch.
 const engine=/** @type {any} */ (new TestEngine(/** @type {any} */ ({roots:[],storage:'/unused/testy-state',events:{output(){}},configuration:()=>({})})));
 /** @type {any} */ let reason;
 /** @type {PromiseWithResolvers<void>} */ const entered=Promise.withResolvers();
 engine.preparedOutputs={async dispose(){}};
 engine.runBatch=async(/** @type {unknown} */ _batch,/** @type {AbortController} */ controller)=>{
  entered.resolve();
  await new Promise((/** @type {(value?: any) => void} */ resolve)=>controller.signal.addEventListener('abort',()=>{reason=controller.signal.reason;resolve();}));
 };
 const running=engine.run({files:[],full:true},new AbortController().signal);
 await entered.promise;await engine.dispose();await running.catch(()=>undefined);
 assert.ok(reason instanceof Shutdown);
});

function environmentVisible() {
 if (process.platform==='win32') {return false;}
 if (process.platform==='linux') {return true;}
 const probe=spawnSync('sh',['-c','N=TESTY_PROBE; env "$N=1" sleep 1 & sleep 0.2; ps eww -axo pid=,command=; wait']);
 return /TESTY_PROBE=1/.test(String(probe.stdout));
}

test('a shutdown abort kills an owned process without waiting out the graceful phase',{skip:!environmentVisible()&&'process environments are not inspectable here'},async()=>{
 const controller=new AbortController();
 const owned=startProcess('sleep',['30'],{cwd:process.cwd(),signal:controller.signal});
 await sleep(300);
 const began=Date.now();controller.abort(new Shutdown());
 await assert.rejects(owned.done,{name:'AbortError'});
 assert.ok(Date.now()-began<3000);
});

test('deactivate returns promptly even when disposal never finishes',async()=>{
 const vscode={ExtensionMode:{Test:3},workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/workspace'}}]}};
 class Testy{start(){return Promise.resolve();}dispose(){return new Promise(()=>undefined);}}
 const extension=loadUi({vscode,stubs:{controller:{Testy}}}).module('extension');
 extension.activate({subscriptions:[],extensionMode:1});
 const began=Date.now();await extension.deactivate();
 assert.ok(Date.now()-began<4500);
});
