const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Timeline,traceEvents,slowest}=require('../../out/core/timeline');

test('the timeline keeps the spans of the retention window, bounded, oldest first',()=>{
 let now=100_000;
 const timeline=new Timeline(10_000,4,()=>now);
 timeline.record({name:'old',category:'run',lane:0,start:80_000,end:85_000});
 timeline.record({name:'Building',category:'phase',lane:0,start:95_000,end:96_000});
 timeline.record({name:'A.cs',category:'batch',lane:1,start:94_000,end:99_000});
 timeline.record({name:'backwards',category:'batch',lane:1,start:99_000,end:98_000});
 assert.deepEqual(timeline.recent().map(span=>span.name),['A.cs','Building'],'ended before the window, or invalid: dropped');
 for(let index=0;index<10;index++){timeline.record({name:`f${index}`,category:'batch',lane:2,start:now+index,end:now+index+1});}
 assert.deepEqual(timeline.recent().map(span=>span.name),['f6','f7','f8','f9'],'at most the newest maxSpans');
 now+=60_000;assert.equal(timeline.recent().length,0);
 timeline.record({name:'x',category:'run',lane:0,start:now,end:now});timeline.clear();assert.equal(timeline.size,0);
});

test('trace events are complete events in microseconds from the first span, with named and ordered lanes',()=>{
 const trace=traceEvents([
  {name:'Affected run',category:'run',lane:0,start:1000,end:3500,details:{changes:1,cancelled:false}},
  {name:'CalcTests.cs',category:'batch',lane:2,start:1500,end:3000,details:{tests:3}},
  {name:'Test process',category:'process',lane:2,start:2000,end:2000}
 ]);
 assert.equal(trace.displayTimeUnit,'ms');
 const meta=trace.traceEvents.filter(event=>event.ph==='M');
 assert.deepEqual(meta.filter(event=>event.name==='thread_name').map(event=>[event.tid,/** @type {any} */ (event.args).name]),[[0,'Engine'],[2,'Worker 2']]);
 const events=trace.traceEvents.filter(event=>event.ph==='X');
 assert.deepEqual(events.map(event=>[event.name,event.tid,event.ts,event.dur]),[['Affected run',0,0,2_500_000],['CalcTests.cs',2,500_000,1_500_000],['Test process',2,1_000_000,1]],'a zero-length span still shows');
 assert.equal(/** @type {any} */ (events[1].args).tests,3);
 assert.equal(/** @type {any} */ (events[0].args).startedAt,new Date(1000).toISOString());
});

test('the slowest files are those with learned times, longest first, limited',()=>{
 const times=new Map([['a',100],['b',900],['c',400]]);
 const rows=slowest([{id:'a'},{id:'b'},{id:'c'},{id:'d'}],id=>times.get(id),2);
 assert.deepEqual(rows.map(row=>[row.group.id,row.elapsed]),[['b',900],['c',400]]);
});

test('preparation work takes the lowest free preparation lane, counters export as counter events, and batches are coloured',()=>{
 const {preparationLanes}=require('../../out/core/timeline');
 let now=1000;const timeline=new Timeline(60_000,100,()=>now);
 const first=timeline.begin('Build','build'),second=timeline.begin('Discover T','discovery',{project:'T'});
 now=1500;first({succeeded:true});const third=timeline.begin('Instrument A.dll','instrumentation');now=2000;second();third();
 const spans=timeline.recent();
 assert.deepEqual(spans.map(span=>[span.name,span.lane-preparationLanes]).sort(),[['Build',0],['Discover T',1],['Instrument A.dll',0]]);
 assert.deepEqual(spans.find(span=>span.name==='Build')?.details,{succeeded:true});
 timeline.count('Event-loop delay',12,1200);timeline.count('Event-loop delay',Number.NaN,1300);
 timeline.record({name:'A.cs',category:'batch',lane:1,start:1000,end:1400,details:{failed:1}});
 timeline.record({name:'B.cs',category:'batch',lane:1,start:1400,end:1600,details:{failed:0}});
 const trace=traceEvents(timeline.recent(),timeline.samples());
 const names=trace.traceEvents.filter(event=>event.name==='thread_name').map(event=>/** @type {any} */ (event.args).name);
 assert.ok(names.includes('Preparation 1')&&names.includes('Preparation 2')&&names.includes('Worker 1'),`${names}`);
 assert.deepEqual(trace.traceEvents.filter(event=>event.ph==='C').map(event=>[event.name,event.ts,/** @type {any} */ (event.args).ms]),[['Event-loop delay',200_000,12]]);
 assert.deepEqual(trace.traceEvents.filter(event=>event.cat==='batch').map(event=>event.cname),['terrible','good']);
});
