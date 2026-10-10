const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {CoverageReader}=require('../../out/services/coverageReader'),{normalizePath}=require('../../out/core/paths');

async function fixture(t,count=1){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-coverage-reader-test-')),reader=new CoverageReader();
 t.after(async()=>{await reader.dispose();await fs.rm(root,{recursive:true,force:true});});
 const file=normalizePath(path.join(root,'Code.cs')),hashes=new Map([[file,'v1']]);
 const write=async(name,lines)=>{
  const report=path.join(root,name);
  await fs.writeFile(report,`<coverage><packages><package><classes><class filename="${file}"><lines>`+
   Array.from({length:lines},(_,index)=>`<line number="${index+1}" hits="1"/>`).join('')+'</lines></class></classes></package></packages></coverage>');
  return report;
 };
 return{root,reader,file,hashes,write};
}

test('aborting one of several concurrent reads leaves the shared worker and the others running',async t=>{
 const f=await fixture(t),big=await f.write('big.xml',150000),small=await f.write('small.xml',3);
 const abort=new AbortController(),first=f.reader.read(big,f.root,f.hashes),doomed=f.reader.read(small,f.root,f.hashes,abort.signal);
 const worker=f.reader.worker,rejected=assert.rejects(doomed,{name:'AbortError'});
 abort.abort();await rejected;
 assert.equal(f.reader.worker,worker,'the worker survives for the other request');
 assert.equal((await first)[0].lines.length,150000);
 // The aborted request's late reply is ignored; the worker keeps serving.
 assert.equal(f.reader.worker,worker);assert.equal(f.reader.pending.size,0);
 assert.equal((await f.reader.read(small,f.root,f.hashes))[0].lines.length,3);
});

test('aborting the only pending read stops the worker, and the next read starts a fresh one',async t=>{
 const f=await fixture(t),big=await f.write('big.xml',150000),small=await f.write('small.xml',3);
 const abort=new AbortController(),reading=f.reader.read(big,f.root,f.hashes,abort.signal),worker=f.reader.worker;
 const rejected=assert.rejects(reading,{name:'AbortError'});
 abort.abort();await rejected;
 assert.equal(f.reader.worker,undefined);
 assert.equal((await f.reader.read(small,f.root,f.hashes))[0].lines.length,3);
 assert.notEqual(f.reader.worker,worker);
});

test('an abort after the worker has replied cannot terminate it for other requests',async t=>{
 const f=await fixture(t),big=await f.write('big.xml',150000),abort=new AbortController();
 const first=f.reader.read(big,f.root,f.hashes,abort.signal),worker=f.reader.worker,rejected=assert.rejects(first,{name:'AbortError'});
 // The second request shares the worker while the first reply converts.
 const second=f.reader.read(big,f.root,f.hashes);
 // The worker parses requests concurrently, so replies may arrive in either order: abort when the first request's own reply lands.
 worker.on('message',response=>{if(response.id===1)setImmediate(()=>abort.abort());});
 await rejected;
 assert.equal(f.reader.worker,worker);
 assert.equal((await second)[0].lines.length,150000);
 assert.equal(f.reader.worker,worker);
});

test('reads after dispose are rejected and never start a worker',async t=>{
 const f=await fixture(t),small=await f.write('small.xml',3);
 await f.reader.dispose();
 await assert.rejects(f.reader.read(small,f.root,f.hashes),{name:'AbortError'});
 assert.equal(f.reader.worker,undefined);
 await f.reader.dispose();
});

test('dispose rejects reads that are still pending',async t=>{
 const f=await fixture(t),big=await f.write('big.xml',150000);
 const reading=f.reader.read(big,f.root,f.hashes),rejected=assert.rejects(reading,{name:'AbortError'});
 await f.reader.dispose();await rejected;
});
