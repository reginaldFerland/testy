// @ts-check
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');



test('bundled managed assemblies contain portable IL rather than build-machine native code',async()=>{
 const directories=[path.resolve(process.env.TESTY_DIST??'dist')],files=[];
 while(directories.length){const directory=directories.pop();for(const entry of await fs.readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);if(entry.isDirectory())directories.push(file);else if(entry.name.endsWith('.dll'))files.push(file);
 }}
 assert.ok(files.some(file=>file.endsWith('Testy.Analysis.dll')));
 // Roslyn is loaded from the user's SDK at run time (RoslynLoader), never shipped.
 assert.deepEqual(files.filter(file=>/^Microsoft\.CodeAnalysis/i.test(path.basename(file))),[]);
 // PE/COFF headers and IMAGE_COR20_HEADER, as defined by Microsoft's PE
 // specification and dotnet/runtime's corhdr.h. AnyCPU IL uses I386 without
 // 32BITREQUIRED; a ManagedNativeHeader would reintroduce platform-specific code.
 for(const file of files){
  const bytes=await fs.readFile(file),pe=bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii',pe,pe+4),'PE\0\0',file);
  assert.equal(bytes.readUInt16LE(pe+4),0x14c,`${file}: use portable packages, not native SDK binaries`);
  const optional=pe+24;assert.equal(bytes.readUInt16LE(optional),0x10b,file);
  const rva=bytes.readUInt32LE(optional+96+14*8),count=bytes.readUInt16LE(pe+6),sections=optional+bytes.readUInt16LE(pe+20);
  let header;
  for(let index=0;index<count;index++){
   const section=sections+index*40,start=bytes.readUInt32LE(section+12),size=bytes.readUInt32LE(section+16);
   if(rva>=start&&rva<start+size)header=bytes.readUInt32LE(section+20)+rva-start;
  }
  assert.notEqual(header,undefined,file);assert.equal(bytes.readUInt32LE(header+16)&3,1,`${file}: ILONLY without 32BITREQUIRED`);
  assert.equal(bytes.readUInt32LE(header+64),0,`${file}: no native managed image`);assert.equal(bytes.readUInt32LE(header+68),0,file);
 }
});
