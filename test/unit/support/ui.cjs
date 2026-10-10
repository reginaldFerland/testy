const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');

const out=path.resolve('out');
// Modules that import `vscode` are evaluated against the stub; everything else loads normally.
const stubbed=new Set(['extension','controller','changeWatcher','commands','diagnosticsPublisher','configuration','ui/coverage','ui/statusBar','ui/testTree','ui/exportCoverage','ui/selectionCause','ui/baselineProgress','ui/inlineResults']);

/**
 * Loads the compiled extension-host modules from out/ into one sandbox with a stub `vscode`.
 * `stubs` replaces modules by name (`configuration`, `node:path`; `configuration: undefined` loads the real one); `globals` extends the sandbox.
 */
/**
 * @param {{vscode?: Record<string, any>, stubs?: Record<string, any>, globals?: Record<string, unknown>}} [options]
 * @returns {{module: (name: string) => any, readonly Testy: any, changeWatcher: (host: any) => any, readonly TestTree: any, readonly CoverageView: any, readonly failureMessage: any}}
 */
function loadUi({vscode={},stubs={},globals={}}={}) {
 stubs={configuration:{},...stubs};
 vscode={l10n:{t:(/** @type {string} */ message,/** @type {unknown[]} */ ...args)=>message.replace(/\{(\d+)\}/g,(/** @type {string} */ _,/** @type {number} */ index)=>String(args[index]))},TestTag:class{constructor(/** @type {string} */ id){this.id=id;}},...vscode};
 const sandbox=vm.createContext({Buffer,setTimeout,clearTimeout,AbortController,...globals}),cache=new Map();
 /** @type {(file: string) => any} */
 const load=file=>{
  const key=path.relative(out,file).replace(/\\/g,'/').replace(/\.js$/,'');
  if(stubs[key]!==undefined)return stubs[key];
  if(!stubbed.has(key))return createRequire(file)(file);
  if(cache.has(file))return cache.get(file).exports;
  const module={exports:{}};cache.set(file,module);
  const resolve=(/** @type {string} */ name)=>name==='vscode'?vscode:name in stubs?stubs[name]:name.startsWith('.')?load(path.resolve(path.dirname(file),`${name}.js`)):createRequire(file)(name);
  new vm.Script(`(function(exports,require,module){${fs.readFileSync(file,'utf8')}\n})`,{filename:file}).runInContext(sandbox)(module.exports,resolve,module);
  return module.exports;
 };
 const module=(/** @type {string} */ name)=>load(path.join(out,`${name}.js`));
 /** @type {WeakMap<object, any>} */ const watchers=new WeakMap();
 return{module,get Testy(){return module('controller').Testy;},/** The `ChangeWatcher` of a plain-object host, created once; the host's `queueChanged` replaces the debounced one. */
  changeWatcher(/** @type {any} */ host){
   let watcher=watchers.get(host);
   if(!watcher){watcher=new (module('changeWatcher').ChangeWatcher)(host);if(host.queueChanged)watcher.queueChanged=(/** @type {unknown} */ files)=>host.queueChanged(files);watchers.set(host,watcher);}
   return watcher;
  },get TestTree(){return module('ui/testTree').TestTree;},
  get CoverageView(){return module('ui/coverage').CoverageView;},get failureMessage(){return module('ui/testTree').failureMessage;}};
}

module.exports={loadUi};
