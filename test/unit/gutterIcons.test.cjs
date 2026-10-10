const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {loadUi}=require('./support/ui.cjs');

test('gutter icons provide light and dark variants with distinct shapes per state',async()=>{
 /** @type {Record<string, any>[]} */
 const created=[];
 const vscode={window:{createTextEditorDecorationType:/** @param {Record<string, any>} options */ options=>{created.push(options);return{dispose(){}};}},
  Uri:{joinPath:/** @param {{path: string}} base @param {string[]} parts */ (base,...parts)=>({path:[base.path,...parts].join('/')})}};
 new (loadUi({vscode}).CoverageView)({path:'/ext'},{},{},{},new Map(),{});
 assert.deepEqual(created.map(options=>[options.light.gutterIconPath.path,options.dark.gutterIconPath.path,options.gutterIconPath]),
  ['covered','uncovered','stale'].map(kind=>[`/ext/media/${kind}-light.svg`,`/ext/media/${kind}-dark.svg`,undefined]));
 const shapes=new Set();
 for(const kind of ['covered','uncovered','stale']){
  const [light,dark]=await Promise.all(['light','dark'].map(theme=>fs.readFile(path.join(__dirname,'../../media',`${kind}-${theme}.svg`),'utf8')));
  const shape=/** @param {string} svg */ svg=>svg.replace(/#[0-9a-f]{6}/gi,'COLOR');
  assert.equal(shape(light),shape(dark),`${kind} keeps one shape across themes`);assert.notEqual(light,dark);shapes.add(shape(light));
 }
 assert.equal(shapes.size,3,'covered, uncovered and stale stay distinguishable without colour');
});
