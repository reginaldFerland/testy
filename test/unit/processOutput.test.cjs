const {test}=require('node:test');
const assert=require('node:assert/strict');
const {OutputTail}=require('../../out/core/outputTail');


test('output tails preserve the exact bounded suffix across trimming and compaction',()=>{
 for(const limit of [0,1,7,8192]) {
  const tail=new OutputTail(limit);let expected='';
  for(let i=0;i<5000;i++){const text=`${i}🌍`;expected=limit?(expected+text).slice(-limit):'';tail.append(text);}
  assert.equal(tail.text(),expected);
  const long='z'.repeat(10000);tail.append(long);assert.equal(tail.text(),limit?long.slice(-limit):'');
 }
});

test('process output decodes split UTF-8 and bounds both streams',async()=>{
 const {runProcess}=require('../../out/services/process');
 const script='const fs=require("node:fs");for(const fd of [1,2]){for(let i=0;i<144;i++)fs.writeSync(fd,Buffer.alloc(65536,fd===1?65:66));for(const byte of Buffer.from("🌍 end"))fs.writeSync(fd,Buffer.from([byte]));}';
 const result=await runProcess(process.execPath,['-e',script],{timeoutMs:10000});assert.equal(result.code,0);
 for(const [value,char] of [[result.stdout,'A'],[result.stderr,'B']]){assert.equal(value.length,8*1024*1024);assert.equal(value,char.repeat(8*1024*1024-'🌍 end'.length)+'🌍 end');}
});
