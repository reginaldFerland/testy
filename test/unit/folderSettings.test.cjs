const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {filterEntryPoints}=require('../../out/services/projects');
const {matchesPattern,normalizePath}=require('../../out/core/paths');
const {loadUi}=require('./support/ui.cjs');

/** @param {unknown} value */
const plain=value=>JSON.parse(JSON.stringify(value));

/**
 * The real `configuration()` over workspace-level and folder-level setting values.
 * @param {string[]} folders
 * @param {{workspace?:Record<string,any>,folder?:Record<string,Record<string,any>>}} [options]
 */
function configurationFor(folders,{workspace={},folder={}}={}) {
 const workspaceFolders=folders.map((fsPath,index)=>({uri:{fsPath},name:path.basename(fsPath),index}));
 const vscode={workspace:{workspaceFolders,getConfiguration:(/** @type {string} */ section,/** @type {{fsPath:string}|undefined} */ scope)=>({
  get:(/** @type {string} */ key,/** @type {unknown} */ fallback)=>key in workspace?workspace[key]:fallback,
  inspect:(/** @type {string} */ key)=>({workspaceValue:workspace[key],workspaceFolderValue:scope?folder[scope.fsPath]?.[key]:undefined})
 })}};
 return loadUi({vscode,stubs:{configuration:undefined}}).module('configuration').configuration();
}

test('single-folder and unscoped workspaces read settings exactly as before',()=>{
 const root=path.resolve('/repo');
 const config=configurationFor([root],{workspace:{solution:'All.sln',exclude:['**/Legacy/**'],'projects.include':['tests/**'],buildConfiguration:'Release'}});
 assert.equal(config.solution,path.join(root,'All.sln'));assert.equal(config.solutions,undefined);
 assert.ok(config.excludes.includes('**/Legacy/**'));
 assert.deepEqual(plain(config.projects),{include:['tests/**'],exclude:[]});
 assert.equal(config.configuration,'Release');assert.deepEqual(plain(config.folderConflicts),[]);
});

test('folder-level path settings apply to their folder, resolved against it',()=>{
 const a=normalizePath(path.resolve('/ws/a')),b=normalizePath(path.resolve('/ws/b'));
 const config=configurationFor([a,b],{workspace:{exclude:['**/Shared/**']},folder:{
  [a]:{solution:'App.slnf',exclude:['legacy/**'],'projects.include':['tests/**'],'projects.exclude':['tests/Slow/**']},
  [b]:{solution:'${workspaceFolder}/sub/B.sln'}}});
 assert.equal(config.solution,undefined);
 assert.deepEqual(plain(config.solutions),[{file:path.join(a,'App.slnf'),root:a},{file:path.join(b,'sub','B.sln'),root:b}]);
 /** @param {string} file */
 const excluded=file=>config.excludes.some((/** @type {string} */ pattern)=>matchesPattern(file,pattern,[a,b]));
 assert.equal(excluded(path.join(a,'legacy','X.cs')),true);
 assert.equal(excluded(path.join(b,'legacy','X.cs')),false,'a folder-level exclude does not reach other folders');
 assert.equal(excluded(path.join(b,'Shared','X.cs')),true,'workspace patterns still apply everywhere');
 /** @param {string} file */
 const included=file=>config.projects.include.some((/** @type {string} */ pattern)=>matchesPattern(file,pattern,[a,b]));
 assert.equal(included(path.join(a,'tests','T','T.csproj')),true);
 assert.equal(included(path.join(a,'src','App','App.csproj')),false);
 assert.equal(included(path.join(b,'src','App','App.csproj')),true,'a folder without include patterns keeps every project');
 /** @param {string} file */
 const projectExcluded=file=>config.projects.exclude.some((/** @type {string} */ pattern)=>matchesPattern(file,pattern,[a,b]));
 assert.equal(projectExcluded(path.join(a,'tests','Slow','Slow.csproj')),true);
 assert.equal(projectExcluded(path.join(b,'tests','Slow','Slow.csproj')),false);
});

test('a workspace-level solution keeps applying to folders without their own value',()=>{
 const a=normalizePath(path.resolve('/ws/a')),b=normalizePath(path.resolve('/ws/b'));
 const config=configurationFor([a,b],{workspace:{solution:'All.sln'},folder:{[b]:{solution:'B.sln'}}});
 assert.deepEqual(plain(config.solutions),[{file:path.join(a,'All.sln'),root:a},{file:path.join(b,'B.sln'),root:b}]);
});

test('folder paths with glob characters are escaped when anchoring patterns',()=>{
 const a=normalizePath(path.resolve('/ws/a [x]')),b=normalizePath(path.resolve('/ws/b'));
 const config=configurationFor([a,b],{folder:{[a]:{exclude:['gen/**']}}});
 assert.equal(config.excludes.some((/** @type {string} */ pattern)=>matchesPattern(path.join(a,'gen','X.cs'),pattern,[a,b])),true);
});

test('run-wide settings that differ between folders are reported and the workspace value is used',()=>{
 const a=normalizePath(path.resolve('/ws/a')),b=normalizePath(path.resolve('/ws/b'));
 const differing=configurationFor([a,b],{workspace:{buildConfiguration:'Debug'},folder:{[a]:{buildConfiguration:'Release',testArguments:['--x']}}});
 assert.equal(differing.configuration,'Debug');assert.deepEqual(plain(differing.testArguments),[]);
 assert.deepEqual(plain(differing.folderConflicts),['testy.buildConfiguration','testy.testArguments']);
 const agreeing=configurationFor([a,b],{folder:{[a]:{buildConfiguration:'Release'},[b]:{buildConfiguration:'Release'}}});
 assert.equal(agreeing.configuration,'Release','folders that agree use their value');assert.deepEqual(plain(agreeing.folderConflicts),[]);
});

test('a folder-scoped solution limits only the entry points inside its folder',async t=>{
 const dir=normalizePath(await fs.mkdtemp(path.join(os.tmpdir(),'testy-folder-solution-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const a=path.join(dir,'a'),b=path.join(dir,'b');
 const found=[path.join(a,'One','One.csproj'),path.join(a,'Two','Two.csproj'),path.join(b,'Three','Three.csproj')].map(normalizePath);
 await fs.mkdir(a,{recursive:true});
 await fs.writeFile(path.join(a,'A.sln'),`Project("{X}") = "One", "One/One.csproj", "{G1}"\n`);
 const filtered=await filterEntryPoints(found,{solutions:[{file:path.join(a,'A.sln'),root:a}]},[a,b]);
 assert.deepEqual(filtered.entryPoints,[found[0],found[2]]);
 assert.deepEqual(filtered.inputs,[normalizePath(path.join(a,'A.sln'))]);
});
