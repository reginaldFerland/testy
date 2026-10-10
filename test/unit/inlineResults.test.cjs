const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {loadUi}=require('./support/ui.cjs');
const {normalizePath}=require('../../out/core/paths');
const status=require('../../out/ui/inlineStatus');

/** @typedef {import('../../out/ui/inlineStatus').LineStatus} LineStatus */

test('test ids map to their test file, including runtime containers and test ids with colons',()=>{
 assert.equal(status.groupOfTestId('abc123:Ns.Tests.Adds(a: 1)'),'abc123');
 assert.equal(status.groupOfTestId('runtime:def456:Ns.Tests.Row'),'runtime:def456');
 assert.equal(status.groupOfTestId('no-test'),undefined);
});

test('per-file outcome counts follow every outcome change and drop files without outcomes',()=>{
 /** @type {Map<string, import('../../out/ui/inlineStatus').FileOutcome>} */ const files=new Map();
 assert.equal(status.countOutcome(files,'g:a',undefined,'passed'),true);
 assert.equal(status.countOutcome(files,'g:b',undefined,'errored'),true);
 assert.equal(status.countOutcome(files,'g:c',undefined,'skipped'),true);
 assert.deepEqual(files.get('g'),{passed:1,failed:1,total:3});
 assert.equal(status.countOutcome(files,'g:b','errored','errored'),false,'an unchanged outcome is not a change');
 status.countOutcome(files,'g:b','errored','passed');assert.deepEqual(files.get('g'),{passed:2,failed:0,total:3});
 for(const [id,outcome] of [['g:a','passed'],['g:b','passed'],['g:c','skipped']])status.countOutcome(files,id,outcome,undefined);
 assert.equal(files.size,0);
});

test('a test file is failed when any test failed, pending while stale or unverified, and passed otherwise',()=>{
 assert.equal(status.fileStatus({passed:3,failed:1,total:4},true),'failed','a known failure stays visible until rerun');
 assert.equal(status.fileStatus({passed:3,failed:0,total:3},true),'pending');
 assert.equal(status.fileStatus(undefined,false),'pending','no outcome yet');
 assert.equal(status.fileStatus({passed:0,failed:0,total:2},false),'pending','only skipped tests verify nothing');
 assert.equal(status.fileStatus({passed:2,failed:0,total:3},false),'passed');
});

test('a line shows the most important status of its covering files: failed, then pending, then passed',()=>{
 /** @type {Record<string, LineStatus>} */ const files={ok:'passed',old:'pending',bad:'failed'};
 /** @type {string[]} */ const asked=[];
 const of=(/** @type {string} */ id)=>{asked.push(id);return /** @type {LineStatus} */ (files[id]);};
 assert.equal(status.lineStatus(['ok'],of),'passed');
 assert.equal(status.lineStatus(['ok','old'],of),'pending');
 asked.length=0;assert.equal(status.lineStatus(['bad','ok','old'],of),'failed');assert.deepEqual(asked,['bad'],'a failure ends the search');
 assert.equal(status.lineStatus([],of),undefined);
 assert.deepEqual(status.summarizeLine(['ok','old','bad','bad'],of),{files:4,failing:2,pending:1});
 assert.deepEqual(status.orderByStatus(['ok','old','bad'],of),['bad','old','ok']);
 assert.equal(status.inlineGutter('off'),false);assert.equal(status.inlineGutter(undefined),false);
 assert.equal(status.inlineGutter('gutter'),true);assert.equal(status.inlineGutter('gutterAndHover'),true);
});

test('line statuses are 0-based and sorted, drop lines past the end, ask once per file, and turn pending for unsaved documents',()=>{
 const covering=new Map([[9,['b']],[2,['a']],[5,['a','b']],[30,['a']]]);
 /** @type {string[]} */ const asked=[];
 const of=(/** @type {string} */ id)=>{asked.push(id);return /** @type {LineStatus} */ (id==='a'?'passed':'failed');};
 assert.deepEqual(status.lineStatuses(covering,of,{pending:false,lineCount:20}),{passed:[1],failed:[4,8],pending:[]});
 assert.deepEqual(asked.sort(),['a','b'],'each file status is computed once per pass');
 assert.deepEqual(status.lineStatuses(covering,of,{pending:true,lineCount:20}),{passed:[],failed:[],pending:[1,4,8]});
});

/** A fake C# editor and the decorations set on it. */
function fixture({mode='gutterAndHover'}={}) {
 const file=normalizePath('/workspace/Calc.cs');
 /** @type {{status: string, lines: number[]}[]} */ const calls=[];
 /** @type {any[]} */ const providers=[];let hoverDisposals=0;
 const vscode={window:{visibleTextEditors:/** @type {unknown[]} */ ([]),createTextEditorDecorationType:(/** @type {any} */ options)=>({status:path.basename(options.light.gutterIconPath.path,'-light.svg'),options,dispose(){}})},
  Uri:{joinPath:(/** @type {unknown} */ _base,/** @type {string[]} */ ...parts)=>({path:parts.join('/')})},ThemeColor:class{constructor(/** @type {string} */ id){this.id=id;}},OverviewRulerLane:{Left:1},
  Range:class{constructor(/** @type {number} */ startLine,/** @type {number} */ startCharacter,/** @type {number} */ endLine,/** @type {number} */ endCharacter){this.start={line:startLine,character:startCharacter};this.end={line:endLine,character:endCharacter};}},
  languages:{registerHoverProvider:(/** @type {unknown} */ selector,/** @type {unknown} */ provider)=>{providers.push({selector,provider});return{dispose(){hoverDisposals++;}};}},
  MarkdownString:class{constructor(value='',supportThemeIcons=false){this.value=value;this.supportThemeIcons=supportThemeIcons;/** @type {unknown} */ this.isTrusted=undefined;}appendMarkdown(/** @type {string} */ text){this.value+=text;return this;}},
  Hover:class{constructor(/** @type {unknown} */ contents,/** @type {unknown} */ range){this.contents=contents;this.range=range;}}};
 const summary={file,lines:[{line:2,hits:1},{line:3,hits:0},{line:5,hits:2},{line:9,hits:1}],stale:false,covered:3,total:4,groupIds:['a','b']};
 /** @type {any[]} */ let summaries=[summary];
 const traces=new Map([['a',{stale:false}],['b',{stale:false}]]);
 const engine={hashes:new Map(),displayGroups:[{id:'a',project:'/w/T.csproj',framework:'net10.0',file:'/w/CalcTests.cs'},{id:'b',project:'/w/T.csproj',framework:'net10.0',file:'/w/MoreTests.cs'}],
  coverage:{revision:0,traces,summarizeAsync:async()=>summaries}};
 const covering=new Map([[2,['a']],[5,['a','b']],[9,['b']]]);
 const coverage={hidden:false,coveringOf:()=>covering};
 const tree={fileOutcomes:new Map([['a',{passed:2,failed:0,total:2}],['b',{passed:1,failed:1,total:2}]]),outcomeRevision:1,failingTests:()=>[{id:'b:t1',label:'Divides_by_zero'}]};
 const host={disposed:false,config:{inlineResults:mode},lifetime:new AbortController(),reportError(/** @type {unknown} */ error){throw error;}};
 const {InlineResults}=loadUi({vscode}).module('ui/inlineResults');
 const inline=new InlineResults({},engine,coverage,tree,host);
 const document={uri:{scheme:'file',fsPath:'/workspace/Calc.cs',toString:()=>'file:///workspace/Calc.cs'},languageId:'csharp',version:1,lineCount:20,isDirty:false,lineAt:()=>({text:'return a / b;'})};
 const editor={document,setDecorations(/** @type {{status: string}} */ type,/** @type {{start: {line: number}}[]} */ ranges){calls.push({status:type.status,lines:Array.from(ranges,range=>range.start.line)});}};
 const last=()=>Object.fromEntries(['passed','failed','pending'].map(kind=>[kind,calls.filter(call=>call.status===kind).at(-1)?.lines]));
 return{inline,vscode,engine,coverage,tree,host,summary,traces,covering,editor,document,calls,providers,last,hoverDisposals:()=>hoverDisposals,setSummaries:(/** @type {any[]} */ value)=>{summaries=value;}};
}

test('visible C# editors show pass/fail/pending markers, redraw only on change, and clear when hidden',async()=>{
 const f=fixture();
 await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[1],failed:[4,8],pending:[]},'line 5 is covered by a failing file too');
 const count=f.calls.length;
 await f.inline.decorate([f.editor]);await f.inline.decorate([f.editor]);
 assert.equal(f.calls.length,count,'an unchanged editor is not redrawn');
 f.tree.outcomeRevision++;await f.inline.decorate([f.editor]);
 assert.equal(f.calls.length,count,'a new revision with the same markers sends nothing');
 f.tree.fileOutcomes.set('b',{passed:2,failed:0,total:2});f.tree.outcomeRevision++;await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[1,4,8],failed:[],pending:[]});
 f.traces.set('b',{stale:true});f.engine.coverage.revision++;await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[1],failed:[],pending:[4,8]},'a stale covering file is pending');
 Object.assign(f.document,{isDirty:true,version:2});await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[],failed:[],pending:[1,4,8]},'unsaved edits leave nothing verified');
 const typing=f.calls.length;Object.assign(f.document,{version:3});await f.inline.decorate([f.editor]);
 assert.equal(f.calls.length,typing,'keystrokes in a dirty document do not recompute');
 f.coverage.hidden=true;await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[],failed:[],pending:[]},'Clear Coverage hides the markers');
});

test('stale coverage of another file version that no stale test explains marks every covered line pending',async()=>{
 const f=fixture();f.setSummaries([{...f.summary,stale:true}]);
 await f.inline.decorate([f.editor]);
 assert.deepEqual(f.last(),{passed:[],failed:[],pending:[1,4,8]});
});

test('non-C# editors, files without coverage and the off setting draw nothing',async()=>{
 const f=fixture({mode:'off'});
 await f.inline.decorate([f.editor]);assert.equal(f.calls.length,0);
 assert.equal(f.providers.length,0,'no hover provider while inline results are off');
 const g=fixture();Object.assign(g.document,{languageId:'plaintext'});await g.inline.decorate([g.editor]);assert.equal(g.calls.length,0);
 const h=fixture();h.setSummaries([]);await h.inline.decorate([h.editor]);assert.equal(h.calls.length,0);
});

test('the hover lists covering files, failures first, with only the run and show commands trusted',async()=>{
 const f=fixture();
 assert.equal(f.providers.length,1);assert.deepEqual({...f.providers[0].selector},{scheme:'file',language:'csharp'});
 const hover=await f.inline.provideHover(f.document,{line:4,character:3});
 const markdown=hover.contents;
 assert.deepEqual(JSON.parse(JSON.stringify(markdown.isTrusted)),{enabledCommands:['testy.runCoveringTests','testy.showTest']});assert.equal(markdown.supportThemeIcons,true);
 assert.match(markdown.value,/^\*\*Testy\*\* · Covered by 2 test files \\\(1 failing\\\)/,'Markdown characters in the text are escaped');
 assert.ok(markdown.value.indexOf('MoreTests')<markdown.value.indexOf('CalcTests'),'the failing file is listed first');
 assert.match(markdown.value,/Divides\\_by\\_zero\]\(command:testy\.showTest\?/);
 assert.ok(markdown.value.includes(`command:testy.runCoveringTests?${encodeURIComponent(JSON.stringify(['file:///workspace/Calc.cs',5]))}`));
 assert.ok(markdown.value.includes(`command:testy.showTest?${encodeURIComponent(JSON.stringify(['file:a']))}`));
 assert.equal(await f.inline.provideHover(f.document,{line:2,character:0}),undefined,'an uncovered line has no hover');
 f.host.config.inlineResults='gutter';f.inline.refresh();
 assert.equal(f.hoverDisposals(),1,'switching to gutter-only removes the hover provider');
 assert.equal(await f.inline.provideHover(f.document,{line:4,character:3}),undefined);
});

test('the hover caps the file list at ten and counts the rest',async()=>{
 const f=fixture();
 const ids=Array.from({length:13},(_,index)=>`g${index}`);
 f.covering.set(5,ids);for(const id of ids){f.tree.fileOutcomes.set(id,{passed:1,failed:0,total:1});f.traces.set(id,{stale:false});}
 const hover=await f.inline.provideHover(f.document,{line:4,character:0});
 assert.match(hover.contents.value,/Covered by 13 test files/);
 assert.equal((hover.contents.value.match(/^- \$\(pass\)/gm)??[]).length,10);
 assert.match(hover.contents.value,/\\\+3 more/);
});

test('inline result icons have light and dark variants with a distinct shape per status',async()=>{
 const f=fixture();await f.inline.decorate([f.editor]);
 const shapes=new Set();
 for(const kind of ['passed','failed','pending']){
  const [light,dark]=await Promise.all(['light','dark'].map(theme=>fs.readFile(path.join(__dirname,'../../media',`${kind}-${theme}.svg`),'utf8')));
  const shape=(/** @type {string} */ svg)=>svg.replace(/#[0-9a-f]{6}/gi,'COLOR');
  assert.equal(shape(light),shape(dark));assert.notEqual(light,dark);shapes.add(shape(light));
 }
 assert.equal(shapes.size,3);
});

test('Run Tests Covering This Line takes a hover link\'s URI and line, or the cursor; Show Test reveals the item',async()=>{
 const {createTesty}=require('./support/controller.cjs');
 /** @type {Map<string, (...args: unknown[]) => unknown>} */ const registered=new Map();
 const f=createTesty({api:{Uri:{joinPath:()=>({}),parse:(/** @type {string} */ value)=>({scheme:'file',fsPath:value.replace('file://','')})}}});
 /** @type {unknown[][]} */ const executed=[];
 f.vscode.commands.executeCommand=async(/** @type {unknown[]} */ ...args)=>{executed.push(args);};
 /** @type {[string, number][]} */ const asked=[];
 f.testy.coverage.covering=(/** @type {string} */ file,/** @type {number} */ line)=>{asked.push([file,line]);return ['g1'];};
 /** @type {any[]} */ const manual=[];
 f.testy.scheduler.runManual=async(/** @type {(signal: AbortSignal) => unknown} */ work)=>{manual.push(work);};
 f.vscode.commands.registerCommand=(/** @type {string} */ id,/** @type {(...args: unknown[]) => unknown} */ handler)=>{registered.set(id,handler);return{dispose(){}};};
 f.ui.module('commands').registerCommands({runCoveringTests:(/** @type {unknown} */ target)=>f.testy.runCoveringTests(target),showTest:(/** @type {string} */ id)=>f.testy.showTest(id)});
 await registered.get('testy.runCoveringTests')?.('file:///workspace/Calc.cs',5);
 assert.deepEqual(asked,[[normalizePath('/workspace/Calc.cs'),5]]);assert.equal(manual.length,1);
 f.vscode.window.activeTextEditor={document:{uri:{scheme:'file',fsPath:'/workspace/Other.cs'}},selection:{active:{line:2}}};
 await registered.get('testy.runCoveringTests')?.({scheme:'file',fsPath:'/workspace/Ignored.cs'},{groupId:1});
 assert.deepEqual(asked[1],[normalizePath('/workspace/Other.cs'),3],'the editor context menu\'s URI without a line uses the cursor');
 const item={id:'file:g1'};f.testy.tree.items.set('file:g1',item);
 await registered.get('testy.showTest')?.('file:g1');await registered.get('testy.showTest')?.('file:unknown');await registered.get('testy.showTest')?.(42);
 assert.deepEqual(executed,[['vscode.revealTestInExplorer',item]]);
 await f.testy.dispose();
});
