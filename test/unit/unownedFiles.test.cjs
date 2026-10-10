const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {selectTests,ProjectIndex}=require('../../out/core/selection');
const {normalizePath,isToolingFile,isConfigurationFile}=require('../../out/core/paths');
const policy=require('../../out/core/runPolicy');

const p=(/** @type {string} */ file)=>normalizePath(path.resolve('/workspace',file));
const projects=[
 {file:p('App/App.csproj'),sourceFiles:[p('App/A.cs')],inputs:[p('App/package.json'),p('shared/tsconfig.json')],references:[],framework:'net10.0',assembly:p('App/bin/App.dll')},
 {file:p('Tests/Tests.csproj'),sourceFiles:[p('Tests/ATests.cs')],references:[p('App/App.csproj')],framework:'net10.0',assembly:p('Tests/bin/Tests.dll')},
 {file:p('Other/Other.csproj'),sourceFiles:[p('Other/CTests.cs')],references:[],framework:'net10.0',assembly:p('Other/bin/Other.dll')}
];
const groups=[
 {id:'a',file:p('Tests/ATests.cs'),project:p('Tests/Tests.csproj'),framework:'net10.0',tests:[]},
 {id:'c',file:p('Other/CTests.cs'),project:p('Other/Other.csproj'),framework:'net10.0',tests:[]}
];
const trace=(/** @type {string} */ groupId,/** @type {string[]} */ ...files)=>({groupId,dependencies:files,coverage:[],reliable:true,timestamp:1});
const traces=new Map([['a',trace('a',p('App/A.cs'))],['c',trace('c',p('Other/CTests.cs'))]]);
const index=new ProjectIndex(/** @type {any} */ (projects),new Set([p('shared/tsconfig.json')]));
const hashes=new Map(projects.flatMap(project=>[project.file,...project.sourceFiles,...project.inputs??[]]).map(file=>[file,'hash']));
const select=(/** @type {string} */ file)=>selectTests(/** @type {any} */ (groups),/** @type {any} */ (projects),/** @type {any} */ (traces),[p(file)],'affected',false,new Set(/\.cs$/.test(file)?[]:[p(file)]),index);

test('an unowned file outside every project, such as shared test data, selects every project without restore or evaluation',()=>{
 for(const file of ['testdata/cases.json','shared/App.config','resources/Strings.resx','docs/notes.config']){
  assert.equal(isToolingFile(p(file)),false,file);
  const selection=select(file);
  assert.deepEqual(selection.groups.map(group=>group.id),['a','c'],`${file} must not produce a green empty run`);
  assert.equal(selection.fallback,true);assert.equal(selection.causes?.get('a')?.kind,'fallback');
  assert.equal(policy.invalidatesRestore(p(file),index),false,file);
  assert.equal(policy.isStructuralChange(p(file),index,hashes),false,`${file} needs no evaluation`);
 }
 assert.equal(policy.isStructuralChange(p('shared/Linked.cs'),index,hashes),true,'a new C# file outside every project can be a linked source');
});

test('well-known non-.NET tooling files are recognized',()=>{
 for(const file of ['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','tsconfig.json','tsconfig.build.json','jsconfig.json',
  '.eslintrc','.eslintrc.json','eslint.config.mjs','.prettierrc','.prettierrc.json','biome.json','renovate.json','team.code-workspace','.markdownlint.json','.markdownlintrc']){
  assert.equal(isToolingFile(p(file)),true,file);assert.equal(isConfigurationFile(p(file)),false,file);
  assert.deepEqual(select(file).groups,[],`${file} at the root selects nothing`);
  assert.equal(policy.isStructuralChange(p(file),index,hashes),false,file);
 }
 for(const file of ['appsettings.json','global.json','packages.lock.json','cases.json','Directory.Build.props']){assert.equal(isToolingFile(p(file)),false,file);}
});

test('tooling files keep their usual impact when a project owns, evaluated or contains them',()=>{
 assert.deepEqual(select('App/package.json').groups.map(group=>group.id),['a'],'an owned package.json selects its owner and dependents');
 assert.deepEqual(select('shared/tsconfig.json').groups.map(group=>group.id),['a'],'an evaluated tooling file outside the projects selects its consumers');
 assert.equal(policy.isStructuralChange(p('shared/tsconfig.json'),index,hashes),true,'an evaluated import needs evaluation again');
 assert.deepEqual(select('Other/package.json').groups.map(group=>group.id),['c'],'an unowned tooling file inside a project directory falls back to that project');
});
