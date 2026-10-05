import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createTask,advance,readTask,status} from '../src/state.js';
import {initProduct,recoverProduct} from '../src/product.js';
import {validateGraph} from '../src/graph.js';
const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v2.json',import.meta.url)));
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'integrity-'));
 try {
  const task=await createTask(root,graph,'Fixture'),file=join(root,'.engineering/tasks',task.id,'task.json');
  await writeFile(join(root,'app.js'),'original');await writeFile(join(root,'.engineering/tasks',task.id,'brief.md'),'approved brief');
  const evidence={summary:'Fixture',artifacts:['brief.md'],approval:{decision:'approved',scope:'Brief 1',response:'Approved',criteriaIds:['C1','C2']},codeFiles:['app.js']};
  const step=(outcome,extra={})=>readTask(file).then(t=>advance(file,{outcome,expectedRevision:t.revision,evidence:{...evidence,...extra}}));
  await fn({root,file,task,step,evidence});
 } finally {await rm(root,{recursive:true,force:true});}
}
test('task replay rejects inconsistent nodes, revisions and traversal counts',()=>fixture(async({file,step})=>{
 await step('ready');const original=await readFile(file,'utf8');
 for(const change of [t=>t.node='complete',t=>t.revision=999,t=>t.traversals['discovery:ready']=-1,t=>t.events[0].node='planning']) {
  const state=JSON.parse(original);change(state);await writeFile(file,JSON.stringify(state));await assert.rejects(readTask(file),/Corrupted/);
 }
 await writeFile(file,original);await readTask(file);
}));
test('approval hashes survive evidence edits and changed approval requires replan',()=>fixture(async({root,file,task,step})=>{
 for(const outcome of ['ready','approved','ready'])await step(outcome);
 const hash=(await readTask(file)).approvedScope.artifacts['brief.md'];
 await writeFile(join(root,'.engineering/tasks',task.id,'brief.md'),'changed');
 assert.equal((await readTask(file)).events[1].evidence.artifactSnapshot['brief.md'],hash);
 assert.equal((await status(file)).evidenceIntegrity.changedArtifacts.length,3);
 await assert.rejects(step('allowed'),/Approved artifacts changed/);
}));
test('complete criterion coverage and undeclared project files are checked',()=>fixture(async({root,step})=>{
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 await writeFile(join(root,'new.js'),'undeclared');await assert.rejects(step('passed'),/Code changed/);
 await step('changes_required');await step('completed');await step('passed');
 const criterion=id=>({id,status:'verified',command:'node --test',result:'passed'});
 await assert.rejects(step('passed',{criteria:[criterion('C1')]}),/every approved criterion/);
 await assert.rejects(step('passed',{criteria:[criterion('C1'),criterion('C1')]}),/every approved criterion/);
 await step('passed',{criteria:[criterion('C2'),criterion('C1')]});
}));
test('task artifacts reject traversal and escaping symlinks',()=>fixture(async({root,file,task,step})=>{
 await assert.rejects(step('ready',{artifacts:['../../../app.js']}),/escapes/);
 await symlink(join(root,'app.js'),join(root,'.engineering/tasks',task.id,'outside.js'));
 await assert.rejects(step('ready',{artifacts:['outside.js']}),/escapes/);
 assert.equal((await readTask(file)).revision,0);
}));
test('graph rejects nonterminal success and missing successful terminals',()=>{
 const g=structuredClone(graph);g.nodes.discovery.success=true;assert.throws(()=>validateGraph(g),/terminals/);
 delete g.nodes.discovery.success;delete g.nodes.complete.success;assert.throws(()=>validateGraph(g),/Successful terminal/);
});
test('product recovery refuses live writers and restores interrupted writes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'product-recover-'));
 try {
  await initProduct(root,'Fixture');const path=join(root,'PRODUCT.json'),original=await readFile(path);
  await writeFile(join(root,'.product-map.lock'),JSON.stringify({pid:process.pid,host:hostname()}));await assert.rejects(recoverProduct(root),/still active/);
  const child=spawn(process.execPath,['-e','']);await once(child,'exit');
  await writeFile(join(root,'.product-map.lock'),JSON.stringify({pid:child.pid,host:hostname()}));
  await writeFile(join(root,'.product-map.journal'),JSON.stringify([{path,previous:original.toString('base64'),directory:false}]));await writeFile(path,'interrupted');
  const recovered=await recoverProduct(root);await access(recovered.backup);assert.deepEqual(await readFile(path),original);await assert.rejects(access(join(root,'.product-map.lock')),/ENOENT/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('CLI rejects incomplete arguments and malformed revisions',async()=>{
 for(const args of [['start'],['advance','missing','ready','1.5','evidence']]) {
  const env={...process.env};delete env.NODE_TEST_CONTEXT;const child=spawn('node',['src/cli.js',...args],{env});child.stderr.resume();child.stdout.resume();const [code]=await once(child,'close');assert.equal(code,1);
 }
});
test('feature creation preserves an existing unregistered directory',async()=>{
 const {mkdir}=await import('node:fs/promises');const {addFeature}=await import('../src/product.js');
 const root=await mkdtemp(join(tmpdir(),'product-existing-'));
 try {
  await initProduct(root,'Fixture');await mkdir(join(root,'features/booking'),{recursive:true});await writeFile(join(root,'features/booking/keep.md'),'keep');
  await assert.rejects(addFeature(root,'booking','Booking'),/exists/);
  assert.equal(await readFile(join(root,'features/booking/keep.md'),'utf8'),'keep');
 } finally {await rm(root,{recursive:true,force:true});}
});
test('CLI help succeeds',async()=>{
 const env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn('node',['src/cli.js','--help'],{env});child.stdout.resume();child.stderr.resume();const [code]=await once(child,'close');assert.equal(code,0);
});
test('failed product transaction restores registry and indexes and removes its new feature',async()=>{
 const {addFeature}=await import('../src/product.js');
 const root=await mkdtemp(join(tmpdir(),'product-rollback-'));
 try {
  await initProduct(root,'Fixture');const product=JSON.parse(await readFile(join(root,'PRODUCT.json')));product.documents.features='missing/FEATURES.md';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(product));
  const before=await readFile(join(root,'PRODUCT.json')),index=await readFile(join(root,'PRODUCT.md'));
  await assert.rejects(addFeature(root,'booking','Booking'),/ENOENT/);
  assert.deepEqual(await readFile(join(root,'PRODUCT.json')),before);assert.deepEqual(await readFile(join(root,'PRODUCT.md')),index);
  await assert.rejects(access(join(root,'features/booking')),/ENOENT/);await assert.rejects(access(join(root,'.product-map.lock')),/ENOENT/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('legacy schema-2 tasks retain declared-file and criterion behavior',()=>fixture(async({root,file,step})=>{
 const state=await readTask(file);state.schemaVersion=2;await writeFile(file,JSON.stringify(state));
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 await writeFile(join(root,'undeclared.js'),'legacy coverage excludes this');await step('passed');
 await step('passed',{criteria:[{id:'legacy',status:'verified',command:'node --test',result:'passed'}]});
 assert.equal((await readTask(file)).node,'complete');
}));
test('approval requires criterion IDs and code snapshots reject escaping symlinks',()=>fixture(async({root,step,evidence})=>{
 await step('ready');await assert.rejects(step('approved',{approval:{...evidence.approval,criteriaIds:[]}}),/criteriaIds/);
 for(const outcome of ['approved','ready','allowed'])await step(outcome);
 const outside=await mkdtemp(join(tmpdir(),'snapshot-outside-'));
 try {
  await writeFile(join(outside,'app.js'),'outside');await symlink(join(outside,'app.js'),join(root,'escape.js'));
  await assert.rejects(step('completed',{codeFiles:['escape.js']}),/escapes/);
 } finally {await rm(outside,{recursive:true,force:true});}
}));
