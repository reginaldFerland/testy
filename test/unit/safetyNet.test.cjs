const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createTesty}=require('./support/controller.cjs');
const {ProjectIndex}=require('../../out/core/selection');
const {normalizePath}=require('../../out/core/paths');

const p=(/** @type {string} */ file)=>normalizePath(`/workspace/${file}`);
// Fixtures carry only the fields the safety net reads, so they are cast to the full model types.
const projects=/** @type {any[]} */ ([
 {file:p('App/App.csproj'),sourceFiles:[p('App/Calc.cs')],references:[]},
 {file:p('TestsA/TestsA.csproj'),sourceFiles:[p('TestsA/A1.cs'),p('TestsA/A2.cs')],references:[p('App/App.csproj')]},
 {file:p('TestsB/TestsB.csproj'),sourceFiles:[p('TestsB/B1.cs')],references:[]}
]);
const group=(/** @type {string} */ id,/** @type {string} */ project,/** @type {Record<string, unknown>} */ extra={})=>({id,project:p(project),framework:'net10.0',file:p(`${project.split('/')[0]}/${id}.cs`),tests:[{id:`${id}.t`},{id:`${id}.u`}],...extra});

/** @param {'off' | 'related' | 'all'} safetyNet */
function fixture(safetyNet){
 const f=createTesty({configuration:{safetyNet,mode:'affected'}});
 /** @type {any} */ const testy=f.testy;
 testy.engine.groups=[group('A1','TestsA/TestsA.csproj'),group('A2','TestsA/TestsA.csproj',{excludedTestIds:['A2.x']}),group('B1','TestsB/TestsB.csproj')];
 testy.engine.index=new ProjectIndex(projects);
 /** @type {any[]} */ const idle=[];
 testy.scheduler.setIdle=(/** @type {unknown} */ job,/** @type {number} */ delay)=>{idle.push({job,delay});};
 /** @type {any[]} */ const runs=[];
 testy.execute=async(/** @type {unknown} */ batch,/** @type {AbortSignal} */ signal,/** @type {any} */ options)=>{runs.push({batch,options});for(const id of options.manual.groups)testy.engine.lastOutcomes.record(id,{id:'t',outcome:id==='A2'?'failed':'passed'});};
 /** @type {unknown[]} */ const warnings=[];
 f.vscode.window.showWarningMessage=async(/** @type {string} */ message)=>{warnings.push(message);return undefined;};
 return {f,testy,idle,runs,warnings};
}

test('the safety net queues the other files of affected test projects and runs them when the editor is quiet',async()=>{
 const {f,testy,idle,runs,warnings}=fixture('related');
 testy.lastSelection={groups:[testy.engine.groups[0]],reason:'impact',fallback:false,causes:new Map([['A1',{kind:'covers',files:[],more:0}]])};
 testy.queueSafetyNet([p('App/Calc.cs')]);
 assert.deepEqual([...testy.safetyPending],['A2'],'B1 is in a project the change does not affect; A1 already ran');
 assert.equal(idle.at(-1).delay,2000);
 await idle.at(-1).job(new AbortController().signal);
 assert.deepEqual([...runs[0].options.manual.groups],['A2']);
 assert.deepEqual([...runs[0].options.manual.tests.get('A2')],['A2.t','A2.u'],'excluded traits stay out, as in automatic runs');
 assert.equal(testy.safetyPending.size,0);
 assert.ok(f.output.some(line=>/Safety net: A2\.cs now fails, but no change selected it/.test(line)),'a file that newly fails is reported');
 assert.equal(warnings.length,1);
 await testy.dispose();
});

test('the safety net keeps files pending across a cancelled run, drops files that ran, and stops for baselines or when off',async()=>{
 const {testy,idle,runs}=fixture('all');
 testy.lastSelection={groups:[],reason:'impact',fallback:false,causes:new Map()};
 testy.queueSafetyNet([p('App/Calc.cs')]);
 assert.deepEqual([...testy.safetyPending].sort(),['A1','A2','B1'],'`all` checks every file');
 const abort=new AbortController();abort.abort();
 await assert.rejects(idle.at(-1).job(abort.signal));
 assert.equal(testy.safetyPending.size,3,'a cancelled run keeps them pending');
 testy.lastSelection={groups:[testy.engine.groups[2]],reason:'impact',fallback:false,causes:new Map()};
 testy.queueSafetyNet([p('App/Calc.cs')]);
 assert.deepEqual([...testy.safetyPending].sort(),['A1','A2'],'a file that ran in an automatic run is no longer pending');
 assert.equal(runs.length,1);
 testy.lastSelection={groups:testy.engine.groups,reason:'Baseline',fallback:false,causes:new Map([['A1',{kind:'baseline',files:[],more:0}]])};
 testy.queueSafetyNet([]);
 assert.equal(testy.safetyPending.size,0,'a baseline ran everything');assert.equal(idle.at(-1).job,undefined);
 await testy.dispose();
 const off=fixture('off');
 off.testy.lastSelection={groups:[],reason:'impact',fallback:false,causes:new Map()};
 off.testy.queueSafetyNet([p('App/Calc.cs')]);
 assert.equal(off.testy.safetyPending.size,0);assert.equal(off.idle.at(-1).job,undefined);
 await off.testy.dispose();
});

test('a file narrowed to some of its tests stays queued for the safety net',async()=>{
 const {testy,idle}=fixture('related');
 const narrowed={...testy.engine.groups[0],tests:[testy.engine.groups[0].tests[0]]};
 testy.lastSelection={groups:[narrowed],reason:'impact',fallback:false,causes:new Map([['A1',{kind:'covers',files:[],more:0}]])};
 testy.queueSafetyNet([p('App/Calc.cs')]);
 assert.deepEqual([...testy.safetyPending].sort(),['A1','A2']);assert.ok(idle.at(-1).job);
 await testy.dispose();
});
