const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {selectTests}=require('../../out/core/selection');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');
const {createTesty}=require('./support/controller.cjs');

/** @typedef {import('../../out/core/model').Project} Project */
/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/core/model').Trace} Trace */
/** @typedef {import('../../out/core/selection').Selection} Selection */
/** @typedef {import('../../out/core/selection').SelectionCause} SelectionCause */

/** Narrows a value the test knows is present (type-only; no runtime check). @template T @param {T | null | undefined} value @returns {T} */
const need=value=>/** @type {T} */(value);
/** @param {Selection} selection */
const causesOf=selection=>need(selection.causes);
/** @param {string} file */
const p=file=>normalizePath(path.resolve('/workspace',file));
/** @template T @param {T} value @returns {any} */
const plain=value=>JSON.parse(JSON.stringify(value));
// Partial mocks: only the fields selection reads are provided.
const projects=/** @type {Project[]} */ (/** @type {any} */ ([
 {file:p('App/App.csproj'),sourceFiles:[p('App/A.cs'),p('App/B.cs')],references:[]},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs'),p('Tests/BTests.cs')],references:[p('App/App.csproj')]},
 {file:p('Other/Other.csproj'),sourceFiles:[p('Other/C.cs')],references:[]}
]));
const groups=/** @type {TestFile[]} */ (/** @type {any} */ ([
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'b',file:p('Tests/BTests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'c',file:p('Other/CTests.cs'),project:p('Other/Other.csproj'),tests:[]}
]));
/** @param {string} groupId @param {string[]} files @returns {Trace} */
const trace=(groupId,...files)=>({groupId,dependencies:files,coverage:[],reliable:true,timestamp:1});
const traces=new Map([['a',trace('a',p('App/A.cs'))],['b',trace('b',p('App/B.cs'))],['c',trace('c',p('Other/C.cs'))]]);
/** @param {string[]} changes @param {Map<string, Trace>} [records] @param {'affected' | 'all'} [mode] @param {boolean} [force] @param {Set<string>} [conservative] */
const select=(changes,records=traces,mode='affected',force=false,conservative=new Set())=>selectTests(groups,projects,records,changes.map(p),mode,force,conservative);
/** @param {Selection} selection @param {string} id */
const causeOf=(selection,id)=>plain(causesOf(selection).get(id));

test('a trace-covered change names the changed file as the cause',()=>{
 const selection=select(['App/A.cs']);
 assert.deepEqual(selection.groups.map(group=>group.id),['a']);
 assert.deepEqual(causeOf(selection,'a'),{kind:'covers',files:[p('App/A.cs')],more:0});
 assert.equal(causesOf(selection).size,1,'only selected groups carry a cause');
});

test('an edited test file, a missing trace and an unmapped change each get their own cause',()=>{
 assert.deepEqual(causeOf(select(['Tests/ATests.cs']),'a'),{kind:'edited',files:[p('Tests/ATests.cs')],more:0});
 const unmapped=select(['App/New.cs']);
 assert.deepEqual(unmapped.groups.map(group=>group.id),['a','b']);
 assert.deepEqual(causeOf(unmapped,'b'),{kind:'fallback',files:[p('App/New.cs')],more:0,reason:'unmapped'});
 const untraced=select(['App/A.cs'],new Map([['a',need(traces.get('a'))]]));
 assert.deepEqual(untraced.groups.map(group=>group.id),['a','b']);
 assert.equal(need(causesOf(untraced).get('a')).kind,'covers');
 assert.deepEqual(causeOf(untraced,'b'),{kind:'fallback',files:[p('App/A.cs')],more:0,reason:'untraced'});
 assert.deepEqual(causeOf(select(['Directory.Build.props']),'c'),{kind:'fallback',files:[p('Directory.Build.props')],more:0,reason:'configuration'});
 assert.equal(need(causesOf(select(['App/A.cs'],traces,'affected',false,new Set([p('App/A.cs')]))).get('b')).reason,'unanalyzed');
});

test('run-wide causes cover every group without changing the selection',()=>{
 const all=select(['App/A.cs'],traces,'all');
 assert.deepEqual(all.groups.map(group=>group.id),['a','b','c']);
 assert.deepEqual([...causesOf(all).values()].map(cause=>cause.kind),['all','all','all']);
 assert.equal(need(causesOf(select([],traces,'affected',true)).get('c')).kind,'baseline');
 assert.equal(causesOf(select([])).size,0);
});

test('the files listed per group are capped and the rest counted',()=>{
 const sources=Array.from({length:50},(_,index)=>p(`App/F${index}.cs`));
 const wide=[{...projects[0],sourceFiles:sources},projects[1]];
 const records=new Map([['a',trace('a',...sources)],['b',trace('b',p('App/B.cs'))]]);
 const selection=selectTests(groups.slice(0,2),wide,records,sources,'affected');
 assert.deepEqual(selection.groups.map(group=>group.id),['a']);
 const cause=causeOf(selection,'a');
 assert.equal(cause.files.length,3);assert.equal(cause.more,47);assert.equal(cause.kind,'covers');
});

test('causes are described in the run output and on file items, then restored',()=>{
 const ui=loadUi();
 const {describeCause,explainSelection}=ui.module('ui/selectionCause');
 assert.equal(describeCause({kind:'covers',files:[p('App/A.cs')],more:0}),'covers A.cs (changed)');
 assert.equal(describeCause({kind:'covers',files:[p('App/A.cs'),p('App/B.cs'),p('App/C.cs')],more:4}),'covers A.cs, B.cs, C.cs and 4 more (changed)');
 assert.equal(describeCause({kind:'fallback',files:[p('App/New.cs')],more:0,reason:'unmapped'}),'project fallback: no coverage trace covers New.cs');
 assert.equal(describeCause({kind:'manual',files:[],more:0}),'manual run');
 const selection=select(['App/A.cs']);
 const {lines}=explainSelection(selection);
 assert.deepEqual(plain(lines.map((/** @type {{ text: string }} */ line)=>line.text)),['Selected ATests.cs: covers A.cs (changed)']);

 const items=new Map(groups.map(group=>[`file:${group.id}`,{id:`file:${group.id}`,description:group.id==='b'?'original':undefined}]));
 /** @type {{ text: string, test: unknown }[]} */ const appended=[];
 const {TestTree}=ui;
 const context={items,described:new Map(),host:{activeRun:{appendOutput:(/** @type {string} */ text,/** @type {unknown} */ location,/** @type {unknown} */ test)=>appended.push({text,test})}}};
 const returned=TestTree.prototype.explain.call(context,selection);
 assert.deepEqual([...returned],['Selected ATests.cs: covers A.cs (changed)']);
 assert.equal(need(items.get('file:a')).description,'covers A.cs (changed)');
 assert.deepEqual(appended,[{text:'Selected ATests.cs: covers A.cs (changed)\r\n',test:items.get('file:a')}]);
 TestTree.prototype.explain.call(context,select(['App/B.cs']));
 assert.equal(need(items.get('file:b')).description,'covers B.cs (changed)');
 TestTree.prototype.restoreDescriptions.call(context);
 assert.equal(need(items.get('file:a')).description,undefined);assert.equal(need(items.get('file:b')).description,'original');
});

test('large run-wide selections are summarized in one line, and long lists are capped',()=>{
 const {explainSelection}=loadUi().module('ui/selectionCause');
 const many=/** @type {TestFile[]} */ (/** @type {any} */ (Array.from({length:1000},(_,index)=>({id:`g${index}`,file:p(`Tests/T${index}.cs`),project:p('Tests/Tests.csproj'),tests:[]})))); // partial mocks
 const baseline=selectTests(many,projects,new Map(),[],'affected',true);
 const summary=explainSelection(baseline);
 assert.equal(summary.explanations.length,1000);
 assert.deepEqual(plain(summary.lines.map((/** @type {{ text: string }} */ line)=>line.text)),['Selected 1000 test files: baseline: learning coverage']);
 const changed=selectTests(many,projects,new Map(),[p('Directory.Build.props')],'affected');
 const capped=explainSelection(changed).lines;
 assert.equal(capped.length,501);assert.match(capped.at(-1).text,/^…and 500 more selected test files$/);
 const unexplained=explainSelection({groups:many.slice(0,2),reason:'Containing files for provider runtime identities',fallback:true});
 assert.deepEqual(plain(unexplained.lines.map((/** @type {{ text: string }} */ line)=>line.text)),['Selected T0.cs: Containing files for provider runtime identities','Selected T1.cs: Containing files for provider runtime identities']);
});

test('the controller logs each cause to the Testy output when a selection is announced',async()=>{
 const {events,output,testy}=createTesty();
 events.selected(select(['App/A.cs']));
 assert.ok(output.includes('Selected ATests.cs: covers A.cs (changed)'),output.join('\n'));
 events.selected({groups:[groups[0]],reason:'Containing files for provider runtime identities',fallback:true});
 assert.ok(output.includes('Selected ATests.cs: Containing files for provider runtime identities'));
 await testy.dispose();
});
