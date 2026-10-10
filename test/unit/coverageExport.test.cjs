const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {XMLParser,XMLValidator}=require('fast-xml-parser');
const {toLcov,toCobertura,exportPath,exportCoverage}=require('../../out/core/coverageExport');
const {loadUi}=require('./support/ui.cjs');

const root=path.resolve('/work/space');
const summary=(file,lines,overrides={})=>({file:path.join(root,file),lines:lines.map(([line,hits])=>({line,hits})),stale:false,covered:lines.filter(([,hits])=>hits>0).length,total:lines.length,groupIds:['g'],...overrides});
const summaries=[
 summary('src/Calculator.cs',[[3,2],[1,1],[2,0]]),
 summary('src/Stale.cs',[[1,1]],{stale:true}),
 summary('src/A&B <x>.cs',[[7,4]]),
 {...summary('src/Empty.cs',[]),total:0},
 {file:path.resolve('/elsewhere/Outside.cs'),lines:[{line:1,hits:1}],stale:false,covered:1,total:1,groupIds:['g']}
];

test('exported paths are workspace-relative with forward slashes where possible',()=>{
 assert.equal(exportPath(path.join(root,'src','A.cs'),[root]),'src/A.cs');
 assert.equal(exportPath(path.resolve('/elsewhere/B.cs'),[root]),path.resolve('/elsewhere/B.cs').replace(/\\/g,'/'));
});

test('LCOV export writes complete records for current coverage only',()=>{
 const records=toLcov(summaries,[root]).trim().split('end_of_record').map(record=>record.trim()).filter(Boolean).map(record=>record.split('\n'));
 assert.equal(records.length,3,'stale and empty files are omitted');
 const calculator=records.find(record=>record.includes('SF:src/Calculator.cs'));
 assert.deepEqual(calculator,['TN:','SF:src/Calculator.cs','DA:1,1','DA:2,0','DA:3,2','LF:3','LH:2']);
 assert.ok(records.some(record=>record[1]===`SF:${path.resolve('/elsewhere/Outside.cs').replace(/\\/g,'/')}`));
 assert.ok(!toLcov(summaries,[root]).includes('Stale.cs'));
 assert.ok(toLcov(summaries,[root]).trim().endsWith('end_of_record'));
 assert.equal(toLcov([],[root]),'');
});

test('Cobertura export is well-formed XML with escaped names and consistent rates',()=>{
 const xml=toCobertura(summaries,[root],1_700_000_000_000);
 assert.equal(XMLValidator.validate(xml),true);
 const parsed=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',isArray:name=>['class','line','source'].includes(name)}).parse(xml);
 const coverage=parsed.coverage;
 assert.equal(coverage['@_lines-valid'],'5');assert.equal(coverage['@_lines-covered'],'4');
 assert.equal(coverage['@_line-rate'],'0.8000');assert.equal(coverage['@_timestamp'],'1700000000');
 assert.deepEqual(coverage.sources.source,[root.replace(/\\/g,'/')]);
 const classes=coverage.packages.package.classes.class;
 assert.deepEqual(classes.map(item=>item['@_filename']).sort(),['src/A&B <x>.cs','src/Calculator.cs',path.resolve('/elsewhere/Outside.cs').replace(/\\/g,'/')].sort());
 const calculator=classes.find(item=>item['@_filename']==='src/Calculator.cs');
 assert.deepEqual(calculator.lines.line.map(line=>[line['@_number'],line['@_hits']]),[['1','1'],['2','0'],['3','2']]);
 assert.equal(calculator['@_line-rate'],'0.6667');
 assert.equal(XMLValidator.validate(toCobertura([],[root])),true,'an empty report is still a document');
 assert.equal(exportCoverage('cobertura',summaries,[root]).startsWith('<?xml'),true);
 assert.equal(exportCoverage('lcov',summaries,[root]).startsWith('TN:'),true);
});

test('the export command writes the chosen format to the chosen location',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'testy-export-')),target=path.join(directory,'nested','out.lcov');
 try {
  const shown=[],messages=[];let defaultUri,picks;
  const vscode={workspace:{workspaceFolders:[]},Uri:{file:fsPath=>({fsPath})},
   window:{showQuickPick:async items=>{picks=items;return items[0];},showSaveDialog:async options=>{defaultUri=options.defaultUri;return{fsPath:target};},
    showWarningMessage:async message=>{messages.push(message);},showInformationMessage:async message=>{shown.push(message);}}};
  const {exportCoverageFile}=loadUi({vscode}).module('ui/exportCoverage');
  assert.equal(await exportCoverageFile(()=>summaries,[root],()=>undefined),target);
  assert.deepEqual([...picks.map(pick=>pick.format)],['lcov','cobertura']);
  assert.equal(defaultUri.fsPath,path.join(root,'coverage','testy.lcov'));
  assert.match(fs.readFileSync(target,'utf8'),/TN:\nSF:src\/A&B <x>\.cs\nDA:7,4\nLF:1\nLH:1\nend_of_record/);
  assert.equal(shown.length,1);
  assert.equal(await exportCoverageFile(()=>[summary('src/S.cs',[[1,1]],{stale:true})],[root],()=>undefined),undefined);
  assert.equal(messages.length,1,'stale-only coverage is not exported');
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
