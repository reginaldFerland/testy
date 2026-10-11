const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {findProjects,sdkContextGroups,buildWaves,buildSnapshotTargets,buildOrder,buildRoots,mergeProjects,
 restoreProjects,evaluateProjects,buildProjects,refreshProjectSnapshotBatches}=require('../../out/services/projects');
const {normalizePath}=require('../../out/core/paths');

/** @typedef {import('../../out/core/model').Project} Project */

/** @param {import('node:test').TestContext} t */
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-project-parallel-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
/** @param {string} name @param {string[]} [references] @param {Partial<Project>} [extra] @returns {Project} */
function node(name,references=[],extra={}){
 // A partial project: only the fields the build planner reads are populated.
 return /** @type {Project} */ (/** @type {unknown} */ ({file:`/workspace/${name}/${name}.csproj`,framework:'net10.0',assembly:`/workspace/${name}/bin/${name}.dll`,
  sourceFiles:[],references:[],contextId:name,contextReferences:references,entryPoint:true,
  outputDirectories:[`/workspace/${name}/bin`,`/workspace/${name}/obj`],...extra}));
}

test('project traversal overlaps directory reads within its bound and deduplicates overlapping roots',async t=>{
 const root=await temporary(t);
 for(let i=0;i<12;i++){const directory=path.join(root,String(i));await fs.mkdir(directory);await fs.writeFile(path.join(directory,'A.csproj'),'');}
 await fs.mkdir(path.join(root,'obj'));await fs.writeFile(path.join(root,'obj','Excluded.csproj'),'');
 // The overloaded readdir is wrapped generically, so it is viewed as a plain function.
 const read=/** @type {(...args: any[]) => any} */ (fs.readdir),seen=new Map();let active=0,peak=0;
 fs.readdir=/** @param {any[]} args */ async(...args)=>{active++;peak=Math.max(peak,active);seen.set(args[0],(seen.get(args[0])??0)+1);try{await delay(5);return await read(...args);}finally{active--;}};
 try{
  const projects=await findProjects([root,path.join(root,'0')],undefined,undefined,3);
  assert.equal(projects.length,12);assert.deepEqual(projects,[...projects].sort());assert.ok(peak>1&&peak<=3);
  assert.equal(seen.get(path.join(root,'0')),1);assert.equal(seen.has(path.join(root,'obj')),false);assert.equal(active,0);
  const abort=new AbortController();let reads=0;
  fs.readdir=/** @param {any[]} args */ async(...args)=>{if(++reads===3){abort.abort();}await delay(5);return read(...args);};
  await assert.rejects(findProjects([root],undefined,abort.signal,2),{name:'AbortError'});
  assert.ok(reads<=3,'cancellation stops queued directory reads');
 }finally{fs.readdir=read;}
});

test('SDK grouping preserves nested pins and shares unpinned sibling directories',async t=>{
 const root=await temporary(t),nested=path.join(root,'nested');await fs.mkdir(nested);
 await fs.writeFile(path.join(root,'global.json'),'{}');await fs.writeFile(path.join(nested,'global.json'),'{}');
 const files=[path.join(root,'A','A.csproj'),path.join(root,'B','B.csproj'),path.join(nested,'C','C.csproj')];
 const groups=await sdkContextGroups(files);assert.equal(groups.length,2);
 assert.deepEqual(groups[0].files,files.slice(0,2));assert.equal(groups[0].key,normalizePath(path.join(root,'global.json')));
 assert.deepEqual(groups[1].files,[files[2]]);assert.equal(groups[1].key,normalizePath(path.join(nested,'global.json')));
});

test('compatible build roots share a wave while alternate contexts and SDK hosts stay ordered',()=>{
 const core=node('Core'),web=node('Web',['Core']),a=node('TestsA',['Web']),b=node('TestsB',['Web']);
 assert.deepEqual(buildWaves([core,web,a,b],[a,b]).map(wave=>wave.map(project=>project.contextId)),[['TestsA','TestsB']]);
 const alternate={...core,contextId:'CoreSpecial'},special=node('TestsSpecial',['CoreSpecial']);
 assert.deepEqual(buildWaves([core,alternate,web,a,special],[a,special]).map(wave=>wave.map(project=>project.contextId)),[['TestsA'],['TestsSpecial']]);
 assert.deepEqual(buildWaves([core,web,a,b],[a,b],new Map([[a.file,'sdk-a'],[b.file,'sdk-b']])).map(wave=>wave.length),[1,1]);
 const independent=node('Unrelated');
 assert.deepEqual(buildWaves([a,independent],[a,independent],new Map([[a.file,'sdk-a'],[independent.file,'sdk-b']])).map(wave=>wave.length),[2]);
});

test('build conflict planning canonicalizes each output path once across a wide shared graph',()=>{
 const sync=require('node:fs'),realpath=/** @type {(...args: any[]) => any} */ (sync.realpathSync.native);let calls=0;
 const shared=node('Shared'),roots=Array.from({length:30},(_,i)=>node(`Tests${i}`,['Shared']));
 sync.realpathSync.native=/** @param {any[]} args */ (...args)=>{calls++;return realpath(...args);};
 try{assert.equal(buildWaves([shared,...roots],roots).length,1);assert.ok(calls<500,`${calls} filesystem calls for 31 projects`);}
 finally{sync.realpathSync.native=realpath;}
});

test('binary readers finish before conflicting producers and nested outputs get snapshots',()=>{
 const producer=node('Library'),consumer=node('Consumer',[],{isTestProject:true,binaryReferences:[producer.assembly]});
 const alternate={...producer,contextId:'LibrarySpecial'},other=node('Other',['LibrarySpecial']);
 assert.deepEqual(buildWaves([producer,consumer,alternate,other],[producer,consumer,other]).map(wave=>wave.map(project=>project.contextId)),[['Library'],['Consumer'],['Other']]);
 const parent=node('Tests',[],{isTestProject:true}),nested=node('Nested',[],{assembly:'/workspace/Tests/bin/nested/Nested.dll',outputDirectories:['/workspace/Tests/bin/nested']});
 assert.deepEqual([...buildSnapshotTargets([parent,nested],[parent])],[`${parent.file}\0net10.0`]);
 assert.equal(buildSnapshotTargets([parent,parent],[parent]).size,0);
});

test('snapshot batches refresh shared changes in waves without evaluating unchanged siblings',async()=>{
 const shared=node('Shared'),roots=[node('A',['Shared']),node('B',['Shared']),node('C',['Shared'])];
 const previous=new Map(roots.map(root=>[root.file,[root,shared]]));
// assert.deepEqual narrows calls to mutable arrays, so the readonly inputs are viewed as mutable when recorded.
 /** @type {string[][]} */
 const calls=[];
 await refreshProjectSnapshotBatches(previous,[...previous.keys()],[roots[0].file],async files=>{calls.push(/** @type {string[]} */ (files));return new Map(files.map(file=>[file,/** @type {Project[]} */ (previous.get(file))]));});
 assert.deepEqual(calls,[[roots[0].file]]);calls.length=0;
 const next=await refreshProjectSnapshotBatches(previous,[...previous.keys()],[roots[0].file],async files=>{
  calls.push(/** @type {string[]} */ (files));return new Map(files.map(file=>[file,/** @type {Project[]} */ (previous.get(file)).map(project=>project===shared?{...project,sourceFiles:['new.cs']}:project)]));
 });
 assert.deepEqual(calls,[[roots[0].file],[roots[1].file,roots[2].file]]);assert.ok([...next.values()].every(graph=>graph[1].sourceFiles[0]==='new.cs'));
 calls.length=0;await refreshProjectSnapshotBatches(previous,[...previous.keys()],undefined,async files=>{calls.push(/** @type {string[]} */ (files));return previous;});
 assert.deepEqual(calls,[[...previous.keys()]]);
});

test('batched restore, inspection and build reuse a deep shared graph',{timeout:90000},async t=>{
 const root=await temporary(t),counter=path.join(root,'compiled.txt');
 const links={Core:[],App:['Core'],Infra:['App'],Web:['Infra'],TestsA:['Web'],TestsB:['Web']},files=[];
 for(const [name,references] of Object.entries(links)){
  const directory=path.join(root,name);await fs.mkdir(directory);const file=normalizePath(path.join(directory,`${name}.csproj`));files.push(file);
  await fs.writeFile(file,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>${references.map(reference=>`<ProjectReference Include="../${reference}/${reference}.csproj"/>`).join('')}</ItemGroup></Project>`);
  await fs.writeFile(path.join(directory,`${name}.cs`),`public class ${name} {}`);
 }
 await fs.writeFile(path.join(root,'Directory.Build.targets'),`<Project><Target Name="CountCompilation" BeforeTargets="CoreCompile"><WriteLinesToFile File="${counter}" Lines="$(MSBuildProjectName)" Overwrite="false"/></Target></Project>`);
 const options={cwd:root,signal:new AbortController().signal,timeoutMs:60000};
 await restoreProjects('dotnet',files,'Debug',options,2);
 const snapshots=await evaluateProjects('dotnet',files,'Debug',options,path.resolve('dist/analyzer/Testy.Analysis.dll'),2);
 assert.deepEqual([...snapshots.values()].map(graph=>graph.length),[1,2,3,4,5,5]);
 for(const [file,graph] of snapshots){assert.deepEqual(graph.filter(project=>project.entryPoint).map(project=>project.file),[file]);assert.ok(graph.every(project=>/** @type {readonly string[]} */ (project.outputDirectories).some(directory=>directory.includes('/obj'))));}
 const projects=mergeProjects([...snapshots.values()].flat()),order=buildOrder(projects,new Set(files)),roots=buildRoots(order);
 assert.equal(new Set([...snapshots.values()].flat().map(project=>project.contextId)).size,6);
 assert.deepEqual(new Set(roots.map(project=>project.file)),new Set(['TestsA','TestsB'].map(name=>normalizePath(path.join(root,name,`${name}.csproj`)))));
 assert.equal(buildWaves(order,roots).length,1);
 await buildProjects('dotnet',roots,'Debug',options,2);
 const compiled=(await fs.readFile(counter,'utf8')).trim().split(/\r?\n/);
 assert.equal(compiled.length,6,'every shared project is compiled only once in the batch');assert.equal(new Set(compiled).size,6);
});

test('a slow directory delays only its own subtree, not the rest of its level',async t=>{
 const root=await temporary(t),slow=path.join(root,'slow'),fast=path.join(root,'fast','deep');
 await fs.mkdir(slow);await fs.mkdir(fast,{recursive:true});await fs.writeFile(path.join(slow,'S.csproj'),'');await fs.writeFile(path.join(fast,'F.csproj'),'');
 const read=/** @type {(...args: any[]) => any} */ (fs.readdir);let release=()=>{};const gate=new Promise(resolve=>{release=()=>resolve(undefined);});let reachedDeep=false;
 fs.readdir=/** @param {any[]} args */ async(...args)=>{
  if(args[0]===slow)await gate;
  if(args[0]===fast){reachedDeep=true;release();}
  return read(...args);
 };
 try{
  // Level-by-level traversal would wait for 'slow' before reading 'fast/deep', and never release it.
  const projects=await findProjects([root],undefined,undefined,4);
  assert.ok(reachedDeep);assert.deepEqual(projects.map(file=>path.basename(file)),['F.csproj','S.csproj']);
 }finally{fs.readdir=read;release();}
});

test('a root that another root references builds once, as the same instance its reference builds',{timeout:90000},async t=>{
 const root=await temporary(t),counter=path.join(root,'compiled.txt'),files=[];
 for(const [name,references] of Object.entries({Tests:[],Consumer:['Tests']})){
  const directory=path.join(root,name);await fs.mkdir(directory);const file=normalizePath(path.join(directory,`${name}.csproj`));files.push(file);
  await fs.writeFile(file,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>${references.map(reference=>`<ProjectReference Include="../${reference}/${reference}.csproj"/>`).join('')}</ItemGroup></Project>`);
  await fs.writeFile(path.join(directory,`${name}.cs`),`public class ${name} {}`);
 }
 // Runs once per project instance, even when the compilation itself is up to date.
 await fs.writeFile(path.join(root,'Directory.Build.targets'),`<Project><Target Name="CountInstance" BeforeTargets="CoreCompile"><WriteLinesToFile File="${counter}" Lines="$(MSBuildProjectName)" Overwrite="false"/></Target></Project>`);
 const options={cwd:root,signal:new AbortController().signal,timeoutMs:60000};
 await restoreProjects('dotnet',files,'Debug',options,2);
 const snapshots=await evaluateProjects('dotnet',files,'Debug',options,path.resolve('dist/analyzer/Testy.Analysis.dll'),2);
 const projects=mergeProjects([...snapshots.values()].flat());
 await buildProjects('dotnet',projects,'Debug',options,2);
 const built=(await fs.readFile(counter,'utf8')).trim().split(/\r?\n/).sort();
 assert.deepEqual(built,['Consumer','Tests'],'two instances of Tests would write its outputs in parallel');
});
