import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initProduct,migrateProduct,addFeature,checkProduct,syncProduct,featureContext,releaseFeature,syncFeature} from '../src/product.js';
import {createTask,advance,readTask} from '../src/state.js';
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'product-map-'));try{await initProduct(root,'Booking app');const registry=JSON.parse(await readFile(join(root,'PRODUCT.json')));registry.domains=[{id:'product',description:'Application domain'}];await writeFile(join(root,'PRODUCT.json'),JSON.stringify(registry));await syncProduct(root);await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function edit(root,id,change){const path=join(root,'features',id,'feature.json');const f=JSON.parse(await readFile(path));change(f);await writeFile(path,JSON.stringify(f,null,2));}
async function implemented(root,id){await addFeature(root,id,id);await mkdir(join(root,'src'),{recursive:true});await mkdir(join(root,'tests'),{recursive:true});await writeFile(join(root,'src',id+'.js'),'export const example = true;');await writeFile(join(root,'tests',id+'.test.js'),'// test supplied by product author');await edit(root,id,f=>{f.status='implemented';f.domainIds=['product'];f.components=[{id:id+'-service',path:'src/'+id+'.js',dependsOn:[]}];f.tests=[{id:id+'-unit',type:'unit',path:'tests/'+id+'.test.js',command:'node --test tests/'+id+'.test.js'}];});await syncProduct(root);await writeFile(join(root,id+'-validation.md'),'Fixture validation record');await syncFeature(root,id,{assessments:Object.fromEntries(['documentation','userFlows','unitTests'].map(key=>[key,{status:'updated',reason:'Initial fixture mapping'}])),artifacts:[id+'-validation.md'],tests:[{id:id+'-unit',status:'passed',command:'node --test tests/'+id+'.test.js',result:'fixture result'}]});}
test('initialization and feature creation preserve existing files and index links',()=>fixture(async root=>{
 await assert.rejects(initProduct(root,'Replacement'),{code:'EEXIST'});assert.equal(JSON.parse(await readFile(join(root,'PRODUCT.json'))).name,'Booking app');
 await addFeature(root,'booking','Book appointments');await assert.rejects(addFeature(root,'booking','Duplicate'),/already registered/);assert.equal((await checkProduct(root)).features,1);
 const index=await readFile(join(root,'PRODUCT.md'),'utf8');assert.match(index,/features\/booking\/SCOPE.md/);
 await edit(root,'booking',f=>f.title='Changed title');await assert.rejects(checkProduct(root),/stale/);await syncProduct(root);await checkProduct(root);
}));
test('schema 1 migration previews, preserves documents and creates a draft schema 2 map',()=>fixture(async root=>{
 await addFeature(root,'booking','Booking');
 const productPath=join(root,'PRODUCT.json'),featurePath=join(root,'features/booking/feature.json');
 const product=JSON.parse(await readFile(productPath));product.schemaVersion=1;delete product.documents;delete product.domains;delete product.preparation;await writeFile(productPath,JSON.stringify(product));
 const feature=JSON.parse(await readFile(featurePath));delete feature.domainIds;delete feature.documentation;delete feature.userFlows;await writeFile(featurePath,JSON.stringify(feature));
 await writeFile(join(root,'features/booking/README.md'),'Existing guide');
 const record={domains:[{id:'appointments',description:'Booking domain'}],featureDomains:{booking:['appointments']}};
 assert.equal((await migrateProduct(root,{...record,dryRun:true})).dryRun,true);
 assert.equal(JSON.parse(await readFile(productPath)).schemaVersion,1);
 await assert.rejects(migrateProduct(root,{...record,featureDomains:{}}),/every feature/);
 await migrateProduct(root,record);
 assert.equal(JSON.parse(await readFile(productPath)).preparation.status,'draft');
 assert.deepEqual(JSON.parse(await readFile(featurePath)).domainIds,['appointments']);
 assert.equal(await readFile(join(root,'features/booking/README.md'),'utf8'),'Existing guide');
 await checkProduct(root,{requireSync:false});
}));
test('dependency graph provides transitive impact and rejects cycles and missing links',()=>fixture(async root=>{
 for(const id of ['accounts','booking','reminders'])await implemented(root,id);
 await edit(root,'booking',f=>{f.dependsOn=['accounts'];f.components[0].dependsOn=['accounts-service'];});await edit(root,'reminders',f=>f.dependsOn=['booking']);await syncProduct(root);
 const context=await featureContext(root,'accounts');assert.deepEqual(context.dependents,['booking','reminders']);assert.equal(context.affectedTests.length,3);
 await edit(root,'accounts',f=>f.dependsOn=['reminders']);await assert.rejects(checkProduct(root),/cycle/);
 await edit(root,'accounts',f=>f.dependsOn=[]);await edit(root,'booking',f=>f.dependsOn=[]);await assert.rejects(checkProduct(root),/without a feature dependency/);
}));
test('implemented features need unit tests and safe existing file references',()=>fixture(async root=>{
 await addFeature(root,'booking','Booking');await edit(root,'booking',f=>{f.status='implemented';f.domainIds=['product'];});await assert.rejects(checkProduct(root),/components and unit tests/);
 await edit(root,'booking',f=>{f.status='planned';f.scope='../outside.md';});await assert.rejects(checkProduct(root),/escapes project/);
 const outside=await mkdtemp(join(tmpdir(),'product-outside-'));try{await writeFile(join(outside,'file.md'),'outside');await symlink(join(outside,'file.md'),join(root,'outside.md'));await edit(root,'booking',f=>f.scope='outside.md');await assert.rejects(checkProduct(root),/Symlink escapes/);}finally{await rm(outside,{recursive:true,force:true});}
}));
test('version history records file hashes, requires test results and rejects duplicates',()=>fixture(async root=>{
 await implemented(root,'booking');await writeFile(join(root,'validation.md'),'Check output');
 const record={version:'0.1.0',codeRevision:'abc123',changes:['Added appointment booking'],artifacts:['validation.md'],tests:[{id:'booking-unit',status:'passed',command:'node --test tests/booking.test.js',result:'passed'}]};
 await assert.rejects(releaseFeature(root,'booking',{...record,tests:[]}),/passing results/);
 const release=await releaseFeature(root,'booking',record);assert.ok(release.snapshot['src/booking.js']);await checkProduct(root);await assert.rejects(releaseFeature(root,'booking',record),/already recorded/);
 await writeFile(join(root,'src/booking.js'),'changed');const history=JSON.parse(await readFile(join(root,'features/booking/history.json')));assert.equal(history[0].snapshot['src/booking.js'],release.snapshot['src/booking.js']);
}));
test('v3 workflow requires mapped features and invalidates changed scope',()=>fixture(async root=>{
 await implemented(root,'booking');const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v3.json',import.meta.url)));const task=await createTask(root,graph,'Build booking');const file=join(root,'.engineering/tasks',task.id,'task.json');await writeFile(join(root,'.engineering/tasks',task.id,'evidence.md'),'actual report');
 const e={summary:'work recorded',artifacts:['evidence.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'booking scope',response:'approved'},codeFiles:['src/booking.js']};
 for(const outcome of ['ready','approved','ready','allowed'])await advance(file,{outcome,expectedRevision:(await readTask(file)).revision,evidence:e});
 await assert.rejects(advance(file,{outcome:'completed',expectedRevision:4,evidence:e}),/featureIds/);
 await advance(file,{outcome:'completed',expectedRevision:4,evidence:{...e,featureIds:['booking']}});
 await writeFile(join(root,'features/booking/SCOPE.md'),'changed scope');await assert.rejects(advance(file,{outcome:'passed',expectedRevision:5,evidence:e}),/Code changed|out of sync/);
}));
