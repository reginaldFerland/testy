const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {selectTests}=require('../../out/core/selection');
const {normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');
const {createTesty}=require('./support/controller.cjs');

const p=file=>normalizePath(path.resolve('/workspace',file));
const plain=value=>JSON.parse(JSON.stringify(value));
const projects=[
 {file:p('App/App.csproj'),sourceFiles:[p('App/A.cs'),p('App/B.cs')],references:[]},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs'),p('Tests/BTests.cs')],references:[p('App/App.csproj')]},
 {file:p('Other/Other.csproj'),sourceFiles:[p('Other/C.cs')],references:[]}
];
const groups=[
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'b',file:p('Tests/BTests.cs'),project:p('Tests/Tests.csproj'),tests:[]},
 {id:'c',file:p('Other/CTests.cs'),project:p('Other/Other.csproj'),tests:[]}
];
const trace=(groupId,...files)=>({groupId,dependencies:files,coverage:[],reliable:true,timestamp:1});
const traces=new Map([['a',trace('a',p('App/A.cs'))],['b',trace('b',p('App/B.cs'))],['c',trace('c',p('Other/C.cs'))]]);
const select=(changes,records=traces,mode='affected',force=false,conservative=new Set())=>selectTests(groups,projects,records,changes.map(p),mode,force,conservative);
const causeOf=(selection,id)=>plain(selection.causes.get(id));

test('a trace-covered change names the changed file as the cause',()=>{
 const selection=select(['App/A.cs']);
 assert.deepEqual(selection.groups.map(group=>group.id),['a']);
 assert.deepEqual(causeOf(selection,'a'),{kind:'covers',files:[p('App/A.cs')],more:0});
 assert.equal(selection.causes.size,1,'only selected groups carry a cause');
});

test('an edited test file, a missing trace and an unmapped change each get their own cause',()=>{
 assert.deepEqual(causeOf(select(['Tests/ATests.cs']),'a'),{kind:'edited',files:[p('Tests/ATests.cs')],more:0});
 const unmapped=select(['App/New.cs']);
 assert.deepEqual(unmapped.groups.map(group=>group.id),['a','b']);
 assert.deepEqual(causeOf(unmapped,'b'),{kind:'fallback',files:[p('App/New.cs')],more:0,reason:'unmapped'});
 const untraced=select(['App/A.cs'],new Map([['a',traces.get('a')]]));
 assert.deepEqual(untraced.groups.map(group=>group.id),['a','b']);
 assert.equal(untraced.causes.get('a').kind,'covers');
 assert.deepEqual(causeOf(untraced,'b'),{kind:'fallback',files:[p('App/A.cs')],more:0,reason:'untraced'});
 assert.deepEqual(causeOf(select(['Directory.Build.props']),'c'),{kind:'fallback',files:[p('Directory.Build.props')],more:0,reason:'configuration'});
 assert.equal(select(['App/A.cs'],traces,'affected',false,new Set([p('App/A.cs')])).causes.get('b').reason,'unanalyzed');
});

test('run-wide causes cover every group without changing the selection',()=>{
 const all=select(['App/A.cs'],traces,'all');
 assert.deepEqual(all.groups.map(group=>group.id),['a','b','c']);
 assert.deepEqual([...all.causes.values()].map(cause=>cause.kind),['all','all','all']);
 assert.equal(select([],traces,'affected',true).causes.get('c').kind,'baseline');
 assert.equal(select([]).causes.size,0);
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
 assert.deepEqual(plain(lines.map(line=>line.text)),['Selected ATests.cs: covers A.cs (changed)']);

 const items=new Map(groups.map(group=>[`file:${group.id}`,{id:`file:${group.id}`,description:group.id==='b'?'original':undefined}]));
 const appended=[];
 const {TestTree}=ui;
 const context={items,described:new Map(),host:{activeRun:{appendOutput:(text,location,test)=>appended.push({text,test})}}};
 const returned=TestTree.prototype.explain.call(context,selection);
 assert.deepEqual([...returned],['Selected ATests.cs: covers A.cs (changed)']);
 assert.equal(items.get('file:a').description,'covers A.cs (changed)');
 assert.deepEqual(appended,[{text:'Selected ATests.cs: covers A.cs (changed)\r\n',test:items.get('file:a')}]);
 TestTree.prototype.explain.call(context,select(['App/B.cs']));
 assert.equal(items.get('file:b').description,'covers B.cs (changed)');
 TestTree.prototype.restoreDescriptions.call(context);
 assert.equal(items.get('file:a').description,undefined);assert.equal(items.get('file:b').description,'original');
});

test('large run-wide selections are summarized in one line, and long lists are capped',()=>{
 const {explainSelection}=loadUi().module('ui/selectionCause');
 const many=Array.from({length:1000},(_,index)=>({id:`g${index}`,file:p(`Tests/T${index}.cs`),project:p('Tests/Tests.csproj'),tests:[]}));
 const baseline=selectTests(many,projects,new Map(),[],'affected',true);
 const summary=explainSelection(baseline);
 assert.equal(summary.explanations.length,1000);
 assert.deepEqual(plain(summary.lines.map(line=>line.text)),['Selected 1000 test files: baseline: learning coverage']);
 const changed=selectTests(many,projects,new Map(),[p('Directory.Build.props')],'affected');
 const capped=explainSelection(changed).lines;
 assert.equal(capped.length,501);assert.match(capped.at(-1).text,/^…and 500 more selected test files$/);
 const unexplained=explainSelection({groups:many.slice(0,2),reason:'Containing files for provider runtime identities',fallback:true});
 assert.deepEqual(plain(unexplained.lines.map(line=>line.text)),['Selected T0.cs: Containing files for provider runtime identities','Selected T1.cs: Containing files for provider runtime identities']);
});

test('the controller logs each cause to the Testy output when a selection is announced',async()=>{
 const {events,output,testy}=createTesty();
 events.selected(select(['App/A.cs']));
 assert.ok(output.includes('Selected ATests.cs: covers A.cs (changed)'),output.join('\n'));
 events.selected({groups:[groups[0]],reason:'Containing files for provider runtime identities',fallback:true});
 assert.ok(output.includes('Selected ATests.cs: Containing files for provider runtime identities'));
 await testy.dispose();
});
