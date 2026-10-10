// @ts-check
const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

test('inherited compiler config watchers do not watch ancestors recursively or accept unrelated saves',async()=>{
 const exports={},patterns=[];
 const vscode={RelativePattern:class {constructor(base,pattern){Object.assign(this,{base,pattern});}},workspace:{createFileSystemWatcher(pattern){
  patterns.push(pattern);return{dispose(){},onDidChange(){},onDidCreate(){},onDidDelete(){}};
 }}};
 exports.Testy=loadUi({vscode}).Testy;
 const requests=[],context={roots:['/workspace'],watchers:[],config:{trigger:'fileSystem',excludes:[],pattern:require('../../package.json').contributes.configuration.properties['testy.fileWatcherPattern'].default},
  engine:{inputVersion:1,knownFiles:['/.editorconfig','/workspace/Tests.cs'],directories:['/','/workspace'],markChanged:async()=>{}},scheduler:{request:(...args)=>requests.push(args)}};
 exports.Testy.prototype.watch.call(context);
 assert.equal(patterns.some(p=>p.base==='/'&&p.pattern.includes('**')),false);
 assert.ok(patterns.some(p=>p.base==='/'&&p.pattern==='*'));
 await exports.Testy.prototype.changed.call(context,{scheme:'file',fsPath:'/elsewhere/Unrelated.cs'},'class Unrelated {}');assert.equal(requests.length,0);
 await exports.Testy.prototype.changed.call(context,{scheme:'file',fsPath:'/.editorconfig'},'root = true');assert.equal(requests.length,1);
});
