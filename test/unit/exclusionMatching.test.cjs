const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Minimatch}=require('minimatch');
const {isExcluded,defaultExcludes,matchesPattern,preparePathNormalizer,normalizePath}=require('../../out/core/paths');

const patterns=[...defaultExcludes,'**/Generated/**','**/*.Designer.vb','**/a-b.c/**','ignored/**','**/*.{tmp,bak}'];
const names=['bin','BIN','obj','Obj','TestResults','testresults','node_modules','.git','.gitignore','.vs','.vscode','.VSCode','.idea','.testy','Generated','a-b.c','abc','binx','xbin','src','.bin','..','.',
 'A.cs','A.g.cs','A.G.CS','.g.cs','g.cs','A.g.i.cs','A.generated.cs','A.Designer.cs','A.designer.vb','A.cs.bak','A.tmp','x.g.cs.bak','ignored'];
const corpus=['','/','bin','bin/','/bin','/bin/','c:/bin/x','C:\\work\\obj\\A.cs','C:\\work\\src\\A.g.cs'];
for(const first of names){corpus.push(first,`${first}/`,`/${first}`);for(const second of names){
 corpus.push(`/w/${first}/${second}`,`/w/${first}/${second}/`,`${first}/${second}`,`/w//${first}//${second}`);
}}
const roots=['/w','/w/src',''];

test('fast exclusion matching agrees with minimatch on every candidate',()=>{
 let checked=0;
 for(const file of corpus){for(const rootSet of [[],['/w'],['/w/bin']]){
  const expected=patterns.some(pattern=>{
   const directory=/[/\\]$/.test(file);
   const candidates=[file,...rootSet.filter(root=>require('../../out/core/paths').isInside(file,root)).map(root=>require('node:path').relative(root,file)+(directory?'/':''))];
   const compiled=new Minimatch(pattern,{dot:true,nocase:true});
   return candidates.some(candidate=>compiled.match(candidate.replace(/\\/g,'/')));
  });
  assert.equal(isExcluded(file,patterns,rootSet),expected,`${file} with roots ${rootSet.join(',')}`);checked++;
 }}
 assert.ok(checked>5000);
 for(const pattern of patterns){for(const file of corpus.slice(0,400)){assert.equal(isExcluded(file,[pattern],roots.slice(0,1)),matchesPattern(file,pattern,roots.slice(0,1)),`${pattern} ${file}`);}}
});

test('default exclusions avoid per-pattern glob matching',()=>{
 const files=Array.from({length:20000},(_,index)=>`/w/Project${index%300}/src/deep/File${index}.cs`),started=performance.now();
 for(const file of files){isExcluded(file,defaultExcludes,['/w']);}
 assert.ok(performance.now()-started<1000,'20,000 checks stay well below the former cost');
});

test('the path normalizer deduplicates lazily and maps results to themselves',async()=>{
 const normalize=await preparePathNormalizer((function*(){yield '/tmp/a/../b';yield '/tmp/a/../b';yield '/tmp/c';})());
 assert.equal(normalize('/tmp/a/../b'),normalizePath('/tmp/b'));
 assert.equal(normalize(normalize('/tmp/c')),normalizePath('/tmp/c'));
});
