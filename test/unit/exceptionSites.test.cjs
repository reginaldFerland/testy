const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ExceptionSites,exceptionSites}=require('../../out/core/exceptionSites');
const {parseStackTrace}=require('../../out/core/stackTrace');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');

const calc=normalizePath('/workspace/App/Calc.cs'),tests=normalizePath('/workspace/Tests/CalcTests.cs');
const stack=[
 '   at App.Calc.Divide(Int32 a, Int32 b) in /workspace/App/Calc.cs:line 12',
 '   at App.Calc.Average(Int32[] values) in /workspace/App/Calc.cs:line 20',
 '   at App.Calc.Average(Int32[] values) in /workspace/App/Calc.cs:line 20',
 '   at Tests.CalcTests.Averages_empty() in /workspace/Tests/CalcTests.cs:line 8',
 '   at System.RuntimeMethodHandle.InvokeMethod(Object target)',
 '   at Lib.Helper.Run() in /elsewhere/Helper.cs:line 3'
].join('\n');
const resolve=(/** @type {string} */ file)=>file.startsWith('/workspace/')?normalizePath(file):undefined;

test('exception sites are the workspace frames of a failure, innermost first, once per line',()=>{
 const sites=exceptionSites('g:t','Averages_empty','\n  Attempted to divide by zero.\nmore',parseStackTrace(stack),resolve,file=>file===calc?'v1':undefined);
 assert.deepEqual(sites.map(site=>[site.file,site.line,site.depth]),[[calc,12,0],[calc,20,1],[tests,8,2]],'framework and outside frames and repeated lines are skipped');
 assert.equal(sites[0].message,'Attempted to divide by zero.','the first non-empty message line');
 assert.equal(sites[0].version,'v1');assert.equal(sites[2].version,undefined);
 const deep=Array.from({length:40},(_,index)=>`   at A.M${index}() in /workspace/App/Calc.cs:line ${index+1}`).join('\n');
 assert.equal(exceptionSites('g:t','x',undefined,parseStackTrace(deep),resolve,()=>undefined).length,16,'deep recursion is bounded');
});

test('exception sites are replaced per test, indexed by file, and forgotten when tests pass or disappear',()=>{
 const store=new ExceptionSites();
 const one=exceptionSites('g:a','A','boom',parseStackTrace(stack),resolve,()=>undefined);
 const two=exceptionSites('g:b','B','bang',parseStackTrace('   at App.Calc.Average(Int32[] values) in /workspace/App/Calc.cs:line 20'),resolve,()=>undefined);
 store.set('g:a',one);store.set('g:b',two);
 const lines=store.forFile(calc);
 assert.deepEqual([...lines.keys()].sort((a,b)=>a-b),[12,20]);
 assert.deepEqual(lines.get(20)?.map(site=>[site.test,site.depth]),[['g:b',0],['g:a',1]],'where a test threw sorts before a caller');
 assert.deepEqual([...store.filesWithSites].sort(),[calc,tests].sort());
 const revision=store.revision;
 store.set('g:c',[]);assert.equal(store.revision,revision,'a passing test without sites changes nothing');
 store.set('g:a',[]);assert.deepEqual([...store.forFile(calc).keys()],[20]);assert.equal(store.forFile(tests).size,0);
 store.retain(id=>id!=='g:b');assert.equal(store.size,0);assert.equal(store.forFile(calc).size,0);
 store.set('g:a',one);store.clear();assert.equal(store.size,0);
});

test('exception markers draw failing lines of visible editors, hide stale or unsaved ones, and clear when tests pass',async()=>{
 /** @type {{range: any, contentText: string, hover: string}[][]} */ const calls=[];
 const vscode={window:{visibleTextEditors:/** @type {unknown[]} */ ([]),createTextEditorDecorationType:()=>({dispose(){}})},
  ThemeColor:class{constructor(/** @type {string} */ id){this.id=id;}},OverviewRulerLane:{Right:4},
  Range:class{constructor(/** @type {any} */ start,/** @type {any} */ end){this.start=start;this.end=end;}},
  MarkdownString:class{constructor(value='',supportThemeIcons=false){this.value=value;this.supportThemeIcons=supportThemeIcons;/** @type {unknown} */ this.isTrusted=undefined;}appendMarkdown(/** @type {string} */ text){this.value+=text;return this;}}};
 const hashes=new Map([[calc,'v1']]);
 const host={disposed:false,roots:[normalizePath('/workspace')],enabled:true,hashes,named:()=>[],reportError(/** @type {unknown} */ error){throw error;}};
 // Timers never fire: each step renders directly, so the suite's load cannot reorder renders.
 const {ExceptionMarkers}=loadUi({vscode,globals:{setTimeout:()=>0,clearTimeout:()=>{}}}).module('ui/exceptionMarkers');
 const markers=new ExceptionMarkers(host);
 const document={uri:{scheme:'file',fsPath:'/workspace/App/Calc.cs'},languageId:'csharp',version:1,lineCount:30,isDirty:false,lineAt:(/** @type {number} */ line)=>({range:{end:{line,character:10}}})};
 const editor={document,setDecorations(/** @type {unknown} */ _type,/** @type {any[]} */ options){calls.push(options.map(option=>({range:option.range,contentText:option.renderOptions.after.contentText,hover:option.hoverMessage.value})));}};
 vscode.window.visibleTextEditors=[editor];
 const flush=()=>markers.render([editor]);
 const drawn=()=>JSON.parse(JSON.stringify(calls.at(-1)??null));
 await markers.record('g:a','Averages_empty',{id:'a',name:'Averages_empty',fullyQualifiedName:'T.Averages_empty',outcome:'failed',duration:1,message:'Attempted to divide by zero.',stack});
 await flush();
 assert.deepEqual(drawn().map((/** @type {any} */ call)=>[call.range.start.line,call.contentText]),[[11,'✗ thrown here · Averages_empty: Attempted to divide by zero.'],[19,'✗ on the stack · Averages_empty: Attempted to divide by zero.']]);
 assert.match(calls.at(-1)?.[0].hover??'',/command:testy\.showTest/);
 const count=calls.length;markers.refresh();await flush();assert.equal(calls.length,count,'an unchanged editor is not redrawn');
 hashes.set(calc,'v2');document.version=2;markers.refresh();await flush();
 assert.deepEqual(drawn(),[],'a changed file hides its markers until the test runs again');
 hashes.set(calc,'v1');document.version=3;document.isDirty=true;markers.refresh();await flush();
 assert.equal(calls.length,count+1,'still hidden while unsaved');
 document.isDirty=false;document.version=4;markers.refresh();await flush();assert.equal(calls.at(-1)?.length,2);
 // With the unsaved edits followed (see InlineResults.track), markers move with them, and one on a touched line is hidden.
 const {LineMap}=require('../../out/core/lineMap');const map=new LineMap();
 map.apply([{range:{start:{line:2},end:{line:2}},text:'a\nb'}]);
 /** @type {any} */ (host).lineMap=()=>map;document.isDirty=true;document.version=5;markers.refresh();await flush();
 assert.deepEqual(drawn().map((/** @type {any} */ call)=>call.range.start.line),[12,20],'markers move one line down');
 map.apply([{range:{start:{line:12},end:{line:12}},text:'x'}]);markers.refresh();await flush();
 assert.deepEqual(drawn().map((/** @type {any} */ call)=>call.range.start.line),[20],'the edited line loses its marker');
 /** @type {any} */ (host).lineMap=()=>undefined;document.isDirty=false;document.version=6;markers.refresh();await flush();assert.equal(calls.at(-1)?.length,2);
 await markers.record('g:a','Averages_empty',{id:'a',name:'Averages_empty',fullyQualifiedName:'T.Averages_empty',outcome:'passed',duration:1});
 await flush();
 assert.deepEqual(drawn(),[],'a passing rerun clears its markers');
 markers.dispose();
});
