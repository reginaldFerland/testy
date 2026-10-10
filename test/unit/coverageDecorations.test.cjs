const test=require('node:test'),assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');
const {normalizePath}=require('../../out/core/paths');

/** @returns {{promise: Promise<unknown>, resolve: (value?: unknown) => void}} */
function deferred(){
 /** @type {any} */ let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};
}
/** @typedef {{uri: {fsPath: string}, version: number, lineCount: number, isDirty: boolean}} FakeDocument */
/** @typedef {{document: FakeDocument, setDecorations: (kind: string, entries: {range: {start: {line: number}}, hoverMessage: string}[]) => void}} FakeEditor */
/** @typedef {(hashes: unknown, signal: AbortSignal) => Promise<any[]>} SummaryReader */
function fixture(){
 /** @type {{editor: FakeEditor, kind: string, lines: number[], hovers: string[]}[]} */ const calls=[];
 const metrics={ranges:0,reads:0,indexes:0},file=normalizePath('/workspace/Coverage.cs');
 /** @type {readonly any[]} */ let summaries=[];
 /** @type {SummaryReader | undefined} */ let read;
 /** @type {(file: string, ids: Set<string>, hashes: unknown) => any} */ let contribution=()=>undefined;
 /** @type {{id: string, file: string, project: string}[]} */ const displayGroups=[];
 const vscode={l10n:{t:(/** @type {string} */ message,/** @type {unknown[]} */ ...args)=>message.replace(/\{(\d+)\}/g,(/** @type {string} */ _,/** @type {number} */ index)=>String(args[index]))},window:{visibleTextEditors:[]},Uri:{file:(/** @type {string} */ fsPath)=>({fsPath})},
  FileCoverage:class{constructor(/** @type {unknown} */ uri,/** @type {unknown} */ statementCoverage){Object.assign(this,{uri,statementCoverage});}},
  Range:class{constructor(/** @type {number} */ startLine,/** @type {number} */ startCharacter,/** @type {number} */ endLine,/** @type {number} */ endCharacter){metrics.ranges++;this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};}}};
 /** @type {{disposed: boolean, activeRun: any, config: {showCoverage: boolean}, lifetime: AbortController, updateStatus(): void, reportError(error: unknown): never}} */
 const host={disposed:false,activeRun:undefined,config:{showCoverage:true},lifetime:new AbortController(),updateStatus(){},reportError(error){throw error;}};
 const proto=loadUi({vscode}).CoverageView.prototype;
 // Partial mock of CoverageView state: the real private fields are supplied piecemeal and extra delegating methods are attached below.
 /** @type {any} */ const context={host,engine:{hashes:new Map(),coverage:{
  async summarizeAsync(/** @type {unknown} */ hashes,/** @type {AbortSignal} */ signal){metrics.reads++;signal?.throwIfAborted();return read?read(hashes,signal):summaries;},summarize:()=>summaries,summary:(/** @type {string} */ f)=>summaries.find(x=>x.file===f),contribution:(/** @type {string} */ f,/** @type {Set<string>} */ ids,/** @type {unknown} */ h)=>contribution(f,ids,h)},displayGroups},coveringLines:new WeakMap(),drawn:false,
  decorations:{covered:'covered',uncovered:'uncovered',stale:'stale'},pendingEditors:new Set(),rendering:false,
  productionSources:new Set([file]),owners:new Map(),items:new Map(),publishedCoverage:new Map(),details:new WeakMap()};
 context.decorate=(/** @type {FakeEditor[]} */ editors)=>proto.decorate.call(context,editors);context.queue=(/** @type {FakeEditor[]} */ editors)=>proto.queue.call(context,editors);
 context.render=()=>proto.render.call(context);
 context.coveringOf=(/** @type {unknown} */ value)=>proto.coveringOf.call(context,value);context.coveringText=(/** @type {unknown} */ ids)=>proto.coveringText.call(context,ids);
 const summary=(/** @type {{line: number, hits: number}[]} */ lines=[{line:1,hits:2},{line:2,hits:0},{line:5,hits:3}],/** @type {Record<string, unknown>} */ overrides={})=>Object.freeze({file,lines:Object.freeze(lines.map(line=>Object.freeze({...line}))),
  stale:false,total:lines.length,covered:lines.filter(line=>line.hits>0).length,groupIds:['owner'],...overrides});
 const set=(/** @type {readonly unknown[]} */ values)=>{summaries=new Proxy(Object.freeze([...values]),{get(target,key,receiver){if(key==='map')metrics.indexes++;return Reflect.get(target,key,receiver);}});return summaries;};
 const editor=(/** @type {FakeDocument} */ document={uri:{fsPath:file},version:1,lineCount:8,isDirty:false})=>{
  /** @type {FakeEditor} */ const value={document,setDecorations(kind,entries){calls.push({editor:value,kind,lines:Array.from(entries,entry=>entry.range.start.line),hovers:Array.from(entries,entry=>entry.hoverMessage)});}};
  return value;
 };
 const render=(/** @type {FakeEditor[]} */ ...editors)=>context.decorate(editors),last=(/** @type {FakeEditor} */ editor)=>Object.fromEntries(['covered','uncovered','stale'].map(kind=>[kind,calls.filter(call=>call.editor===editor&&call.kind===kind).at(-1)?.lines]));
 return{displayGroups,setContribution:(/** @type {typeof contribution} */ value)=>{contribution=value;},proto,context,host,metrics,calls,file,vscode,summary,set,editor,render,last,read:(/** @type {SummaryReader} */ callback)=>{read=callback;}};
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
 assert.ok(/** @type {NonNullable<ReturnType<typeof f.calls.at>>} */ (f.calls.at(-1)).hovers.every(message=>message.includes('out of date')));
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
 f.host.config.showCoverage=false;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[]});
 f.set([f.summary([{line:3,hits:0}])]);await f.render(editor);assert.equal(f.calls.length,6,'hidden changes do not repeatedly clear the editor');
 f.host.config.showCoverage=true;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[2],stale:[]});
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
 f.read(async(/** @type {unknown} */ hashes)=>{if(++reads===1){assert.equal(hashes,firstHashes);started.resolve();await gate.promise;return[old];}return[fresh];});
 const pending=f.render(editor);await started.promise;f.context.engine.hashes=new Map([['new','hash']]);gate.resolve();await pending;
 assert.equal(reads,2);assert.equal(f.calls.length,3);assert.deepEqual(f.last(editor),{covered:[2],uncovered:[],stale:[]});
 await f.render(editor);assert.equal(f.calls.length,3);
});

test('document and visibility changes while awaiting summaries are captured after the await',async()=>{
 const f=fixture(),editor=f.editor(),gate=deferred(),started=deferred(),summary=f.summary();f.set([summary]);await f.render(editor);
 f.read(async()=>{started.resolve();await gate.promise;return[summary];});
 const pending=f.render(editor);await started.promise;editor.document.version++;editor.document.isDirty=true;f.host.config.showCoverage=false;gate.resolve();await pending;
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[]});
 f.host.config.showCoverage=true;await f.render(editor);assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1,4]});
});

test('pending render requests repair a summary replaced during an earlier render',async()=>{
 const f=fixture(),editor=f.editor(),gate=deferred(),started=deferred(),old=f.summary(),fresh=f.summary([{line:7,hits:1}]);let reads=0;
 f.read(async()=>{if(++reads===1){started.resolve();await gate.promise;return[old];}return[fresh];});
 f.context.pendingEditors.add(editor);const pending=f.context.render();await started.promise;
 f.context.queue([editor]);gate.resolve();await pending;
 assert.equal(reads,2);assert.deepEqual(f.last(editor),{covered:[6],uncovered:[],stale:[]});assert.equal(f.context.pendingEditors.size,0);
 await f.render(editor);assert.equal(f.calls.length,6,'the latest summary is now cached');
});

for(const abort of [false,true])test(`disposal during an awaited render prevents late submissions${abort?' and propagates cancellation':''}`,async()=>{
 const f=fixture(),editor=f.editor(),started=deferred(),gate=deferred(),summary=f.summary();
 f.read(async(/** @type {unknown} */ _hashes,/** @type {AbortSignal} */ signal)=>{started.resolve();await gate.promise;if(abort)signal.throwIfAborted();return[summary];});
 const pending=f.render(editor),observed=abort?assert.rejects(pending,{name:'AbortError'}):pending;
 await started.promise;f.host.disposed=true;if(abort)f.host.lifetime.abort();gate.resolve();await observed;
 assert.equal(f.calls.length,0);assert.equal(f.context.decoratedEditors,undefined,'cancelled work publishes no cache entry');
});

test('each new TestRun still receives FileCoverage even when editor decorations are unchanged',async()=>{
 const f=fixture(),editor=f.editor(),summary=f.summary();
 /** @type {unknown[]} */ const first=[];
 /** @type {unknown[]} */ const second=[];
 f.set([summary]);await f.render(editor);
 f.context.queue=()=>{};f.host.activeRun={addCoverage:(/** @type {unknown} */ coverage)=>first.push(coverage)};
 f.proto.publish.call(f.context);f.proto.publish.call(f.context);assert.equal(first.length,1);
 f.context.publishedCoverage.clear();f.host.activeRun={addCoverage:(/** @type {unknown} */ coverage)=>second.push(coverage)};
 f.proto.publish.call(f.context);assert.equal(second.length,1);assert.notEqual(first[0],second[0]);
 assert.equal(f.context.details.get(second[0]),summary);await f.render(editor);assert.equal(f.calls.length,3);
});

test('the covered hover names the covering test files, capped at ten',async()=>{
 const f=fixture(),editor=f.editor();
 for(let i=0;i<12;i++)f.displayGroups.push({id:`g${i}`,file:`/w/T${i}.cs`,project:'/w/P.csproj'});
 f.setContribution((/** @type {string} */ _file,/** @type {Set<string>} */ ids)=>[{line:1,hits:ids.has('g0')||ids.has('g11')?1:0},{line:2,hits:0},{line:5,hits:1}]);
 f.set([f.summary(undefined,{groupIds:[...f.displayGroups.map(g=>g.id),'project:x']})]);await f.render(editor);
 const hovers=/** @type {NonNullable<ReturnType<typeof f.calls.at>>} */ (f.calls.filter(call=>call.kind==='covered').at(-1)).hovers;
 assert.equal(hovers[0],'Testy: covered by T0.cs, T11.cs.');
 assert.equal(hovers[1],'Testy: covered by T0.cs, T1.cs, T2.cs, T3.cs, T4.cs, T5.cs, T6.cs, T7.cs, T8.cs, T9.cs and 2 more.');
 assert.deepEqual([...f.context.coveringOf(f.context.engine.coverage.summary(f.file)).get(1)],['g0','g11']);
});

test('while coverage is hidden and nothing is drawn, edits neither queue nor resubmit decorations',async()=>{
 const f=fixture(),editor=f.editor();f.set([f.summary()]);f.host.config.showCoverage=false;f.context.hidden=false;
 f.context.queue([editor]);assert.equal(f.context.pendingEditors.size,0);assert.equal(f.context.renderTimer,undefined);
 await f.render(editor);const calls=f.calls.length;editor.document.version++;await f.render(editor);editor.document.version++;await f.render(editor);
 assert.equal(calls,3);assert.equal(f.calls.length,3,'hidden edits do not clear again');
 f.host.config.showCoverage=true;await f.render(editor);assert.equal(f.context.drawn,true);
 f.host.config.showCoverage=false;f.context.queue([editor]);assert.equal(f.context.pendingEditors.size,1,'a drawn editor is still cleared');
 clearTimeout(f.context.renderTimer);await f.render(editor);assert.equal(f.context.drawn,false);
});

test('with inline results on, coverage markers leave covered lines to them and keep uncovered and stale ones',async()=>{
 const f=fixture(),editor=f.editor();f.set([f.summary()]);
 /** @type {any} Partial configuration: only the settings decorate reads. */ const config=f.host.config;
 config.inlineResults='gutter';await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[1],stale:[]});
 f.set([f.summary(undefined,{stale:true})]);await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[1]},'stale covered lines show their pending inline marker instead');
 config.inlineResults='off';await f.render(editor);
 assert.deepEqual(f.last(editor),{covered:[],uncovered:[],stale:[0,1,4]},'turning inline results off redraws every line');
});
