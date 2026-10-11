// @ts-check
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Worker}=require('node:worker_threads');
const {maxReportBytes}=require('../../out/services/coverageWorker');
const {normalizePath}=require('../../out/core/paths');

/** @typedef {import('../../out/services/coverageWorker').CoverageResponse} Response */

/** @param {import('node:test').TestContext} t */
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'testy-coverage-worker-'));
 const worker=new Worker(path.resolve('out/services/coverageWorker.js'));
 t.after(async()=>{await worker.terminate();await fs.rm(root,{recursive:true,force:true});});
 const source=normalizePath(path.join(root,'Code.cs'));
 /** @param {number} id @param {string} report @param {number} [filesVersion] @returns {Promise<Response>} */
 const request=(id,report,filesVersion=1)=>new Promise(resolve=>{
  const listen=(/** @type {Response} */ response)=>{if(response.id!==id)return;worker.off('message',listen);resolve(response);};
  worker.on('message',listen);worker.postMessage({id,report,cwd:root,filesVersion});
 });
 return{root,worker,source,request};
}

test('the worker parses a report against the allowed files and transfers compact line values',async t=>{
 const f=await fixture(t),report=path.join(f.root,'cobertura.xml');
 await fs.writeFile(report,`<coverage><packages><package><classes><class filename="${f.source}"><lines><line number="3" hits="2"/><line number="4" hits="0"/></lines></class>`+
  `<class filename="${normalizePath(path.join(f.root,'Other.cs'))}"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>`);
 f.worker.postMessage({version:1,files:[f.source]});
 const response=await f.request(1,report);
 assert.equal(response.error,undefined);assert.equal(response.files?.length,1,'files outside the allowed list are dropped');
 assert.equal(response.files?.[0]?.file,f.source);assert.deepEqual([...response.files?.[0]?.values??[]],[3,2,4,0]);
});

test('a request issued against an outdated file list, a missing report and malformed XML each answer with an error',async t=>{
 const f=await fixture(t),report=path.join(f.root,'cobertura.xml');
 await fs.writeFile(report,'<coverage><packages/></coverage>');f.worker.postMessage({version:2,files:[f.source]});
 assert.match(/** @type {string} */ ((await f.request(1,report,1)).error),/outdated file list/);
 assert.match(/** @type {string} */ ((await f.request(2,path.join(f.root,'absent.xml'),2)).error),/ENOENT/);
 await fs.writeFile(report,'<coverage><packages>');
 assert.ok((await f.request(3,report,2)).error,'truncated XML is rejected');
 await fs.writeFile(report,'<coverage><packages><package><classes/></package></packages></coverage>');
 assert.equal((await f.request(4,report,2)).error,undefined,'the worker keeps serving after failures');
});

test('a report above the size limit is rejected without being read',async t=>{
 const f=await fixture(t),report=path.join(f.root,'huge.xml');
 // A sparse file: its size is reported without the bytes existing.
 const handle=await fs.open(report,'w');await handle.truncate(maxReportBytes+1);await handle.close();
 f.worker.postMessage({version:1,files:[f.source]});
 assert.match(/** @type {string} */ ((await f.request(1,report)).error),/limit is \d+/);
});

test('reports sharing a layout name are read with the learned layout, and a report with other lines under that name is parsed whole',async t=>{
 const f=await fixture(t),report=path.join(f.root,'cobertura.xml');
 const write=(/** @type {string} */ lines)=>fs.writeFile(report,`<coverage><packages><package><classes><class filename="${f.source}"><methods><method name="Run" signature="()"><lines>${lines}</lines></method></methods><lines>${lines}</lines></class></classes></package></packages></coverage>`);
 f.worker.postMessage({version:1,files:[f.source]});
 /** @param {number} id */
 const read=id=>new Promise(resolve=>{
  const listen=(/** @type {Response} */ response)=>{if(response.id!==id)return;f.worker.off('message',listen);resolve(response);};
  f.worker.on('message',listen);f.worker.postMessage({id,report,cwd:f.root,filesVersion:1,layout:'session'});
 });
 const values=(/** @type {any} */ response)=>{assert.equal(response.error,undefined);return[[...response.files[0].values],response.files[0].declarations];};
 await write('<line number="3" hits="1"/><line number="4" hits="0"/>');
 assert.deepEqual(values(await read(1)),[[3,1,4,0],[{name:'Run()',start:3,end:4}]]);
 await write('<line number="3" hits="4"/><line number="4" hits="2"/>');
 assert.deepEqual(values(await read(2)),[[3,4,4,2],[{name:'Run()',start:3,end:4}]]);
 await write('<line number="3" hits="1"/><line number="5" hits="1"/>');
 assert.deepEqual(values(await read(3)),[[3,1,5,1],[{name:'Run()',start:3,end:5}]],'other lines: a complete parse, which learns them');
 await write('<line number="3" hits="0"/><line number="5" hits="7"/>');
 assert.deepEqual(values(await read(4)),[[3,0,5,7],[{name:'Run()',start:3,end:5}]]);
});
