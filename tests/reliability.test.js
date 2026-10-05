import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createTask,advance,readTask,recover,cancel,status} from '../src/state.js';
const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v2.json',import.meta.url)));
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'graph-v2-'));try{const t=await createTask(root,graph,'Demo');const file=join(root,'.engineering','tasks',t.id,'task.json');await writeFile(join(root,'app.js'),'original');await writeFile(join(root,'.engineering','tasks',t.id,'report.md'),'report');await fn({root,file});}finally{await rm(root,{recursive:true,force:true});}}
const evidence=outcome=>({summary:'Recorded result',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:outcome,scope:'brief version 1',response:'actual recorded response'},codeFiles:['app.js'],criteria:[{id:'C1',status:'verified',command:'npm test',result:'passed'}]});
async function route(file,outcomes){for(const outcome of outcomes){const t=await readTask(file);await advance(file,{outcome,expectedRevision:t.revision,evidence:evidence(outcome)});}}
test('v2 requires artifacts and approval details; reaches complete',()=>fixture(async({file})=>{
 await assert.rejects(advance(file,{outcome:'ready',expectedRevision:0,evidence:'text'}),/Structured/);
 await assert.rejects(advance(file,{outcome:'ready',expectedRevision:0,evidence:{summary:'x',artifacts:['missing']}}),/ENOENT/);
 await route(file,['ready']);await assert.rejects(advance(file,{outcome:'approved',expectedRevision:1,evidence:{summary:'x',artifacts:['report.md']}}),/Approval/);
 await route(file,['approved','ready','allowed','completed','passed','passed']);assert.equal((await readTask(file)).node,'complete');
}));
test('changed code invalidates passes but permits repair routing',()=>fixture(async({root,file})=>{
 await route(file,['ready','approved','ready','allowed','completed']);await writeFile(join(root,'app.js'),'changed');
 await assert.rejects(route(file,['passed']),/Code changed/);await route(file,['changes_required','completed','passed']);
 const t=await readTask(file);const e=evidence('passed');e.criteria[0].status='unverified';await assert.rejects(advance(file,{outcome:'passed',expectedRevision:t.revision,evidence:e}),/verified criteria/);
 await writeFile(join(root,'app.js'),'changed again');await assert.rejects(route(file,['passed']),/Code changed/);await route(file,['failed']);
}));
test('replan requires renewed approval and exhausted repairs are refused before implementation',()=>fixture(async({file})=>{
 await route(file,['ready','approved','ready','allowed','replan']);assert.equal((await readTask(file)).node,'scope_approval');
 await route(file,['approved','ready','allowed','completed','changes_required','completed','changes_required','completed']);
 await assert.rejects(route(file,['changes_required']),/No implementation submissions/);assert.equal((await readTask(file)).node,'review');
 await cancel(file,{expectedRevision:(await readTask(file)).revision,reason:'Retries exhausted'});assert.equal((await readTask(file)).node,'blocked');
}));
test('concurrent writers allow one transition and release lock',()=>fixture(async({file})=>{
 const results=await Promise.allSettled([1,2].map(()=>advance(file,{outcome:'ready',expectedRevision:0,evidence:evidence('ready')})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await status(file)).revision,1);await assert.rejects(access(file+'.lock'),/ENOENT/);
}));
test('recovery refuses active/incomplete locks; backs up and removes dead writer lock',()=>fixture(async({file})=>{
 await writeFile(file+'.lock',JSON.stringify({pid:process.pid,host:hostname()}));await assert.rejects(recover(file),/still active/);
 await writeFile(file+'.lock','');await assert.rejects(recover(file),/incomplete/);
 const child=spawn(process.execPath,['-e','']);await once(child,'exit');await writeFile(file+'.lock',JSON.stringify({pid:child.pid,host:hostname()}));
 const result=await recover(file);assert.equal(result.recovered,true);await access(result.backup);await assert.rejects(access(file+'.lock'),/ENOENT/);
}));
