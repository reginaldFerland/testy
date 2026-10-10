const {test}=require('node:test');
const assert=require('node:assert/strict');
const {additionalConfigurations}=require('../../out/core/buildConfigurations');
const {createTesty}=require('./support/controller.cjs');

const plain=value=>JSON.parse(JSON.stringify(value));
const token={isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})};

test('additional configurations are trimmed, distinct and never repeat the automatic configuration',()=>{
 assert.deepEqual(additionalConfigurations([' Release ','release','Staging','','  ',3,null,'DEBUG','Staging'],'Debug'),['Release','Staging']);
 assert.deepEqual(additionalConfigurations([],'Debug'),[]);
});

test('each additional configuration gets non-default Run, Coverage and Debug profiles, recreated when the setting changes',async()=>{
 let changed;
 const {testy,profiles,settings}=createTesty({configuration:{additionalConfigurations:['Release']},
  workspace:{onDidChangeConfiguration:handler=>{changed=handler;return{dispose(){}};}}});
 const labels=()=>profiles.filter(profile=>!profile.disposed).map(profile=>profile.label);
 assert.deepEqual(labels(),['Run','Run with coverage','Debug','Run (Release)','Run with coverage (Release)','Debug (Release)']);
 const release=profiles.filter(profile=>profile.label.endsWith('(Release)'));
 assert.deepEqual(release.map(profile=>[profile.kind,profile.isDefault]),[[1,false],[3,false],[2,false]]);
 assert.equal(typeof release[1].loadDetailedCoverage,'function','coverage detail loads through extra coverage profiles too');
 assert.equal(typeof release[1].loadDetailedCoverageForTest,'function');

 const unrelated=()=>({affectsConfiguration:key=>key==='testy'});
 changed(unrelated());
 assert.equal(profiles.length,6,'unrelated changes keep the profiles');
 settings.additionalConfigurations=['Release','Staging'];
 changed({affectsConfiguration:key=>key==='testy'||key==='testy.additionalConfigurations'});
 assert.ok(release.every(profile=>profile.disposed),'old profiles are disposed');
 assert.deepEqual(labels(),['Run','Run with coverage','Debug','Run (Release)','Run with coverage (Release)','Debug (Release)','Run (Staging)','Run with coverage (Staging)','Debug (Staging)']);
 settings.additionalConfigurations=[];
 changed({affectsConfiguration:key=>key==='testy'||key==='testy.additionalConfigurations'});
 assert.deepEqual(labels(),['Run','Run with coverage','Debug']);
 await testy.dispose();
});

test('a manual run through a configuration profile carries the configuration; other profiles and automatic runs do not',async()=>{
 const {testy,profiles}=createTesty({configuration:{additionalConfigurations:['Release']},
  tests:{createTestRun:()=>({token:{onCancellationRequested:()=>({dispose(){}})},appendOutput(){},end(){},enqueued(){}})}});
 const manuals=[];
 testy.engine.run=async(batch,signal,manual)=>{manuals.push(manual);return{files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:false};};
 const profile=label=>profiles.find(item=>item.label===label);
 const request=chosen=>({include:undefined,exclude:undefined,profile:chosen,continuous:false});
 await profile('Run (Release)').handler(request(profile('Run (Release)')),token);
 await profile('Run with coverage (Release)').handler(request(profile('Run with coverage (Release)')),token);
 await profile('Run').handler(request(profile('Run')),token);
 await profile('Run with coverage').handler(request(profile('Run with coverage')),token);
 assert.equal(manuals.length,4);
 assert.deepEqual(plain(manuals.map(manual=>[manual.configuration,manual.coverage])),[['Release',false],['Release',true],[null,false],[null,true]]);
 await testy.dispose();
});

test('a debug profile for an additional configuration debugs with that configuration',async()=>{
 const {testy,profiles}=createTesty({configuration:{additionalConfigurations:['Release']},api:{extensions:{getExtension:()=>({})}},
  tests:{createTestRun:()=>({token:{onCancellationRequested:()=>({dispose(){}})},appendOutput(){},end(){},enqueued(){}})}});
 const manuals=[];
 testy.engine.run=async(batch,signal,manual)=>{manuals.push(manual);return{files:0,tests:0,passed:0,failed:0,skipped:0,duration:1,coverageAvailable:false};};
 const debug=profiles.find(item=>item.label==='Debug (Release)');
 await debug.handler({include:undefined,exclude:undefined,profile:debug,continuous:false},token);
 assert.deepEqual(plain(manuals.map(manual=>[manual.configuration,manual.debug,manual.coverage])),[['Release',true,false]]);
 await testy.dispose();
});
