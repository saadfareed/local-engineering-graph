import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,access,chmod,lstat} from 'node:fs/promises';
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
test('project snapshots use immutable sidecar files and detect corruption',()=>fixture(async({file,step})=>{
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 const raw=JSON.parse(await readFile(file,'utf8'));
 assert.equal(raw.projectSnapshot,undefined);
 assert.match(raw.projectSnapshotRef,/^[a-f0-9]{64}$/);
 assert.ok((await readTask(file)).projectSnapshot['app.js']);
 const snapshotFile=join(file,'..',`project-snapshot-${raw.projectSnapshotRef}.json`);
 await writeFile(snapshotFile,'{}');
 await assert.rejects(readTask(file),/Corrupted project snapshot data/);
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
test('code snapshots allow in-project names starting with two dots and reject parent traversal',()=>fixture(async({root,step})=>{
 await writeFile(join(root,'..config.js'),'in-project');
 for(const outcome of ['ready','approved','ready','allowed'])await step(outcome);
 await assert.rejects(step('completed',{codeFiles:['../outside.js']}),/escapes project/);
 await step('completed',{codeFiles:['..config.js']});
 await step('passed');
 await writeFile(join(root,'..config.js'),'changed');
 await assert.rejects(step('passed',{criteria:[]}),/Code changed/);
}));
test('status reports modified declared code, added and deleted project files without mutating state',()=>fixture(async({root,file,step})=>{
 await writeFile(join(root,'deleted.js'),'delete later');
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 const saved=await readFile(file,'utf8');
 const clean=await status(file);
 assert.equal(clean.codeIntegrity.checked,true);assert.deepEqual(clean.codeIntegrity.changedFiles,[]);
 assert.equal(clean.projectIntegrity.checked,true);assert.deepEqual(clean.projectIntegrity.changedPaths,[]);assert.equal(clean.projectIntegrity.error,null);
 await writeFile(join(root,'app.js'),'changed');await writeFile(join(root,'added.js'),'new');await rm(join(root,'deleted.js'));
 const changed=await status(file);
 assert.deepEqual(changed.codeIntegrity.changedFiles,['app.js']);
 assert.deepEqual(changed.projectIntegrity.changedPaths,['added.js','app.js','deleted.js']);
 assert.equal(changed.evidenceIntegrity.changedArtifacts.length,0);
 assert.equal(await readFile(file,'utf8'),saved);
 await rm(join(root,'app.js'));assert.deepEqual((await status(file)).codeIntegrity.changedFiles,['app.js']);
}));
for(const kind of ['file permissions','directory permissions','empty directory','file type','symlink target','nested runtime name'])test(`project snapshots detect ${kind}`,()=>fixture(async({root,file,step})=>{
 await writeFile(join(root,'same.js'),'original');await mkdir(join(root,'folder'));
 await symlink('app.js',join(root,'link.js'));
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 let path;
 if(kind==='file permissions'){path='app.js';await chmod(join(root,path),((await lstat(join(root,path))).mode&0o7777)^0o100);}
 if(kind==='directory permissions'){path='folder';await chmod(join(root,path),((await lstat(join(root,path))).mode&0o7777)^0o020);}
 if(kind==='empty directory'){path='empty';await mkdir(join(root,path));}
 if(kind==='file type'){path='app.js';await rm(join(root,path));await symlink('same.js',join(root,path));}
 if(kind==='symlink target'){path='link.js';await rm(join(root,path));await symlink('same.js',join(root,path));}
 if(kind==='nested runtime name'){path='folder/.engineering';await mkdir(join(root,path));await writeFile(join(root,path,'app.js'),'tracked');}
 const changed=await status(file);assert.ok(changed.projectIntegrity.changedPaths.includes(path));
 await assert.rejects(step('passed'),/Code changed in project/);
}));
test('status reports unsupported snapshot entries as errors while permitting repair',()=>fixture(async({root,file,step})=>{
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 await symlink('missing.js',join(root,'broken.js'));
 const changed=await status(file);assert.equal(changed.projectIntegrity.checked,true);assert.match(changed.projectIntegrity.error,/ENOENT/);
 await step('changes_required');assert.equal((await readTask(file)).node,'implementation');
}));
test('legacy schema-3 content snapshots remain readable and get upgraded on resubmission',()=>fixture(async({root,file,step})=>{
 for(const outcome of ['ready','approved','ready','allowed','completed'])await step(outcome);
 const t=await readTask(file);delete t.projectSnapshotVersion;t.projectSnapshot={...t.code};await writeFile(file,JSON.stringify(t));
 await chmod(join(root,'app.js'),0o700);
 const clean=await status(file);assert.deepEqual(clean.projectIntegrity.changedPaths,[]);assert.equal(clean.projectIntegrity.error,null);
 await step('changes_required');await step('completed');assert.equal((await readTask(file)).projectSnapshotVersion,2);await step('passed');
}));
test('unsupported snapshot versions are rejected',()=>fixture(async({file})=>{
 const t=await readTask(file);t.projectSnapshotVersion=99;await writeFile(file,JSON.stringify(t));await assert.rejects(status(file),/Unsupported project snapshot version/);
}));
test('status before implementation reports no snapshot check and v1 evidence is not hashed',()=>fixture(async({root,file})=>{
 const before=await status(file);assert.equal(before.codeIntegrity.checked,false);assert.equal(before.projectIntegrity.checked,false);
 const v1=JSON.parse(await readFile(new URL('../graphs/product-build.v1.json',import.meta.url)));
 const task=await createTask(root,v1,'Legacy text');const legacy=await status(join(root,'.engineering/tasks',task.id,'task.json'));
 assert.equal(legacy.evidenceIntegrity.checked,false);
}));
