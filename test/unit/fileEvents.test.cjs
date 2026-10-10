const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');
const {normalizePath}=require('../../out/core/paths');

/** A list of known inputs that fails the test if anything scans it linearly. @param {string[]} files */
function guarded(files) {
 /** @type {Record<string, any>} */ // indexed by method name to replace Array methods
 const list=[...files];
 for(const method of ['includes','some','filter','find','indexOf','every','findIndex'])list[method]=()=>{throw new Error(`known inputs scanned with ${method}`);};
 return list;
}

test('bursts of file events never scan the known inputs linearly',async()=>{
 const root=normalizePath('/testy-burst-workspace'),external=normalizePath('/testy-burst-external');
 const projects=Array.from({length:500},(_,i)=>`${root}/proj${i}/Proj${i}.csproj`);
 const files=[...projects,...Array.from({length:20000},(_,i)=>`${root}/proj${i%500}/Dir${i}/File${i}.json`),`${external}/lib/Shared.props`];
 const directories=[...new Set(files.map(file=>file.slice(0,file.lastIndexOf('/'))))];
 const engine={inputVersion:1,knownFiles:guarded(files),directories,markChanged:async()=>{}},/** @type {unknown[][]} */ requests=[];
 const ui=loadUi();
 const context={disposed:false,roots:[root],config:{excludes:[],pattern:'**/*.{csproj,props}'},engine,scheduler:{request:(/** @type {unknown[]} */ ...args)=>requests.push(args)},queueChanged(){}};
 /** @param {string} file */
 const changed=(file,directory=false)=>ui.changeWatcher(context).changed({scheme:'file',fsPath:file},undefined,directory);
 for(const project of projects)await changed(project);
 assert.equal(requests.length,projects.length,'known inputs inside the workspace trigger once per event');
 requests.length=0;
 await changed(`${external}/lib/Shared.props`);await changed(`${external}/lib/Other.props`);await changed(`${external}/unrelated/Other.props`);
 assert.equal(requests.length,2,'known and sibling files of external inputs trigger; unrelated external files do not');
 requests.length=0;
 for(let i=0;i<500;i++)await changed(`${root}/proj${i}`,true);
 assert.equal(requests.length,500);
 const [first,full]=/** @type {[string[], boolean]} */ (/** @type {unknown} */ (requests[7]));
 assert.equal(full,true,'directory events request structural discovery');
 assert.equal(first.length,1+1+40,'a directory event carries its known descendants and itself');
 assert.ok(first.every(/** @param {string} file */ file=>file===`${root}/proj7`||file.startsWith(`${root}/proj7/`)));
});

test('the cached index follows the engine when its inputs change',async()=>{
 const root=normalizePath('/testy-index-workspace'),/** @type {unknown[][]} */ requests=[];
 const engine={inputVersion:1,knownFiles:/** @type {string[]} */ ([]),directories:/** @type {string[]} */ ([]),markChanged:async()=>{}};
 const ui=loadUi();
 const context={disposed:false,roots:[root],config:{excludes:[],pattern:'**/*.cs'},engine,scheduler:{request:(/** @type {unknown[]} */ ...args)=>requests.push(args)},queueChanged(){}};
 const outside={scheme:'file',fsPath:normalizePath('/testy-index-external/Extra.props')};
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,0,'an unknown external file is ignored');
 engine.inputVersion++;engine.knownFiles=[outside.fsPath];engine.directories=[normalizePath('/testy-index-external')];
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,1,'a newly known input is recognized');
 engine.inputVersion++;engine.knownFiles=[];engine.directories=[];
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,1,'a retired input is ignored again');
});

test('input watchers also report files the pattern watcher matches, which may miss inputs under files.watcherExclude, even under an oversized root\'s **/* fallback',async()=>{
 /** @type {{ pattern: any, handlers: Record<string, (uri: any) => void>, dispose(): void, onDidChange(handler: (uri: any) => void): void, onDidCreate(handler: (uri: any) => void): void, onDidDelete(handler: (uri: any) => void): void }[]} */
 const watchers=[];
 const ui=loadUi({vscode:{RelativePattern:class{constructor(/** @type {string} */ base,/** @type {string} */ pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher:(/** @type {any} */ pattern)=>{
  const watcher={pattern,handlers:/** @type {Record<string, (uri: any) => void>} */ ({}),dispose(){},onDidChange(/** @type {(uri: any) => void} */ handler){watcher.handlers.change=handler;},onDidCreate(/** @type {(uri: any) => void} */ handler){watcher.handlers.create=handler;},onDidDelete(/** @type {(uri: any) => void} */ handler){watcher.handlers.delete=handler;}};
  watchers.push(watcher);return watcher;}}}});
 const context={roots:['/workspace'],config:{trigger:'fileSystem',pattern:'**/*.cs'},engine:{inputVersion:0,directories:[],knownFiles:Array.from({length:65},(_,index)=>`/workspace/d${index}/x.props`)}};
 const watcher=ui.changeWatcher(context),/** @type {unknown[][]} */ seen=[];
 watcher.changed=async(/** @type {{ fsPath: string }} */ uri,/** @type {unknown} */ _content,/** @type {boolean} */ directory)=>{seen.push([uri.fsPath,directory]);};
 watcher.watch();
 const [workspace,fallback]=watchers;
 assert.equal(workspace.pattern,'**/*.cs');assert.deepEqual([fallback.pattern.base,fallback.pattern.pattern],['/workspace','**/*']);
 for(const each of [workspace,fallback])each.handlers.change({scheme:'file',fsPath:'/workspace/d1/Code.cs'});
 fallback.handlers.change({scheme:'file',fsPath:'/workspace/d1/x.props'});fallback.handlers.delete({scheme:'file',fsPath:'/workspace/d1'});
 assert.deepEqual(seen,[['/workspace/d1/Code.cs',false],['/workspace/d1/Code.cs',false],['/workspace/d1/x.props',false],['/workspace/d1',true]]);
});
