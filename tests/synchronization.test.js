import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initProduct,addFeature,syncProduct,checkProduct,prepareProduct,checkProductPrepared,syncFeature,checkFeatureSync,releaseFeature} from '../src/product.js';
import {createTask,readTask,advance} from '../src/state.js';
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'product-sync-'));try{await initProduct(root,'Booking');await addFeature(root,'booking','Booking');await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
async function edit(root,path,fn){const data=JSON.parse(await readFile(join(root,path)));fn(data);await writeFile(join(root,path),JSON.stringify(data,null,2));}
async function plan(root){
 await edit(root,'PRODUCT.json',p=>p.domains=[{id:'appointments',description:'Appointment scheduling'}]);
 await edit(root,'features/booking/feature.json',f=>f.domainIds=['appointments']);
 await writeFile(join(root,'planning.md'),'Fixture scope: appointments can be booked; criteria C1.');await syncProduct(root);
 await prepareProduct(root,{summary:'Fixture planning reviewed',artifacts:['planning.md']});
}
async function implement(root){
 await mkdir(join(root,'src'));await mkdir(join(root,'tests'));await writeFile(join(root,'src/booking.js'),'export const book = () => true;');await writeFile(join(root,'tests/booking.test.js'),'// Fixture mapped test');await writeFile(join(root,'validation.md'),'Fixture test result');
 await edit(root,'features/booking/feature.json',f=>{f.status='implemented';f.components=[{id:'booking-service',path:'src/booking.js',dependsOn:[]}];f.tests=[{id:'booking-unit',type:'unit',path:'tests/booking.test.js',command:'node --test tests/booking.test.js'}];});await syncProduct(root);
}
const results=[{id:'booking-unit',status:'passed',command:'node --test tests/booking.test.js',result:'Fixture passing result'}];
const record=status=>({assessments:Object.fromEntries(['documentation','userFlows','unitTests'].map(key=>[key,{status,reason:status==='updated'?'Recorded initial implementation':'Reviewed: existing behavior and checks remain applicable'}])),tests:results,artifacts:['validation.md']});
test('initialization creates root planning documents and readiness requires domains/features',()=>fixture(async root=>{
 const p=JSON.parse(await readFile(join(root,'PRODUCT.json')));for(const path of Object.values(p.documents))assert.ok((await readFile(join(root,path))).length);
 await assert.rejects(checkProductPrepared(root),/before implementation/);await assert.rejects(prepareProduct(root,{summary:'x',artifacts:['PRODUCT-SCOPE.md']}),/domains/);
 await plan(root);assert.equal((await checkProductPrepared(root)).ready,true);
 await writeFile(join(root,'PRODUCT-ROADMAP.md'),'Milestone revised');await assert.rejects(checkProductPrepared(root),/planning documents changed/);
 await prepareProduct(root,{summary:'Reviewed revised milestone',artifacts:['planning.md']});await checkProductPrepared(root);
 await edit(root,'features/booking/feature.json',f=>f.domainIds=[]);await assert.rejects(checkProductPrepared(root),/planning documents changed/);
}));
test('code changes invalidate synchronization until docs, flows and tests are assessed with results',()=>fixture(async root=>{
 await plan(root);await implement(root);await assert.rejects(checkProduct(root),/out of sync/);
 const missing=record('updated');delete missing.assessments.userFlows;await assert.rejects(syncFeature(root,'booking',missing),/userFlows assessment/);
 await assert.rejects(syncFeature(root,'booking',{...record('updated'),tests:[]}),/passing results/);
 await syncFeature(root,'booking',record('updated'));await checkProduct(root);
 await writeFile(join(root,'src/booking.js'),'export const book = () => false;');await assert.rejects(checkFeatureSync(root,'booking'),/out of sync/);
 const noReason=record('unchanged');noReason.assessments.documentation.reason='';await assert.rejects(syncFeature(root,'booking',noReason),/status and reason/);
 await syncFeature(root,'booking',record('unchanged'));await checkProduct(root);
 await writeFile(join(root,'features/booking/USER-FLOWS.md'),'Updated failure flow');await assert.rejects(syncFeature(root,'booking',record('unchanged')),/userFlows changed/);
 const updated=record('unchanged');updated.assessments.userFlows={status:'updated',reason:'Updated failure path'};await syncFeature(root,'booking',updated);await checkProduct(root);
 await writeFile(join(root,'validation.md'),'Edited check output');await assert.rejects(checkFeatureSync(root,'booking'),/validation evidence changed/);
}));
test('generated feature list and root documentation stay checked; stale releases are refused',()=>fixture(async root=>{
 await plan(root);await implement(root);await syncFeature(root,'booking',record('updated'));await writeFile(join(root,'FEATURES.md'),'Stale feature list');await assert.rejects(checkProduct(root),/Feature list is stale/);await syncProduct(root);await checkProduct(root);
 await writeFile(join(root,'USER-GUIDE.md'),'Updated usage');await assert.rejects(checkProduct(root),/out of sync/);
 const release={version:'0.1.0',codeRevision:'fixture',changes:['Booking'],artifacts:['validation.md'],tests:results};await assert.rejects(releaseFeature(root,'booking',release),/out of sync/);
 const updated=record('unchanged');updated.assessments.documentation={status:'updated',reason:'Usage updated'};await syncFeature(root,'booking',updated);await releaseFeature(root,'booking',release);await checkProduct(root);
}));
test('v4 blocks initial implementation until prepared and snapshots synchronized flows',()=>fixture(async root=>{
 const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v4.json',import.meta.url)));const t=await createTask(root,graph,'Booking');const file=join(root,'.engineering/tasks',t.id,'task.json');await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Fixture');
 const e={summary:'Fixture',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'Booking C1',response:'Fixture approval'},codeFiles:['src/booking.js'],featureIds:['booking']};
 const advanceTo=async outcome=>advance(file,{outcome,expectedRevision:(await readTask(file)).revision,evidence:e});
 for(const outcome of ['ready','approved','ready'])await advanceTo(outcome);await assert.rejects(advanceTo('allowed'),/before implementation/);
 await plan(root);await advanceTo('allowed');await implement(root);await assert.rejects(advanceTo('completed'),/out of sync/);await syncFeature(root,'booking',record('updated'));await advanceTo('completed');await advanceTo('passed');
 await writeFile(join(root,'USER-FLOWS.md'),'Changed journey');await assert.rejects(advanceTo('passed'),/out of sync/);
}));
test('legacy schema 1 maps remain readable without synchronization metadata',()=>fixture(async root=>{
 await edit(root,'PRODUCT.json',p=>{p.schemaVersion=1;delete p.documents;delete p.domains;delete p.preparation;});await syncProduct(root);assert.equal((await checkProduct(root)).valid,true);
}));
test('upstream component changes invalidate downstream feature test evidence',()=>fixture(async root=>{
 await plan(root);await implement(root);await addFeature(root,'reminders','Reminders');await writeFile(join(root,'src/reminders.js'),'export const remind = () => true;');await writeFile(join(root,'tests/reminders.test.js'),'// Reminder fixture test');
 await edit(root,'features/reminders/feature.json',f=>{f.domainIds=['appointments'];f.status='implemented';f.dependsOn=['booking'];f.components=[{id:'reminders-service',path:'src/reminders.js',dependsOn:['booking-service']}];f.tests=[{id:'reminders-unit',type:'unit',path:'tests/reminders.test.js',command:'node --test tests/reminders.test.js'}];});await syncProduct(root);
 const reminderRecord={...record('updated'),tests:[{id:'reminders-unit',status:'passed',command:'node --test tests/reminders.test.js',result:'Fixture passed'}]};await syncFeature(root,'booking',record('updated'));await syncFeature(root,'reminders',reminderRecord);await checkProduct(root);
 await writeFile(join(root,'src/booking.js'),'export const book = () => false;');await assert.rejects(checkFeatureSync(root,'reminders'),/out of sync/);
 await assert.rejects(syncFeature(root,'reminders',{...reminderRecord,tests:[]}),/passing results/);
 await syncFeature(root,'booking',record('unchanged'));await syncFeature(root,'reminders',{...reminderRecord,assessments:record('unchanged').assessments});await checkProduct(root);
}));
