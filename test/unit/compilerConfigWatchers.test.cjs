// @ts-check
const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

test('inherited compiler config watchers do not watch ancestors recursively or accept unrelated saves',async()=>{
 const patterns=/** @type {{base:string,pattern:string}[]} */([]);
 const vscode={RelativePattern:class {constructor(/** @type {string} */base,/** @type {string} */pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher(/** @type {{base:string,pattern:string}} */pattern){
  patterns.push(pattern);return{dispose(){},onDidChange(){},onDidCreate(){},onDidDelete(){}};
 }}};
 const {Testy}=loadUi({vscode});
 const requests=/** @type {unknown[][]} */([]),context={roots:['/workspace'],watchers:[],config:{trigger:'fileSystem',excludes:[],pattern:require('../../package.json').contributes.configuration.properties['testy.fileWatcherPattern'].default},
  engine:{inputVersion:1,knownFiles:['/.editorconfig','/workspace/Tests.cs'],directories:['/','/workspace'],markChanged:async()=>{}},scheduler:{request:(/** @type {unknown[]} */...args)=>requests.push(args)}};
 Testy.prototype.watch.call(context);
 assert.equal(patterns.some(p=>p.base==='/'&&p.pattern.includes('**')),false);
 assert.ok(patterns.some(p=>p.base==='/'&&p.pattern==='*'));
 await Testy.prototype.changed.call(context,{scheme:'file',fsPath:'/elsewhere/Unrelated.cs'},'class Unrelated {}');assert.equal(requests.length,0);
 await Testy.prototype.changed.call(context,{scheme:'file',fsPath:'/.editorconfig'},'root = true');assert.equal(requests.length,1);
});
