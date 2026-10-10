const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {normalizePath}=require('../../out/core/paths');

test('runtime module reports distinguish instrumented, external and in-memory loads, and require completion',async t=>{
 const {RuntimeObservation}=require('../../out/services/runtimeObservation');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy-observer-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const assembly=normalizePath(path.join(directory,'Tests.dll')),instrumented=normalizePath(path.join(directory,'Plugin.dll'));
 const observer=await RuntimeObservation.start(path.join(directory,'reports'),assembly,[
  {name:'Plugin',project:'/Plugin.csproj',sources:['/Plugin.cs']},{name:'plugin',project:'/Alternative.csproj',sources:['/Alternative.cs']}
 ],[instrumented],{DOTNET_STARTUP_HOOKS:'/existing/hook.dll'});
 assert.ok(/** @type {string} */ (observer.env.DOTNET_STARTUP_HOOKS).endsWith(path.delimiter+'/existing/hook.dll'));
 const encode=(/** @type {string} */ s)=>Buffer.from(s).toString('base64'),report=path.join(directory,'reports','host.log');
 const lines=(/** @type {string} */ location)=>`ready\t${encode(assembly)}\r\nmodule\t${encode('Plugin')}\t${encode(location)}\r\ncomplete\ttrue\r\n`;
 await fs.writeFile(report,lines(instrumented));assert.deepEqual(await observer.dependencies(),{files:[],projects:[]});
 for(const location of ['/original/Plugin.dll','']){
  await fs.writeFile(report,lines(location));const observed=await observer.dependencies();
  assert.deepEqual(new Set(observed.files),new Set(['/Plugin.cs','/Alternative.cs']));assert.deepEqual(new Set(observed.projects),new Set(['/Plugin.csproj','/Alternative.csproj']));
 }
 // A killed non-host process (MSBuild node, compiler server) leaves an incomplete log that must not fail the host's observation.
 await fs.writeFile(path.join(directory,'reports','child.log'),`ready\t${encode('/Child.dll')}\n`);
 assert.deepEqual(new Set((await observer.dependencies()).files),new Set(['/Plugin.cs','/Alternative.cs']));
 await fs.writeFile(path.join(directory,'reports','empty.log'),'');
 assert.deepEqual(new Set((await observer.dependencies()).files),new Set(['/Plugin.cs','/Alternative.cs']));
 await fs.writeFile(path.join(directory,'reports','child.log'),`ready\t${encode(assembly)}\n`);
 await assert.rejects(observer.dependencies(),/incomplete/);await fs.rm(path.join(directory,'reports','child.log'));await fs.rm(path.join(directory,'reports','empty.log'));
 await fs.writeFile(report,lines(instrumented).replace('complete\ttrue','complete\tfalse'));await assert.rejects(observer.dependencies(),/incomplete/);
 await fs.writeFile(report,lines(instrumented).replace(encode(assembly),encode('/Collector.dll')));await assert.rejects(observer.dependencies(),/test host/);
 await fs.writeFile(report,lines(instrumented).replace(encode('Plugin'),'invalid!'));await assert.rejects(observer.dependencies(),/Invalid/);
});

test('module dependencies cover new source files across projects and survive cache restoration',async t=>{
 const {CoverageStore}=require('../../out/core/coverage'),{CoverageCache}=require('../../out/services/cache'),{selectTests,ProjectIndex}=require('../../out/core/selection');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'testy-module-cache-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 // Partial Project and TestFile records (any): only the fields selection reads.
 /** @type {any} */ const projects=[{file:'/Plugin/Plugin.csproj',assembly:'/Plugin.dll',sourceFiles:['/Plugin/Old.cs'],references:[]},
  {file:'/Tests/Tests.csproj',assembly:'/Tests.dll',sourceFiles:['/Tests/Dynamic.cs'],references:[]}];
 /** @type {any} */ const groups=[{id:'dynamic',project:'/Tests/Tests.csproj',file:'/Tests/Dynamic.cs'}];
 const trace={groupId:'dynamic',moduleProjects:['/Plugin/Plugin.csproj'],dependencies:['/Plugin/Old.cs'],inputs:{},coverage:[],reliable:true,timestamp:0};
 const store=new CoverageStore();store.replace([trace],new Set(['dynamic']));
 const selected=(/** @type {import('../../out/core/coverage').CoverageStore} */ store)=>selectTests(groups,projects,store.traces,['/Plugin/New.cs'],'affected',false,new Set(),new ProjectIndex(projects),file=>store.dependentGroups([file]),project=>store.dependentProjects([project]));
 assert.equal(selected(store).groups.length,1);
 const cache=new CoverageCache(directory,()=>{});await cache.save(store.takeDelta());const restored=new CoverageStore();await cache.restore(restored);
 assert.deepEqual([...restored.dependentProjects(['/Plugin/Plugin.csproj'])],['dynamic']);assert.equal(selected(restored).groups.length,1);
 restored.replace([{...trace,moduleProjects:[]}],new Set(['dynamic']));assert.equal(restored.dependentProjects(['/Plugin/Plugin.csproj']).size,0);
});
