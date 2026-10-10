const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {BackgroundSweep}=require('../../out/core/backgroundSweep');
const {SourceTracker}=require('../../out/services/sources');
const {Scheduler}=require('../../out/core/scheduler');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');
const {createTesty}=require('./support/controller.cjs');

/** @param {import('node:test').TestContext} t @param {...string} names */
async function files(t,...names){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-sweep-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const paths=names.map(name=>normalizePath(path.join(root,name)));
 for(const file of paths){await fs.writeFile(file,'one');}
 return paths;
}
/** Changes the file's size, so the stamp differs even on coarse timestamp filesystems. */
const edit=(/** @type {string} */ file)=>fs.writeFile(file,'changed content');

test('a sweep that is stopped before applying anything leaves the change for the next refresh',async t=>{
 const [a]=await files(t,'a.json'),sources=new SourceTracker();
 sources.setFiles([a]);await sources.refresh(sources.files);const before=sources.hashes.get(a);
 await edit(a);
 const controller=new AbortController();controller.abort();
 await assert.rejects(sources.sweep(controller.signal));
 assert.equal(sources.hashes.get(a),before,'nothing was applied');
 assert.deepEqual(await sources.sweep(new AbortController().signal),[a]);
});

test('changes a sweep applied are delivered even when a run stops it late, and a run of only those does not sweep again',async t=>{
 /** @type {string[][]} */ const delivered=[];let release=()=>{};
 const sweep=new BackgroundSweep({sweep:async()=>{await new Promise(resolve=>{release=()=>resolve(undefined);});return ['/w/a.json'];},
  changed:async files=>{delivered.push([...files]);},error:error=>{throw error;}});
 sweep.start();
 assert.equal(sweep.runStarting(['/w/other.cs']),false,'a run starting stops the sweep');
 release();await sweep.idle;
 assert.deepEqual(delivered,[['/w/a.json']],'its applied changes are still requested');
 assert.equal(sweep.runStarting(['/w/a.json']),true,'the follow-up run holds only sweep findings');
 assert.equal(sweep.runStarting(['/w/a.json']),false,'once');
 sweep.dispose();
});

test('in fileSystem mode, a change made without any watcher event is picked up by a follow-up run after an incremental run',async t=>{
 const [a,b]=await files(t,'a.json','b.json');
 const f=/** @type {any} */ (createTesty({configuration:{trigger:'fileSystem',debounce:0}}));
 const batches=/** @type {string[][]} */ ([]);
 // Like the engine in fileSystem mode, a run refreshes only the files it was given.
 f.testy.engine.run=async(/** @type {{files: string[]}} */ batch)=>{batches.push([...batch.files]);await f.testy.engine.sources.refresh(batch.files);return {files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};};
 f.testy.engine.sources.setFiles([a,b]);await f.testy.engine.sources.refresh([a,b]);
 f.testy.scheduler.setPaused(false);
 await edit(a);await edit(b); // Only a's event arrives.
 f.testy.scheduler.request([a]);
 for(let attempt=0;attempt<200&&batches.length<2;attempt++){await delay(10);}
 await f.testy.sweep.idle;await delay(30);
 assert.deepEqual(batches,[[a],[b]],'the background sweep requested the unreported change');
 assert.ok(f.output.some((/** @type {string} */ line)=>line.includes('without a file event')));
 await f.testy.dispose();
});

test('in save mode, runs already check every input, so no background sweep runs',async t=>{
 const [a]=await files(t,'a.json');
 const f=/** @type {any} */ (createTesty({configuration:{trigger:'save',debounce:0}}));
 const batches=/** @type {string[][]} */ ([]);
 f.testy.engine.run=async(/** @type {{files: string[]}} */ batch)=>{batches.push([...batch.files]);return {files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:true};};
 f.testy.engine.sources.setFiles([a]);await f.testy.engine.sources.refresh([a]);
 let swept=0;const sweep=f.testy.engine.sources.sweep.bind(f.testy.engine.sources);f.testy.engine.sources.sweep=(/** @type {AbortSignal} */ signal)=>{swept++;return sweep(signal);};
 f.testy.scheduler.setPaused(false);f.testy.scheduler.request([a]);
 for(let attempt=0;attempt<100&&!batches.length;attempt++){await delay(10);}
 await delay(30);
 assert.equal(batches.length,1);assert.equal(swept,0);
 await f.testy.dispose();
});

test('one change reported by overlapping watchers causes one run',async()=>{
 const watchers=/** @type {any[]} */ ([]);
 const ui=loadUi({vscode:{RelativePattern:class{constructor(/** @type {string} */ base,/** @type {string} */ pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher:(/** @type {unknown} */ pattern)=>{
  const watcher={pattern,handlers:/** @type {Record<string, (uri: unknown) => void>} */ ({}),dispose(){},onDidChange(/** @type {(uri: unknown) => void} */ handler){watcher.handlers.change=handler;},onDidCreate(/** @type {(uri: unknown) => void} */ handler){watcher.handlers.create=handler;},onDidDelete(/** @type {(uri: unknown) => void} */ handler){watcher.handlers.delete=handler;}};
  watchers.push(watcher);return watcher;}}}});
 // The input watcher for App/ (an evaluated import the pattern misses) also reports App/settings.json, which the pattern matches.
 const root=normalizePath(path.resolve('/workspace')),imported=normalizePath(path.join(root,'App','Common.msbuild')),input=normalizePath(path.join(root,'App','settings.json'));
 /** @type {(() => void)[]} */ const timers=[];const runs=/** @type {string[][]} */ ([]);
 const scheduler=new Scheduler({debounce:0,schedule:(callback)=>{timers.push(callback);return ()=>{};},run:async batch=>{runs.push([...batch.files]);}});
 scheduler.setPaused(false);
 const marked=/** @type {string[][]} */ ([]);
 const context={disposed:false,roots:[root],config:{trigger:'fileSystem',excludes:[],pattern:'**/*.json'},scheduler,reportError:(/** @type {unknown} */ error)=>{throw error;},
  engine:{inputVersion:1,knownFiles:[imported,input],directories:[path.dirname(input)],markChanged:async(/** @type {string[]} */ files)=>{marked.push(files);}},queueChanged(){}};
 const watcher=ui.changeWatcher(context);watcher.watch();
 assert.equal(watchers.length,2,'a pattern watcher and an input watcher both cover the input');
 const uri={scheme:'file',fsPath:input};
 for(const each of watchers){each.handlers.change(uri);}
 await delay(20);
 for(const callback of timers.splice(0)){callback();}
 await delay(10);
 assert.deepEqual(runs,[[input]],'the duplicate event joined the first, and the scheduler ran once');
 // A duplicate arriving after the first was handled, within the debounce, coalesces in the scheduler's pending set.
 watchers[0].handlers.change(uri);await delay(10);watchers[1].handlers.change(uri);await delay(10);
 for(const callback of timers.splice(0)){callback();}
 await delay(10);
 assert.deepEqual(runs,[[input],[input]]);
 scheduler.dispose();watcher.dispose();
});
