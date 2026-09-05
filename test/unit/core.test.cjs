const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {selectTests} = require('../../out/core/selection');
const {CoverageStore} = require('../../out/core/coverage');
const {normalizePath, isExcluded, matchesPattern} = require('../../out/core/paths');
const p = file => normalizePath(path.resolve('/workspace', file));
const projects = [
 {file:p('App/App.csproj'),sourceFiles:[p('App/A.cs'),p('App/B.cs')],references:[]},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs'),p('Tests/BTests.cs')],references:[p('App/App.csproj')]},
 {file:p('Other/Other.csproj'),sourceFiles:[p('Other/C.cs')],references:[]}
];
const groups = [
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj')},
 {id:'b',file:p('Tests/BTests.cs'),project:p('Tests/Tests.csproj')},
 {id:'c',file:p('Other/CTests.cs'),project:p('Other/Other.csproj')}
];
const trace = (groupId, file, hash='old', hits=1) => ({groupId,dependencies:[file],coverage:[{file,hash,lines:[{line:5,hits}]}],reliable:true,timestamp:1});
const traces = new Map([['a',trace('a',p('App/A.cs'))],['b',trace('b',p('App/B.cs'))],['c',trace('c',p('Other/C.cs'))]]);
const selected = (changes, records=traces, mode='affected') => selectTests(groups,projects,records,changes.map(p),mode).groups.map(group=>group.id);

test('selects the test files that exercised changed source',()=>assert.deepEqual(selected(['App/A.cs']),['a']));
test('combines all changed files',()=>assert.deepEqual(selected(['App/A.cs','App/B.cs']),['a','b']));
test('unknown source falls back to dependent projects, without unrelated projects',()=>assert.deepEqual(selected(['App/New.cs']),['a','b']));
test('configuration changes conservatively include all dependent tests',()=>assert.deepEqual(selected(['App/App.csproj']),['a','b']));
test('solution-wide configuration selects all projects',()=>assert.deepEqual(selected(['Directory.Build.props']),['a','b','c']));
test('incomplete traces cannot exclude a test file',()=>assert.deepEqual(selected(['App/A.cs'],new Map([['a',traces.get('a')]])),['a','b']));
test('all mode includes the full suite',()=>assert.deepEqual(selected(['App/A.cs'],traces,'all'),['a','b','c']));
test('changed test source selects its whole file',()=>assert.deepEqual(selected(['Tests/ATests.cs']),['a']));
test('generated files and build artifacts are excluded',()=>{
 for(const file of ['a/obj/Debug/Foo.cs','a/bin/Debug/X.cs','a/Client.g.cs','a/Form.Designer.cs','a/.git/x.cs','a/TestResults/x.cs']) assert.equal(isExcluded(file),true,file);
 assert.equal(isExcluded('a/Domain.cs'),false);
});
test('custom globs are relative to each workspace root',()=>{
 assert.equal(matchesPattern(p('App/A.cs'),'App/**/*.cs',[p('')]),true);
 assert.equal(matchesPattern(p('Tests/ATests.cs'),'App/**/*.cs',[p('')]),false);
 assert.equal(isExcluded(p('App/A.cs'),['App/**'],[p('')]),true);
 assert.equal(isExcluded(p('Tests/ATests.cs'),['App/**'],[p('')]),false);
});

test('coverage replacement retains other test files and removes deleted tests',()=>{
 const store=new CoverageStore(); const file=p('App/A.cs');
 store.replace([trace('a',file),{...trace('b',file),coverage:[{file,hash:'old',lines:[{line:6,hits:1}]}]}],new Set(['a','b']));
 store.replace([trace('a',file,'old',0)],new Set(['a','b']));
 assert.deepEqual(store.summarize(new Map([[file,'old']]))[0].lines,[{line:5,hits:0},{line:6,hits:1}]);
 store.replace([],new Set(['a']));
 assert.equal(store.summarize(new Map([[file,'old']]))[0].covered,0);
});
test('coverage from different source versions is not merged into false green lines',()=>{
 const store=new CoverageStore(); const file=p('App/A.cs');
 store.replace([trace('a',file),trace('b',file,'new',0)],new Set(['a','b']));
 const summary=store.summarize(new Map([[file,'new']]))[0];
 assert.equal(summary.stale,true);assert.equal(summary.covered,0);
 store.replace([trace('a',file,'new',0)],new Set(['a','b']));
 assert.equal(store.summarize(new Map([[file,'new']]))[0].stale,false);
});
test('a failure retains historical dependencies and loses selection trust',()=>{
 const store=new CoverageStore();store.replace([traces.get('a')],new Set(['a']));
 store.replace([{...trace('a',p('App/B.cs')),reliable:false}],new Set(['a']));
 assert.deepEqual(store.traces.get('a').dependencies,[p('App/A.cs'),p('App/B.cs')]);
 assert.equal(store.traces.get('a').reliable,false);
});
