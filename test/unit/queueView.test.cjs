const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

test('the queue shows running batches first, then queued, then finished ones, each with its state, time and reason',()=>{
 const vscode={TreeItem:class{constructor(/** @type {string} */ label){this.label=label;}},TreeItemCollapsibleState:{None:0},
  ThemeIcon:class{constructor(/** @type {string} */ id,/** @type {unknown} */ color){this.id=id;this.color=color;}},ThemeColor:class{constructor(/** @type {string} */ id){this.id=id;}}};
 const {QueueView}=loadUi({vscode,globals:{setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{}}}).module('ui/queueView');
 const view=new QueueView(()=>10_000);
 view.update([
  {id:'a',name:'A.cs',state:'passed',tests:2,elapsed:1500,started:1000},
  {id:'b',name:'B.cs',state:'queued',tests:3,expected:2000,cause:{kind:'covers',files:['/w/Calc.cs'],more:0}},
  {id:'c',name:'C.cs',state:'running',tests:1,started:8000,expected:4000,part:{index:2,count:3}},
  {id:'d',name:'D.cs',state:'failed',tests:4,failed:2,elapsed:500}
 ]);
 const items=view.getChildren().map((/** @type {any} */ entry)=>view.getTreeItem(entry));
 assert.deepEqual(items.map((/** @type {any} */ item)=>item.label),['C.cs','B.cs','D.cs','A.cs']);
 assert.deepEqual(items.map((/** @type {any} */ item)=>item.description),['running 2.0s / 4.0s · part 2 of 3','queued · about 2.0s','2 failed · 0.5s','passed 1.5s']);
 assert.equal(items[0].iconPath.id,'loading~spin');assert.match(items[1].tooltip,/covers Calc\.cs \(changed\)/);
 assert.deepEqual([...items[1].command.arguments],['file:b']);
 const {settleQueue}=require('../../out/core/queue');
 assert.deepEqual(settleQueue([{id:'x',name:'X',state:'queued',tests:1},{id:'y',name:'Y',state:'running',tests:1,started:1000}],4000).map(entry=>[entry.state,entry.elapsed]),[['stopped',undefined],['stopped',3000]]);
 view.dispose();
});
