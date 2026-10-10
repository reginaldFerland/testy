const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');
const {normalizePath}=require('../../out/core/paths');

/** A list of known inputs that fails the test if anything scans it linearly. */
function guarded(files) {
 const list=[...files];
 for(const method of ['includes','some','filter','find','indexOf','every','findIndex'])list[method]=()=>{throw new Error(`known inputs scanned with ${method}`);};
 return list;
}

test('bursts of file events never scan the known inputs linearly',async()=>{
 const root=normalizePath('/testy-burst-workspace'),external=normalizePath('/testy-burst-external');
 const projects=Array.from({length:500},(_,i)=>`${root}/proj${i}/Proj${i}.csproj`);
 const files=[...projects,...Array.from({length:20000},(_,i)=>`${root}/proj${i%500}/Dir${i}/File${i}.json`),`${external}/lib/Shared.props`];
 const directories=[...new Set(files.map(file=>file.slice(0,file.lastIndexOf('/'))))];
 const engine={inputVersion:1,knownFiles:guarded(files),directories,markChanged:async()=>{}},requests=[];
 const ui=loadUi();
 const context={disposed:false,roots:[root],config:{excludes:[],pattern:'**/*.{csproj,props}'},engine,scheduler:{request:(...args)=>requests.push(args)},queueChanged(){}};
 const changed=(file,directory=false)=>ui.changeWatcher(context).changed({scheme:'file',fsPath:file},undefined,directory);
 for(const project of projects)await changed(project);
 assert.equal(requests.length,projects.length,'known inputs inside the workspace trigger once per event');
 requests.length=0;
 await changed(`${external}/lib/Shared.props`);await changed(`${external}/lib/Other.props`);await changed(`${external}/unrelated/Other.props`);
 assert.equal(requests.length,2,'known and sibling files of external inputs trigger; unrelated external files do not');
 requests.length=0;
 for(let i=0;i<500;i++)await changed(`${root}/proj${i}`,true);
 assert.equal(requests.length,500);
 const [first,full]=requests[7];
 assert.equal(full,true,'directory events request structural discovery');
 assert.equal(first.length,1+1+40,'a directory event carries its known descendants and itself');
 assert.ok(first.every(file=>file===`${root}/proj7`||file.startsWith(`${root}/proj7/`)));
});

test('the cached index follows the engine when its inputs change',async()=>{
 const root=normalizePath('/testy-index-workspace'),requests=[];
 const engine={inputVersion:1,knownFiles:[],directories:[],markChanged:async()=>{}};
 const ui=loadUi();
 const context={disposed:false,roots:[root],config:{excludes:[],pattern:'**/*.cs'},engine,scheduler:{request:(...args)=>requests.push(args)},queueChanged(){}};
 const outside={scheme:'file',fsPath:normalizePath('/testy-index-external/Extra.props')};
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,0,'an unknown external file is ignored');
 engine.inputVersion++;engine.knownFiles=[outside.fsPath];engine.directories=[normalizePath('/testy-index-external')];
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,1,'a newly known input is recognized');
 engine.inputVersion++;engine.knownFiles=[];engine.directories=[];
 await ui.changeWatcher(context).changed(outside);assert.equal(requests.length,1,'a retired input is ignored again');
});
