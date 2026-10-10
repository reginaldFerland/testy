const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {parseCobertura}=require('../../out/services/reports');
const {normalizePath}=require('../../out/core/paths');
const {generate}=require('./support/coberturaCorpus.cjs');
const documents=require('./fixtures/coberturaDifferential.json');

// The fixture was captured from the previous fast-xml-parser based implementation over the same
// deterministic corpus, so the purpose-built reader must reproduce it exactly: lines, spans and errors.
test('the corpus generator is still the one the fixture was captured from',()=>{
 for(const document of documents.filter((_,index)=>index%25===0)){assert.deepEqual(generate(document.seed),{xml:document.xml,allowed:document.allowed});}
});

test('parseCobertura output matches the captured fast-xml-parser output for generated reports',()=>{
 const cwd=process.cwd(),rel=/** @param {string} file */ file=>path.relative(cwd,file);
 const outcomes=new Set();
 for(const {seed,xml,allowed,expected} of documents){
  const set=new Set(allowed.map(file=>normalizePath(path.resolve(cwd,file)))),declarations=new Map();
  let actual;
  try{
   const lines=parseCobertura(xml,cwd,set,declarations);
   actual={lines:[...lines].map(([file,list])=>[rel(file),list]),declarations:[...declarations].map(([file,list])=>[rel(file),list])};
   assert.deepEqual([...parseCobertura(xml,cwd,set)],[...lines],'spans do not change class lines');
  }catch(error){actual={error:/** @type {Error} */ (error).message};}
  assert.deepEqual(actual,expected,`seed ${seed}`);
  outcomes.add(expected.error??(expected.declarations.length?'declarations':'lines'));
 }
 assert.ok(outcomes.size>=4,`corpus exercises success and every error: ${[...outcomes]}`);
});
