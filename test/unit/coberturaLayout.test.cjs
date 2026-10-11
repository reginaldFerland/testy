const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {parseCobertura,readWithLayout}=require('../../out/services/reports');
const {normalizePath}=require('../../out/core/paths');
const documents=require('./fixtures/coberturaDifferential.json');

/** @typedef {import('../../out/services/reports').ReportLayout} ReportLayout */

/** A complete parse that also learns the layout, when it offers one. @param {string} xml @param {string} cwd @param {Set<string>} allowed */
function learn(xml,cwd,allowed){
 /** @type {ReportLayout | undefined} */
 let layout;
 const declarations=new Map(),lines=parseCobertura(xml,cwd,allowed,declarations,learned=>{layout=learned;});
 return{layout,lines,declarations};
}

/** Every hit count rewritten, as a later report of the same instrumented output would be. @param {string} xml */
const rehit=xml=>{let n=0;return xml.replace(/ hits="(\d+)"/g,()=>` hits="${(n++*7)%11}"`);};

const collector=(/** @type {string} */ file,/** @type {string} */ hits='1',/** @type {string} */ extra='')=>'<?xml version="1.0" encoding="utf-8"?>\n'+
 '<coverage line-rate="1" version="1.9"><sources><source>/w/</source></sources><packages><package name="App"><classes>'+
 `<class name="App.Calc" filename="${file}"><methods><method name="Add" signature="(int, int)"><lines><line number="3" hits="${hits}" branch="False" /><line number="4" hits="${hits}" branch="False" /></lines></method></methods>`+
 `<lines><line number="3" hits="${hits}" branch="False" /><line number="4" hits="${hits}" branch="False" />${extra}</lines></class>`+
 '<class name="App.Other" filename="Other.cs"><methods /><lines><line number="1" hits="0" branch="False" /></lines></class>'+
 '</classes></package></packages></coverage>\n';

test('a learned layout reads the corpus reports it was learned from, and their re-hit versions, exactly as a complete parse does',()=>{
 const cwd=process.cwd();
 let learned=0;
 for(const {xml,allowed,expected} of documents){
  if(expected.error)continue;
  const set=new Set(allowed.map(/** @param {string} file */ file=>normalizePath(path.resolve(cwd,file)))),{layout,lines,declarations}=learn(xml,cwd,set);
  if(!layout)continue;
  learned++;
  for(const report of [xml,rehit(xml)]){
   const fast=new Map(),full=new Map();
   assert.deepEqual(readWithLayout(report,layout,set,fast),parseCobertura(report,cwd,set,full));
   assert.deepEqual(fast,full);
  }
  assert.deepEqual(readWithLayout(xml,layout,set),lines);assert.ok(declarations);
 }
 assert.ok(learned>=10,`the corpus, built to vary how reports are written, still has reports the fast read handles: ${learned}`);
});

test('a report whose classes, lines, sources or completeness differ from the layout is left to the complete parse',()=>{
 const cwd='/w',allowed=new Set([normalizePath('/w/Calc.cs'),normalizePath('/w/Other.cs')]);
 const {layout}=learn(collector('Calc.cs'),cwd,allowed);
 assert.ok(layout);
 const fast=readWithLayout(collector('Calc.cs','5'),layout,allowed);
 assert.deepEqual(fast&&[...fast].map(([file,lines])=>[path.basename(file),lines]),[['Calc.cs',[{line:3,hits:5},{line:4,hits:5}]],['Other.cs',[{line:1,hits:0}]]]);
 const variants={
  'another file':collector('Moved.cs'),
  'an extra line':collector('Calc.cs','1','<line number="5" hits="1" branch="False" />'),
  'a missing line':collector('Calc.cs').replace(/<line number="4" hits="1" branch="False" \/><\/lines><\/class>/,'</lines></class>'),
  'a moved line':collector('Calc.cs').replace(/(<\/methods><lines><line number=)"3"/,'$1"2"'),
  'another class':collector('Calc.cs').replace('</classes>','<class name="X" filename="X.cs"><lines /></class></classes>'),
  'a missing class':collector('Calc.cs').replace(/<class name="App.Other"[\s\S]*?<\/class>/,''),
  'other sources':collector('Calc.cs').replace('<source>/w/</source>','<source>/elsewhere/</source>'),
  'a truncated report':collector('Calc.cs').slice(0,-40),
  'a non-integer hit count':collector('Calc.cs','1.5'),
  'a comment':collector('Calc.cs').replace('<packages>','<!-- x --><packages>'),
  'a document type':'<!DOCTYPE coverage>'+collector('Calc.cs')
 };
 for(const [name,xml] of Object.entries(variants)){assert.equal(readWithLayout(xml,layout,allowed),undefined,name);}
});

test('the layout keeps every class, so files allowed later are read with their method spans',()=>{
 const cwd='/w',calc=normalizePath('/w/Calc.cs');
 const {layout}=learn(collector('Calc.cs'),cwd,new Set());
 assert.ok(layout);
 const declarations=new Map(),fast=readWithLayout(collector('Calc.cs','2'),layout,new Set([calc]),declarations);
 assert.deepEqual(fast&&[...fast],[[calc,[{line:3,hits:2},{line:4,hits:2}]]]);
 assert.deepEqual(declarations.get(calc),[{name:'Add(int, int)',start:3,end:4}]);
});

test('a complete parse without method spans or with a report the fast read cannot reproduce offers no layout',()=>{
 const cwd='/w',allowed=new Set([normalizePath('/w/Calc.cs')]);
 let offered=false;
 parseCobertura(collector('Calc.cs'),cwd,allowed,undefined,()=>{offered=true;});
 assert.equal(offered,false,'a layout needs method spans');
 assert.equal(learn(collector('Calc.cs').replace(' filename="Calc.cs"'," filename='Calc.cs'"),cwd,allowed).layout,undefined,'single-quoted filenames');
 assert.equal(learn(collector('Calc.cs').replace('<packages>','<!-- x --><packages>'),cwd,allowed).layout,undefined,'comments');
});
