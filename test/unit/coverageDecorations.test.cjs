const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {normalizePath}=require('../../out/core/paths');

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function fixture(){
 const calls=[],metrics={ranges:0,reads:0,indexes:0},file=normalizePath('/workspace/Coverage.cs');
 let summaries=[],read;
 const vscode={window:{visibleTextEditors:[]},Uri:{file:fsPath=>({fsPath})},
  FileCoverage:class{constructor(uri,statementCoverage){Object.assign(this,{uri,statementCoverage});}},
  Range:class{constructor(startLine,startCharacter,endLine,endCharacter){metrics.ranges++;this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};}}};
 const filename=path.resolve('out/extension.js'),realRequire=createRequire(filename),exports={};
 vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nexports.Testy=Testy;',{
  exports,require:name=>name==='vscode'?vscode:name==='./configuration'?{}:realRequire(name),Buffer,setTimeout,clearTimeout
 });
 const proto=exports.Testy.prototype,context={config:{showCoverage:true},engine:{hashes:new Map(),coverage:{
  async summarizeAsync(hashes,signal){metrics.reads++;signal?.throwIfAborted();return read?read(hashes,signal):summaries;},summarize:()=>summaries}},
  decorations:{covered:'covered',uncovered:'uncovered',stale:'stale'},lifetime:new AbortController(),pendingEditors:new Set(),rendering:false,
  productionSources:new Set([file]),publishedCoverage:new Map(),details:new WeakMap(),updateStatus(){},reportError(error){throw error;}};
 context.decorate=editors=>proto.decorate.call(context,editors);context.queueDecorations=editors=>proto.queueDecorations.call(context,editors);
 context.renderDecorations=()=>proto.renderDecorations.call(context);
 const summary=(lines=[{line:1,hits:2},{line:2,hits:0},{line:5,hits:3}],overrides={})=>Object.freeze({file,lines:Object.freeze(lines.map(line=>Object.freeze({...line}))),
  stale:false,total:lines.length,covered:lines.filter(line=>line.hits>0).length,groupIds:['owner'],...overrides});
 const set=values=>{summaries=new Proxy(Object.freeze([...values]),{get(target,key,receiver){if(key==='map')metrics.indexes++;return Reflect.get(target,key,receiver);}});return summaries;};
 const editor=(document={uri:{fsPath:file},version:1,lineCount:8,isDirty:false})=>{
  const value={document,setDecorations(kind,entries){calls.push({editor:value,kind,lines:Array.from(entries,entry=>entry.range.start.line),hovers:Array.from(entries,entry=>entry.hoverMessage)});}};
  return value;
 };
 const render=(...editors)=>context.decorate(editors),last=editor=>Object.fromEntries(['covered','uncovered','stale'].map(kind=>[kind,calls.filter(call=>call.editor===editor&&call.kind===kind).at(-1)?.lines]));
 return{proto,context,metrics,calls,file,vscode,summary,set,editor,render,last,read:callback=>{read=callback;}};
}

test('unchanged coverage reuses editor decorations without allocating ranges or rebuilding the summary index',async()=>{
 const f=fixture(),summary=f.summary(),editor=f.editor();f.set([summary]);await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[0,4],uncovered:[1],stale:[]});const ranges=f.metrics.ranges,indexes=f.metrics.indexes;
 for(let count=0;count<10;count++)await f.render(editor);
 assert.equal(f.calls.length,3);assert.equal(f.metrics.ranges,ranges);assert.equal(f.metrics.indexes,indexes);
 f.set([{...summary,groupIds:['another owner']}]);await f.render(editor);
 assert.equal(f.calls.length,3,'ownership/summary-object replacement alone does not alter gutters');
 assert.equal(f.metrics.ranges,ranges);
});

test('changed hits and geometry replace decorations; missing coverage clears them once',async()=>{
 const f=fixture(),editor=f.editor();f.set([f.summary()]);await f.render(editor);
 f.set([f.summary([{line:1,hits:0},{line:3,hits:1}])]);await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[2],uncovered:[0],stale:[]});
 f.set([]);await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[]});
 await f.render(editor);assert.equal(f.calls.length,9);
 f.set([f.summary([{line:8,hits:1}])]);await f.render(editor);assert.deepEqual(f.last(editor),{covered:[7],uncovered:[],stale:[]});
});

test('stale changes invalidate retained line identities in both directions',async()=>{
 const f=fixture(),editor=f.editor(),fresh=f.summary();f.set([fresh]);await f.render(editor);
 f.set([{...fresh,stale:true}]);await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1,4]});
 assert.ok(f.calls.at(-1).hovers.every(message=>message.includes('out of date')));
 await f.render(editor);assert.equal(f.calls.length,6);
 f.set([fresh]);await f.render(editor);assert.deepEqual(f.last(editor),{covered:[0,4],uncovered:[1],stale:[]});
});

test('document version, dirty state and line count force fresh submissions even for retained coverage',async()=>{
 const f=fixture(),editor=f.editor();f.set([f.summary()]);await f.render(editor);
 editor.document.version++;await f.render(editor);assert.equal(f.calls.length,6,'edits can move VS Code decorations even when their payload will match');
 editor.document.isDirty=true;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1,4]});
 editor.document.lineCount=2;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1]});
 editor.document.isDirty=false;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[0],uncovered:[1],stale:[]});
 assert.equal(f.calls.length,15);await f.render(editor);assert.equal(f.calls.length,15);
});

test('each split or reopened editor and each replaced document gets its own first submission',async()=>{
 const f=fixture(),first=f.editor(),split=f.editor(first.document);f.set([f.summary()]);await f.render(first,split);
 assert.equal(f.calls.length,6);await f.render(first,split);assert.equal(f.calls.length,6);
 const reopened=f.editor(first.document);await f.render(reopened);assert.equal(f.calls.length,9);
 first.document={...first.document,uri:{...first.document.uri}};await f.render(first);assert.equal(f.calls.length,12,'same URI/version with a new TextDocument is not the same editor state');
 first.document={uri:{fsPath:normalizePath('/workspace/NoCoverage.cs')},version:1,lineCount:8,isDirty:false};await f.render(first);
 assert.deepEqual(f.last(first),{covered:[],uncovered:[],stale:[]});
});

test('hidden coverage clears every editor once and restores the current summary when shown',async()=>{
 const f=fixture(),editor=f.editor();f.set([f.summary()]);await f.render(editor);
 f.context.config.showCoverage=false;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[]});
 f.set([f.summary([{line:3,hits:0}])]);await f.render(editor);assert.equal(f.calls.length,6,'hidden changes do not repeatedly clear the editor');
 f.context.config.showCoverage=true;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[2],stale:[]});
});

test('a failed partial submission cannot make its previous cached state appear current',async()=>{
 const f=fixture(),editor=f.editor(),fresh=f.summary();f.set([fresh]);await f.render(editor);
 const submit=editor.setDecorations;let fail=true;
 editor.setDecorations=(kind,entries)=>{if(fail&&kind==='uncovered')throw new Error('controlled editor rejection');submit(kind,entries);};
 f.set([{...fresh,stale:true}]);await assert.rejects(f.render(editor),/controlled editor rejection/);
 assert.deepEqual(f.last(editor).covered,[],'first category was already replaced before the error');
 fail=false;f.set([fresh]);await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[0,4],uncovered:[1],stale:[]},'returning to the pre-error state still repairs the partial write');
 const calls=f.calls.length;await f.render(editor);assert.equal(f.calls.length,calls);
});

test('hash changes during asynchronous summary preparation retry before caching or submitting',async()=>{
 const f=fixture(),editor=f.editor(),old=f.summary(),fresh=f.summary([{line:3,hits:1}]),gate=deferred(),started=deferred();
 const firstHashes=f.context.engine.hashes;let reads=0;
 f.read(async hashes=>{if(++reads===1){assert.equal(hashes,firstHashes);started.resolve();await gate.promise;return[old];}return[fresh];});
 const pending=f.render(editor);await started.promise;f.context.engine.hashes=new Map([['new','hash']]);gate.resolve();await pending;
 assert.equal(reads,2);assert.equal(f.calls.length,3);assert.deepEqual(f.last(editor),{covered:[2],uncovered:[],stale:[]});
 await f.render(editor);assert.equal(f.calls.length,3);
});

test('document and visibility changes while awaiting summaries are captured after the await',async()=>{
 const f=fixture(),editor=f.editor(),gate=deferred(),started=deferred(),summary=f.summary();f.set([summary]);await f.render(editor);
 f.read(async()=>{started.resolve();await gate.promise;return[summary];});
 const pending=f.render(editor);await started.promise;editor.document.version++;editor.document.isDirty=true;f.context.config.showCoverage=false;gate.resolve();await pending;
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[]});
 f.context.config.showCoverage=true;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1,4]});
});

test('pending render requests repair a summary replaced during an earlier render',async()=>{
 const f=fixture(),editor=f.editor(),gate=deferred(),started=deferred(),old=f.summary(),fresh=f.summary([{line:7,hits:1}]);let reads=0;
 f.read(async()=>{if(++reads===1){started.resolve();await gate.promise;return[old];}return[fresh];});
 f.context.pendingEditors.add(editor);const pending=f.context.renderDecorations();await started.promise;
 f.context.queueDecorations([editor]);gate.resolve();await pending;
 assert.equal(reads,2);assert.deepEqual(f.last(editor),{covered:[6],uncovered:[],stale:[]});assert.equal(f.context.pendingEditors.size,0);
 await f.render(editor);assert.equal(f.calls.length,6,'the latest summary is now cached');
});

for(const abort of [false,true])test(`disposal during an awaited render prevents late submissions${abort?' and propagates cancellation':''}`,async()=>{
 const f=fixture(),editor=f.editor(),started=deferred(),gate=deferred(),summary=f.summary();
 f.read(async(_hashes,signal)=>{started.resolve();await gate.promise;if(abort)signal.throwIfAborted();return[summary];});
 const pending=f.render(editor),observed=abort?assert.rejects(pending,{name:'AbortError'}):pending;
 await started.promise;f.context.disposed=true;if(abort)f.context.lifetime.abort();gate.resolve();await observed;
 assert.equal(f.calls.length,0);assert.equal(f.context.decoratedEditors,undefined,'cancelled work publishes no cache entry');
});

test('each new TestRun still receives FileCoverage even when editor decorations are unchanged',async()=>{
 const f=fixture(),editor=f.editor(),summary=f.summary(),first=[],second=[];f.set([summary]);await f.render(editor);
 f.context.queueDecorations=()=>{};f.context.activeRun={addCoverage:coverage=>first.push(coverage)};
 f.proto.publishCoverage.call(f.context);f.proto.publishCoverage.call(f.context);assert.equal(first.length,1);
 f.context.publishedCoverage.clear();f.context.activeRun={addCoverage:coverage=>second.push(coverage)};
 f.proto.publishCoverage.call(f.context);assert.equal(second.length,1);assert.notEqual(first[0],second[0]);
 assert.equal(f.context.details.get(second[0]),summary);await f.render(editor);assert.equal(f.calls.length,3);
});
