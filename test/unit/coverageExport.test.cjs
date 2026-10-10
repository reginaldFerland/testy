const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readXml}=require('../../out/services/xml');
// Minimal element tree over the project's strict reader; throws on any malformed document.
const tree=xml=>{
 const stack=[{name:'#document',attributes:new Map(),children:[],text:''}];
 readXml(xml,{open:(name,attributes)=>{const node={name,attributes,children:[],text:''};stack.at(-1).children.push(node);stack.push(node);},close:()=>{stack.pop();},text:value=>{stack.at(-1).text+=value;}});
 return stack[0].children[0];
};
const child=(node,name)=>node.children.filter(item=>item.name===name);
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
 const coverage=tree(xml),attribute=(node,name)=>node.attributes.get(name);
 assert.equal(coverage.name,'coverage');
 assert.equal(attribute(coverage,'lines-valid'),'5');assert.equal(attribute(coverage,'lines-covered'),'4');
 assert.equal(attribute(coverage,'line-rate'),'0.8000');assert.equal(attribute(coverage,'timestamp'),'1700000000');
 assert.deepEqual(child(child(coverage,'sources')[0],'source').map(item=>item.text),[root.replace(/\\/g,'/')]);
 const classes=child(child(child(child(coverage,'packages')[0],'package')[0],'classes')[0],'class');
 assert.deepEqual(classes.map(item=>attribute(item,'filename')).sort(),['src/A&B <x>.cs','src/Calculator.cs',path.resolve('/elsewhere/Outside.cs').replace(/\\/g,'/')].sort());
 const calculator=classes.find(item=>attribute(item,'filename')==='src/Calculator.cs');
 assert.deepEqual(child(child(calculator,'lines')[0],'line').map(line=>[attribute(line,'number'),attribute(line,'hits')]),[['1','1'],['2','0'],['3','2']]);
 assert.equal(attribute(calculator,'line-rate'),'0.6667');
 assert.equal(tree(toCobertura([],[root])).name,'coverage','an empty report is still a document');
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

test('with several workspace folders the export asks which folder, and exports only its files relative to it',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'testy-export-')),target=path.join(directory,'out.lcov');
 try {
  const other=path.resolve('/other/space');let defaultUri,folderPicks,choose=items=>items[1];
  const vscode={workspace:{workspaceFolders:[]},Uri:{file:fsPath=>({fsPath})},
   window:{showQuickPick:async items=>items[0].format?items[0]:(folderPicks=items,choose(items)),showSaveDialog:async options=>{defaultUri=options.defaultUri;return{fsPath:target};},
    showWarningMessage:async()=>undefined,showInformationMessage:async()=>undefined}};
  const {exportCoverageFile}=loadUi({vscode}).module('ui/exportCoverage');
  const files=[...summaries,{...summary('x',[[1,1]]),file:path.join(other,'lib','Other.cs')}];
  assert.equal(await exportCoverageFile(()=>files,[root,other],()=>undefined),target);
  assert.deepEqual([...folderPicks.map(pick=>pick.description).slice(0,2)],[root,other]);
  assert.equal(defaultUri.fsPath,path.join(other,'coverage','testy.lcov'));
  assert.equal(fs.readFileSync(target,'utf8'),'TN:\nSF:lib/Other.cs\nDA:1,1\nLF:1\nLH:1\nend_of_record\n');
  choose=items=>items.at(-1);
  await exportCoverageFile(()=>files,[root,other],()=>undefined);
  const all=fs.readFileSync(target,'utf8');assert.match(all,/SF:src\/Calculator\.cs/);assert.match(all,/SF:lib\/Other\.cs/,'all folders keep every file');
  choose=()=>undefined;
  assert.equal(await exportCoverageFile(()=>files,[root,other],()=>undefined),undefined,'dismissing the folder choice cancels');
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
