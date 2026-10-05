import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,lstat,readlink,chmod,access} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {initProduct,addFeature,syncProduct,recoverProduct} from '../src/product.js';
import {createTask,advance,readTask,cancel} from '../src/state.js';
import {validateGraph} from '../src/graph.js';
const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v2.json',import.meta.url)));
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'audit-regression-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('initialization preserves existing and dangling symlinks and rejects late targets before writing',()=>fixture(async root=>{
 for(const dangling of [false,true]){
  const project=join(root,String(dangling));await mkdir(project);
  const target=join(root,dangling?'missing.json':'existing.json');if(!dangling)await writeFile(target,'existing');
  await symlink(target,join(project,'PRODUCT.json'));
  await assert.rejects(initProduct(project,'Demo'),{code:'EEXIST'});
  assert.equal((await lstat(join(project,'PRODUCT.json'))).isSymbolicLink(),true);assert.equal(await readlink(join(project,'PRODUCT.json')),target);
 }
 const project=join(root,'late');await mkdir(project);await writeFile(join(project,'USER-GUIDE.md'),'keep');await chmod(join(project,'USER-GUIDE.md'),0o600);
 await assert.rejects(initProduct(project,'Demo'),{code:'EEXIST'});await assert.rejects(access(join(project,'PRODUCT.json')),/ENOENT/);
 assert.equal((await lstat(join(project,'USER-GUIDE.md'))).mode&0o777,0o600);
}));
test('product rollback preserves symlink targets and file permissions',()=>fixture(async root=>{
 await initProduct(root,'Demo');const index=await readFile(join(root,'PRODUCT.md'));await writeFile(join(root,'index-target.md'),index);await rm(join(root,'PRODUCT.md'));await symlink('index-target.md',join(root,'PRODUCT.md'));
 await chmod(join(root,'PRODUCT.json'),0o600);
 const registry=JSON.parse(await readFile(join(root,'PRODUCT.json')));registry.documents.features='missing/FEATURES.md';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(registry));
 await assert.rejects(addFeature(root,'demo','Demo'),/ENOENT/);
 assert.equal(await readlink(join(root,'PRODUCT.md')),'index-target.md');assert.deepEqual(await readFile(join(root,'index-target.md')),index);
 assert.equal((await lstat(join(root,'PRODUCT.json'))).mode&0o777,0o600);
 registry.documents.features='FEATURES.md';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(registry));await syncProduct(root);assert.equal((await lstat(join(root,'PRODUCT.json'))).mode&0o777,0o600);
}));
test('graph validation rejects missing contracts and routes bypassing required evidence',async()=>{
 const v6=JSON.parse(await readFile(new URL('../graphs/product-build.v6.json',import.meta.url)));
 for(const mutate of [g=>{for(const n of Object.values(g.nodes))if(n.type==='agent')delete n.role;},g=>g.nodes.planning.role='custom',g=>g.nodes.discovery.role='custom',g=>g.nodes.implementation.role='custom',g=>g.nodes.review.role='custom',g=>g.nodes.validation.role='custom',g=>g.nodes.domain_check.role='custom',g=>{g.nodes.review.outcomes.push('skip');g.edges.push({from:'review',to:'validation',outcome:'skip',maxTraversals:1});}]){
  const g=structuredClone(v6);mutate(g);assert.throws(()=>validateGraph(g),/Role required|contract/);
 }
 const renamed=structuredClone(v6);renamed.nodes.build=renamed.nodes.implementation;delete renamed.nodes.implementation;for(const e of renamed.edges){if(e.from==='implementation')e.from='build';if(e.to==='implementation')e.to='build';}validateGraph(renamed);
});
test('reserved cancellation outcomes and ambiguous traversal keys are rejected; cancellation resumes',()=>fixture(async root=>{
 for(const outcome of ['cancelled','ready:now']){const g=structuredClone(graph);g.nodes.discovery.outcomes[0]=outcome;g.edges[0].outcome=outcome;assert.throws(()=>validateGraph(g),/Reserved/);}
 const t=await createTask(root,graph,'Demo'),file=join(root,'.engineering/tasks',t.id,'task.json');await cancel(file,{expectedRevision:0,reason:'Stop'});assert.equal((await readTask(file)).node,'blocked');
}));
test('prototype-named files and task artifacts are recorded and checked after reload',()=>fixture(async root=>{
 const t=await createTask(root,graph,'Demo'),dir=join(root,'.engineering/tasks',t.id),file=join(dir,'task.json');await writeFile(join(dir,'__proto__'),'brief');await writeFile(join(root,'__proto__'),'code');
 const e={summary:'Demo',artifacts:['__proto__'],approval:{decision:'approved',scope:'Demo',response:'Approved',criteriaIds:['C1']},codeFiles:['__proto__']};let revision=0;
 for(const outcome of ['ready','approved','ready','allowed','completed'])await advance(file,{outcome,expectedRevision:revision++,evidence:e});
 const saved=await readTask(file);assert.ok(Object.hasOwn(saved.projectSnapshot,'__proto__'));assert.ok(Object.hasOwn(saved.code,'__proto__'));assert.ok(Object.hasOwn(saved.events[0].evidence.artifactSnapshot,'__proto__'));
 await writeFile(join(root,'__proto__'),'changed');await assert.rejects(advance(file,{outcome:'passed',expectedRevision:revision,evidence:e}),/Code changed/);
}));
test('legacy task artifacts support absolute paths and relative paths outside the task directory',()=>fixture(async root=>{
 for(const schemaVersion of [1,2]){
  const t=await createTask(root,graph,'Legacy'),file=join(root,'.engineering/tasks',t.id,'task.json');t.schemaVersion=schemaVersion;await writeFile(file,JSON.stringify(t));await writeFile(join(root,'report.md'),'report');
  await advance(file,{outcome:'ready',expectedRevision:0,evidence:{summary:'Demo',artifacts:[join(root,'report.md')]}});
  await advance(file,{outcome:'approved',expectedRevision:1,evidence:{summary:'Demo',artifacts:['../../../report.md'],approval:{decision:'approved',scope:'Legacy',response:'Approved'}}});assert.equal((await readTask(file)).node,'planning');
 }
}));

test('preparation remains required when an intermediate node precedes implementation',()=>fixture(async root=>{
 const g=structuredClone(graph);g.productMap=true;g.productPreparation=true;
 g.nodes.dispatch={type:'agent',role:'dispatcher',outcomes:['go']};g.edges.find(e=>e.from==='domain_check'&&e.outcome==='allowed').to='dispatch';g.edges.push({from:'dispatch',to:'implementation',outcome:'go',maxTraversals:3});
 const t=await createTask(root,g,'Demo'),dir=join(root,'.engineering/tasks',t.id),file=join(dir,'task.json');await initProduct(root,'Demo');await writeFile(join(dir,'report.md'),'report');
 const e={summary:'Demo',artifacts:['report.md'],approval:{decision:'approved',scope:'Demo',response:'Approved',criteriaIds:['C1']}};let revision=0;
 for(const outcome of ['ready','approved','ready','allowed'])await advance(file,{outcome,expectedRevision:revision++,evidence:e});
 await assert.rejects(advance(file,{outcome:'go',expectedRevision:revision,evidence:e}),/before implementation/);assert.equal((await readTask(file)).node,'dispatch');
}));
test('malformed recovery journals are rejected before partially restoring files',()=>fixture(async root=>{
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const child=spawn(process.execPath,['-e','']);await once(child,'exit');
 await writeFile(join(root,'.product-map.lock'),JSON.stringify({pid:child.pid,host:hostname()}));await writeFile(join(root,'keep.txt'),'keep');
 await writeFile(join(root,'.product-map.journal'),JSON.stringify([{path:join(root,'broken.txt'),previous:42,directory:false},{path:join(root,'keep.txt'),previous:null,directory:false}]));
 await assert.rejects(recoverProduct(root),/Invalid product journal/);assert.equal(await readFile(join(root,'keep.txt'),'utf8'),'keep');await access(join(root,'.product-map.lock'));
}));
