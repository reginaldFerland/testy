const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ProjectIndex,selectTests}=require('../../out/core/selection');

/** @typedef {import('../../out/core/model').Project} Project */
/** @typedef {import('../../out/core/model').TestFile} TestFile */
/** @typedef {import('../../out/core/model').Trace} Trace */
/** @typedef {import('../../out/core/selection').Selection} Selection */
/** @typedef {import('../../out/core/selection').SelectionCause} SelectionCause */
/** @typedef {import('../../out/core/selection').FallbackReason} FallbackReason */
/** @typedef {{kind:SelectionCause['kind'],reason:FallbackReason|undefined,files:string[],count:number}} CauseEntry */

// The per-change selection before test files were indexed by project, kept verbatim as the oracle.
const maxCauseFiles=3;
/** @type {Readonly<Record<SelectionCause['kind'],number>>} */
const causePriority={covers:0,edited:1,fallback:2,baseline:3,manual:3,all:3,pinned:3,failing:3};
class CauseLog {
 constructor(){/** @type {Map<string,Map<string,CauseEntry>>} */ this.entries=new Map();}
 /** @param {TestFile} group @param {SelectionCause['kind']} kind @param {string} change @param {FallbackReason} [reason] */
 add(group,kind,change,reason){
  let byKind=this.entries.get(group.id);
  if(!byKind){byKind=new Map();this.entries.set(group.id,byKind);}
  const key=reason?`${kind}:${reason}`:kind;
  let entry=byKind.get(key);
  if(!entry){entry={kind,reason,files:[],count:0};byKind.set(key,entry);}
  if(entry.files.length<maxCauseFiles)entry.files.push(change);
  entry.count++;
 }
 /** @param {ReadonlySet<string>} selected */
 build(selected){
  /** @type {Map<string,SelectionCause>} */ const causes=new Map();
  for(const [id,byKind]of this.entries){
   if(!selected.has(id))continue;
   /** @type {CauseEntry|undefined} */ let best;
   for(const entry of byKind.values()){const kind=/** @type {SelectionCause['kind']} */ (entry.kind);if(!best||causePriority[kind]<causePriority[best.kind])best=entry;}
   if(best)causes.set(id,{kind:best.kind,files:best.files,more:best.count-best.files.length,...best.reason?{reason:best.reason}:{}});
  }
  return causes;
 }
}
/**
 * @param {readonly TestFile[]} groups @param {ReadonlyMap<string,Trace>} traces @param {readonly string[]} changes
 * @param {ReadonlySet<string>} conservativeChanges @param {ProjectIndex} index
 * @param {((file:string)=>ReadonlySet<string>)|undefined} dependencies @param {((project:string)=>ReadonlySet<string>)|undefined} modules
 * @returns {Selection}
 */
function oracle(groups,traces,changes,conservativeChanges,index,dependencies,modules){
 if(!changes.length)return{groups:[],reason:'No pending changes',fallback:false,causes:new Map()};
 const selected=new Set(),log=new CauseLog();
 let fallback=false;
 for(const change of changes){
  const observed=dependencies?.(change);
  const projectsForChange=index.affected([change]);
  const coarse=new Set();
  for(const project of projectsForChange){
   for(const id of modules?.(project)??groups.filter(group=>traces.get(group.id)?.moduleProjects?.includes(project)).map(group=>group.id))coarse.add(id);
  }
  const mapped=groups.filter(group=>(group.file??group.project)===change
   ||coarse.has(group.id)||(observed?observed.has(group.id):traces.get(group.id)?.dependencies.includes(change)));
  if(coarse.size)fallback=true;
  for(const group of mapped)projectsForChange.add(group.project);
  if(!mapped.length&&!projectsForChange.size)continue;
  const configuration=index.isConfiguration(change);
  const broad=configuration||conservativeChanges.has(change)||mapped.length===0;
  /** @type {FallbackReason} */ const broadReason=configuration?'configuration':conservativeChanges.has(change)?'unanalyzed':'unmapped';
  if(broad)fallback=true;
  for(const group of mapped)log.add(group,(group.file??group.project)===change?'edited':'covers',change);
  if(broad&&!groups.some(group=>projectsForChange.has(group.project))){
   for(const group of groups){selected.add(group.id);log.add(group,'fallback',change,'unobserved');}
  }
  const mappedIds=new Set(mapped.map(group=>group.id));
  for(const group of groups){
   if(!projectsForChange.has(group.project))continue;
   const trace=traces.get(group.id);
   if(broad||mappedIds.has(group.id)||!group.file||!trace?.reliable)selected.add(group.id);
   if(!mappedIds.has(group.id)){
    if(broad)log.add(group,'fallback',change,broadReason);
    else if(!group.file||!trace?.reliable)log.add(group,'fallback',change,'untraced');
   }
   if(!trace?.reliable||!group.file)fallback=true;
  }
 }
 return{groups:groups.filter(group=>selected.has(group.id)),reason:fallback?'Affected files with conservative project fallback':'Files that exercised the changed code',fallback,causes:log.build(selected)};
}

test('indexed selection matches the per-change algorithm on random workspaces',()=>{
 let seed=0x6d2b79f5;
 const random=(/** @type {number} */ limit)=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%limit;};
 /** @template T @param {readonly T[]} values @returns {T} */
 const pick=values=>/** @type {T} */ (values[random(values.length)]);
 for(let round=0;round<1500;round++){
  const projectCount=1+random(7),files=/** @type {string[]} */ ([]);
  // Nested directories give directory ownership and project-relative unknown files.
  const projects=/** @type {Project[]} */ (/** @type {any} */ (Array.from({length:projectCount},(_,p)=>{
   const directory=p&&random(3)===0?`/w/P${random(p)}/Sub${p}`:`/w/P${p}`;
   const sourceFiles=Array.from({length:1+random(5)},(_,i)=>`${directory}/F${i}.cs`);files.push(...sourceFiles);
   return{file:`${directory}/P${p}.csproj`,sourceFiles,references:[],inputs:random(4)?[]:[`${directory}/data.json`]};
  }))); // partial mocks: only the fields selection and its index read
  for(const project of projects)for(let r=0;r<random(3);r++){const other=projects[random(projectCount)];if(other!==project&&random(2))/** @type {string[]} */ (project.references).push(/** @type {Project} */ (other).file);}
  const ids=Array.from({length:random(30)},(_,i)=>`g${random(4)===0?random(i+1):i}`); // occasional duplicate IDs
  const groups=/** @type {TestFile[]} */ (/** @type {any} */ (ids.map(id=>{const project=pick(projects);return{id,project:project.file,file:random(6)?pick(project.sourceFiles):undefined,tests:[]};})));
  const traces=new Map(),candidates=[...files,'/w/shared.txt',...projects.map(project=>project.file)];
  for(const id of new Set(ids))if(random(5))traces.set(id,{groupId:id,dependencies:Array.from({length:random(5)},()=>pick(candidates)),moduleProjects:random(4)?undefined:[pick(projects).file],coverage:[],reliable:random(4)!==0,timestamp:1});
  const changes=Array.from({length:random(16)},()=>pick([...candidates,...groups.map(group=>group.file??group.project),'/w/Directory.Build.props','/w/package.json','/w/P0/unknown.txt','/elsewhere/x.cs',`/w/P${random(9)}/data.json`]));
  const conservative=new Set(changes.filter(()=>random(4)===0)),evaluated=new Set(random(3)?[]:[pick(candidates)]),index=new ProjectIndex(projects,evaluated);
  const byDependency=new Map();for(const [id,trace]of traces)for(const file of trace.dependencies){const set=byDependency.get(file)??new Set();set.add(id);byDependency.set(file,set);}
  const byModule=new Map();for(const [id,trace]of traces)for(const project of trace.moduleProjects??[]){const set=byModule.get(project)??new Set();set.add(id);byModule.set(project,set);}
  const indexed=random(2)===0,dependencies=indexed?(/** @type {string} */ file)=>new Set([...byDependency.get(file)??[],...random(5)?[]:['ghost']]):undefined;
  const modules=indexed&&random(2)?(/** @type {string} */ project)=>byModule.get(project)??new Set():undefined;
  const expected=oracle(groups,traces,changes,conservative,new ProjectIndex(projects,evaluated),dependencies,modules);
  const actual=selectTests(groups,projects,traces,changes,'affected',false,conservative,index,dependencies,modules);
  assert.deepEqual(actual.groups.map(group=>group.id),expected.groups.map(group=>group.id),`round ${round} groups`);
  assert.equal(actual.reason,expected.reason,`round ${round} reason`);assert.equal(actual.fallback,expected.fallback);
  assert.deepEqual(actual.causes,expected.causes,`round ${round} causes`);
  // A shared index answers repeated selections the same way after memoizing closures.
  assert.deepEqual(selectTests(groups,projects,traces,changes,'affected',false,conservative,index,dependencies,modules),actual);
 }
});
