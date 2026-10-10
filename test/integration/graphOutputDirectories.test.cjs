const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {evaluateProjects}=require('../../out/services/projects');
const {normalizePath}=require('../../out/core/paths');

const analyzer=path.resolve('dist/analyzer/Testy.Analysis.dll');
/** @param {import('node:test').TestContext} t */
async function copy(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-graph-paths-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.cp(path.resolve('test/fixtures/ImpactDemo'),root,{recursive:true,filter:file=>!/(^|[/\\])(bin|obj|TestResults)([/\\]|$)/.test(file)});
 return root;
}
/** @param {Iterable<string>} values */
const ordinal=values=>[...values].sort((left,right)=>left<right?-1:left>right?1:0);

test('output directories name the real obj and bin directories and lists are ordinally sorted',{timeout:90000},async t=>{
 const root=await copy(t),tests=path.join(root,'ImpactDemo.Tests','ImpactDemo.Tests.csproj');
 const graph=/** @type {readonly import('../../out/core/model').Project[]} */ ((await evaluateProjects('dotnet',[tests],'Debug',{cwd:root},analyzer,2)).get(normalizePath(tests)));
 assert.ok(graph.length>=2);
 for(const project of graph){
  const directory=normalizePath(path.dirname(project.file));
  const outputs=/** @type {readonly string[]} */ (project.outputDirectories);
  assert.ok(outputs.includes(`${directory}/obj`),`obj in ${outputs}`);
  assert.ok(outputs.includes(`${directory}/bin/Debug/net10.0`),`bin in ${outputs}`);
  assert.ok(outputs.every(entry=>!entry.includes('\\')&&!entry.endsWith('/')),`normalized ${outputs}`);
  assert.deepEqual(project.references,ordinal(project.references));
 }
});

test('MSBuild values written with backslashes resolve to real paths',{timeout:90000},async t=>{
 const root=await copy(t),file=path.join(root,'ImpactDemo','ImpactDemo.csproj');
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace('</Project>',
  '<PropertyGroup><OutputPath>artifacts\\out\\</OutputPath><CodeAnalysisRuleSet>rules\\Custom.ruleset</CodeAnalysisRuleSet></PropertyGroup>'
  +'<ItemGroup><Reference Include="Vendor"><HintPath>lib\\Vendor.dll</HintPath></Reference></ItemGroup></Project>'));
 const [project]=/** @type {readonly import('../../out/core/model').Project[]} */ ((await evaluateProjects('dotnet',[file],'Debug',{cwd:root},analyzer,1)).get(normalizePath(file)));
 const directory=normalizePath(path.dirname(file));
 assert.ok(/** @type {readonly string[]} */ (project.outputDirectories).includes(`${directory}/artifacts/out/net10.0`),`${project.outputDirectories}`);
 assert.deepEqual(project.binaryReferences,[`${directory}/lib/Vendor.dll`]);
 assert.ok(/** @type {readonly string[]} */ (project.inputs).includes(`${directory}/rules/Custom.ruleset`),'rule set candidate');
});

test('portable symbol locations use the camelCase response contract',{timeout:60000},async t=>{
 const {sourceLocations}=require('../../out/services/analysis');
 const storage=await fs.mkdtemp(path.join(os.tmpdir(),'testy-locations-'));t.after(()=>fs.rm(storage,{recursive:true,force:true}));
 const locations=await sourceLocations('dotnet',analyzer,analyzer,storage,{cwd:storage});
 const read=locations.get('Testy.Analysis.SourceLocations.Read');
 assert.ok(read&&read.line>0&&/SourceLocations\.cs$/.test(read.file),JSON.stringify([...locations].slice(0,3)));
});
