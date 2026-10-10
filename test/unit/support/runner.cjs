// Loads the compiled runner and the modules split from it into one context, so a
// test's replacements for their dependencies apply to all of them.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');

const siblings=new Set(['./runnerLanes','./runnerPreparation']);

/** @param {Record<string, unknown>} modules replacements by require specifier @param {Record<string, unknown>} globals */
function loadRunner(modules={},globals={}){
 const context=vm.createContext({...globals}),loaded=new Map();
 /** @param {string} file @returns {any} */
 const load=file=>{
  if(loaded.has(file))return loaded.get(file);
  const exports={},realRequire=createRequire(file);loaded.set(file,exports);
  const body=vm.runInContext(`(function(exports,require){${fs.readFileSync(file,'utf8')}\n})`,context,{filename:file});
  body(exports,/** @param {string} name */name=>modules[name]??(siblings.has(name)?load(path.join(path.dirname(file),`${name}.js`)):realRequire(name)));
  return exports;
 };
 return load(path.resolve(__dirname,'../../../out/services/runner.js'));
}

module.exports={loadRunner};
