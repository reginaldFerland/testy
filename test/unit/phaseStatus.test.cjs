const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

// A recognizable "translation" proves every displayed string passes through l10n.
const translate=(message,...args)=>`«${message.replace(/\{(\d+)\}/g,(_,index)=>String(args[index]))}»`;

test('engine phases are formatted from typed payloads through l10n',()=>{
 const {describePhase}=loadUi({vscode:{l10n:{t:translate}}}).module('ui/statusBar');
 assert.equal(describePhase({kind:'preparingProjects'}),'«Preparing projects»');
 assert.equal(describePhase({kind:'building'}),'«Building»');
 assert.equal(describePhase({kind:'preparingTests'}),'«Preparing tests»');
 assert.equal(describePhase({kind:'preparingTests',completed:3,total:5,active:2}),'«Preparing tests 3/5 · 2 active»');
 assert.equal(describePhase({kind:'testing'}),'«Testing»');
 assert.equal(describePhase({kind:'testing',completed:1,total:4,active:2}),'«Testing 1/4 · 2 active»');
 assert.equal(describePhase({kind:'testing',completed:1,total:4,active:2,learned:3,learnedTotal:10}),'«Testing 1/4 · 2 active» · «3/10 files learned»');
 assert.equal(describePhase({kind:'settingUpCoverage'}),'«Setting up coverage»');
});

test('the status bar shows the localized phase while a run is active',()=>{
 const {StatusBar}=loadUi({vscode:{l10n:{t:translate},commands:{executeCommand:async()=>{}},ThemeColor:class{}}}).module('ui/statusBar');
 const bar={item:{}},model={paused:false,running:true,scheduling:'idle',phase:undefined,lastError:'',lastSummary:undefined,passed:0,failed:0,hasTests:true,coverageSuffix:'',continuousOverride:false};
 StatusBar.prototype.update.call(bar,{...model,phase:{kind:'building'}});
 assert.equal(bar.item.text,'$(sync~spin) «Testy: «Building»»');
 StatusBar.prototype.update.call(bar,{...model,phase:{kind:'testing',completed:2,total:6,active:3}});
 assert.equal(bar.item.text,'$(sync~spin) «Testy: «Testing 2/6 · 3 active»»');
 StatusBar.prototype.update.call(bar,{...model,paused:true,phase:{kind:'building'}});
 assert.equal(bar.item.text,'$(debug-pause) «Testy: paused»','pausing takes precedence over progress');
});
