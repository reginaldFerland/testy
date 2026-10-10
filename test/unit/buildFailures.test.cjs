const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadUi}=require('./support/ui.cjs');

class MarkdownString{
 constructor(value=''){this.value=value;}
 appendCodeblock(code,language){this.value+=`\n\`\`\`${language}\n${code}\n\`\`\`\n`;return this;}
 appendText(text){this.value+=text;return this;}
 appendMarkdown(text){this.value+=text;return this;}
}

/** A tree with two test projects, built through the real presenter. */
async function fixture() {
 const collection=()=>({values:[],replace(values){this.values=[...values];},add(value){this.values.push(value);}});
 const ui=loadUi({vscode:{MarkdownString,TestRunRequest:class{},Uri:{file:fsPath=>({fsPath})},Range:class{}}});
 const controller={items:collection(),createTestItem:(id,label,uri)=>({id,label,uri,tags:[],children:collection()}),invalidateTestResults(){}};
 const tree=new ui.TestTree(controller,{knownTests:group=>group.tests},{disposed:false,activeRun:undefined,roots:[],updateStatus(){}});
 const group=project=>({id:`${project}:a`,project:`/w/${project}/${project}.csproj`,framework:'net10.0',file:`/w/${project}/A.cs`,tests:[{id:'t',name:'t',file:`/w/${project}/A.cs`,line:1}]});
 await tree.update([group('One'),group('Two')]);
 return{ui,tree,one:tree.items.get('project:/w/One/One.csproj'),two:tree.items.get('project:/w/Two/Two.csproj')};
}
const error=(project,message='Missing semicolon',extra={})=>({file:`/w/${project}/A.cs`,line:3,column:7,severity:'error',code:'CS1002',message,project:project&&`/w/${project}/${project}.csproj`,...extra});

test('build errors mark the failing project and leave the others untouched',async()=>{
 const f=await fixture();
 f.tree.showBuildFailures([error('One'),error('One','Second',{line:9}),{...error('One'),severity:'warning',message:'ignored'}],'The build failed.');
 assert.match(f.one.error.value,/Build failed/);assert.match(f.one.error.value,/A\.cs\(3,7\): CS1002: Missing semicolon/);assert.match(f.one.error.value,/Second/);
 assert.doesNotMatch(f.one.error.value,/ignored/);
 assert.match(f.one.error.value,/\(command:testy\.showOutput\)/);assert.deepEqual([...f.one.error.isTrusted.enabledCommands],['testy.showOutput']);
 assert.equal(f.two.error,undefined);
});

test('errors without a test project mark every project, and a message without diagnostics falls back to the run error',async()=>{
 const f=await fixture();
 f.tree.showBuildFailures([error('One'),error(undefined,'Shared library failed',{project:'/w/Lib/Lib.csproj'})],'x');
 assert.match(f.one.error.value,/Missing semicolon/);assert.match(f.one.error.value,/Shared library failed/);
 assert.match(f.two.error.value,/Shared library failed/);assert.doesNotMatch(f.two.error.value,/Missing semicolon/);
 f.tree.showBuildFailures([],'dotnet exited with code 1');
 assert.match(f.one.error.value,/dotnet exited with code 1/);assert.match(f.two.error.value,/dotnet exited with code 1/);
});

test('long error lists are truncated and each failure replaces the previous ones',async()=>{
 const f=await fixture();
 f.tree.showBuildFailures(Array.from({length:14},(_,i)=>error('One',`Problem ${i}`,{line:i+1})),'x');
 assert.match(f.one.error.value,/Problem 9/);assert.doesNotMatch(f.one.error.value,/Problem 10/);assert.match(f.one.error.value,/…and 4 more/);
 f.tree.showBuildFailures([error('Two')],'x');
 assert.equal(f.one.error,undefined,'a project that no longer fails is cleared');assert.match(f.two.error.value,/Missing semicolon/);
});

test('a successful build clears the errors of every project',async()=>{
 const f=await fixture();
 f.tree.showBuildFailures([],'broken');assert.ok(f.one.error&&f.two.error);
 f.tree.clearBuildFailures();assert.equal(f.one.error,undefined);assert.equal(f.two.error,undefined);
});

/** Runs `execute` against a stub engine that reaches the build phase and then fails or succeeds. */
async function execute(t,{fail,aborted=false}) {
 const f=await fixture(),calls=[];
 const proto=f.ui.Testy.prototype;
 const run={token:{onCancellationRequested:()=>({dispose(){}})},end(){},appendOutput(){}};
 const abort=new AbortController();
 const context={changes:{flush:async()=>{}},controller:{createTestRun:()=>run},runProfile:{},coverageProfile:{},debugProfile:{},config:{coverage:false},continuousCoverage:new Set(),runName:()=>'Testy',coverage:{beginRun(){}},
  tree:{showBuildFailures:(diagnostics,fallback)=>calls.push(['show',[...diagnostics].map(d=>d.code),fallback]),clearBuildFailures:()=>calls.push(['clear'])},
  diagnostics:{items:new Map(),begin(){this.items=new Map();},flush(){},get values(){return this.items.values();},publish:()=>calls.push(['diagnostics'])},output:{info(){},warn(){}},lastError:'',updateStatus(){},
  reportError(error){context.lastError=error.message;}};
 context.engine={run:async()=>{
  context.build='building';context.diagnostics.items.set('k',error('One'));
  if(aborted)abort.abort();
  if(!fail)context.build='built';
  else throw new Error('Build failed');
  return{passed:0,failed:0,skipped:0,duration:0,failedBatches:0};
 }};
 await proto.execute.call(context,{files:[],full:false},abort.signal).catch(()=>undefined);
 return calls;
}

test('a failed build marks the projects in Test Explorer alongside the Problems entries',async t=>{
 assert.deepEqual(await execute(t,{fail:true}),[['diagnostics'],['show',['CS1002'],'Build failed']]);
});

test('a cancelled build leaves earlier markers alone and a successful build clears them',async t=>{
 assert.deepEqual(await execute(t,{fail:true,aborted:true}),[]);
 assert.deepEqual(await execute(t,{fail:false}),[['diagnostics'],['clear']]);
});
