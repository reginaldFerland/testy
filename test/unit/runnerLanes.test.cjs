const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setImmediate:turn}=require('node:timers/promises');
const {RunnerLanes}=require('../../out/services/runnerLanes');

test('a lane created after a failed lane takes a free slot instead of one a live lane holds',async()=>{
 /** @type {{number: number, slot: number}[]} */ const created=[];let fail=false;
 const lanes=new RunnerLanes(async(number,slot)=>{created.push({number,slot});if(fail&&slot===1)throw new Error('controlled lane failure');return {number,slot};});
 fail=true;
 const first=lanes.reserve('target'),second=lanes.reserve('target');
 assert.deepEqual([first.slot,second.slot],[1,2]);
 await assert.rejects(first.session,/controlled lane failure/);await turn();
 // The failed lane is discarded; slot 2 is still held by the busy second lane.
 fail=false;const third=lanes.reserve('target');
 assert.equal(third.slot,1);assert.notEqual(third.slot,second.slot);
 assert.deepEqual(created.map(item=>item.number),[1,2,3],'output directories are never reused');
 // Idle lanes are reused before new slots are allocated, and targets have independent slots.
 second.busy=false;assert.equal(lanes.reserve('target'),second);
 assert.equal(lanes.reserve('other').slot,1);
 assert.equal(lanes.size,2);
});
