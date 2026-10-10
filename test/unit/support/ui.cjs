const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');

const out=path.resolve('out');
// Modules that import `vscode` are evaluated against the stub; everything else loads normally.
const stubbed=new Set(['extension','controller','ui/coverage','ui/statusBar','ui/testTree','ui/exportCoverage','ui/selectionCause','ui/baselineProgress']);

/**
 * Loads the compiled extension-host modules from out/ into one sandbox with a stub `vscode`.
 * `stubs` replaces modules by name (`configuration`, `node:path`); `globals` extends the sandbox.
 */
function loadUi({vscode={},stubs={},globals={}}={}) {
 stubs={configuration:{},...stubs};
 vscode={l10n:{t:(message,...args)=>message.replace(/\{(\d+)\}/g,(_,index)=>String(args[index]))},TestTag:class{constructor(id){this.id=id;}},...vscode};
 const sandbox=vm.createContext({Buffer,setTimeout,clearTimeout,AbortController,...globals}),cache=new Map();
 const load=file=>{
  const key=path.relative(out,file).replace(/\\/g,'/').replace(/\.js$/,'');
  if(key in stubs)return stubs[key];
  if(!stubbed.has(key))return createRequire(file)(file);
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const resolve=name=>name==='vscode'?vscode:name in stubs?stubs[name]:name.startsWith('.')?load(path.resolve(path.dirname(file),`${name}.js`)):createRequire(file)(name);
  new vm.Script(`(function(exports,require,module){${fs.readFileSync(file,'utf8')}\n})`,{filename:file}).runInContext(sandbox)(module.exports,resolve,module);
  return module.exports;
 };
 const module=name=>load(path.join(out,`${name}.js`));
 return{module,get Testy(){return module('controller').Testy;},get TestTree(){return module('ui/testTree').TestTree;},
  get CoverageView(){return module('ui/coverage').CoverageView;},get failureMessage(){return module('ui/testTree').failureMessage;}};
}

module.exports={loadUi};
