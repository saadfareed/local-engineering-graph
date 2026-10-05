import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateEngineeringPlan,validateEngineeringImplementation,validateEngineeringReview} from '../src/quality.js';
import {createTask,readTask,advance} from '../src/state.js';
const plan={slice:'Create one appointment end to end',reuse:'Reuse the existing form and persistence interface',decisions:[{id:'D1',pattern:'Simple feature module',reason:'One stable use case needs no additional abstraction',alternatives:['Separate service hierarchy'],tradeoffs:'May extract an interface when a second provider is required',paths:['src/booking.js']}],validationCommands:['node --test tests/booking.test.js']};
const implementation={summary:'Built the approved vertical slice',reuseResult:'Reused form and existing persistence interface',decisionIds:['D1'],performance:{status:'not-applicable',reason:'No hot path or stated latency requirement changed'}};
const review={decisionIds:['D1'],checks:Object.fromEntries(['simplicity','boundaries','testability','performance','scopeAndReuse'].map(name=>[name,{status:'passed',evidence:'Fixture review evidence for '+name}]))};
test('patterns need justification, alternatives and tradeoffs; simple modules are valid',()=>{
 assert.equal(validateEngineeringPlan(plan),plan);const bad=structuredClone(plan);bad.decisions[0].tradeoffs='';assert.throws(()=>validateEngineeringPlan(bad),/tradeoffs/);
 const duplicate=structuredClone(plan);duplicate.decisions.push(duplicate.decisions[0]);assert.throws(()=>validateEngineeringPlan(duplicate),/unique IDs/);
});
test('implementation covers approved decisions and supports measured or explained performance',()=>{
 validateEngineeringImplementation(plan,implementation);assert.throws(()=>validateEngineeringImplementation(plan,{...implementation,decisionIds:['D2']}),/every current design decision/);
 assert.throws(()=>validateEngineeringImplementation(plan,{...implementation,performance:{status:'measured',reason:'Hot path'}}),/command and result/);
 validateEngineeringImplementation(plan,{...implementation,performance:{status:'measured',reason:'Hot path changed',command:'node bench.js',result:'Fixture benchmark results recorded'}});
});
test('passing review needs evidence for all engineering checks',()=>{
 validateEngineeringReview(plan,review);const bad=structuredClone(review);bad.checks.testability.status='failed';assert.throws(()=>validateEngineeringReview(plan,bad),/testability/);
});
test('quality-enabled graph enforces planning, implementation and review evidence, clears decisions on replan',async()=>{
 const root=await mkdtemp(join(tmpdir(),'engineering-quality-'));
 try{
  const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v5.json',import.meta.url)));delete graph.productMap;delete graph.productPreparation;
  const t=await createTask(root,graph,'Fixture implementation'),file=join(root,'.engineering/tasks',t.id,'task.json');await writeFile(join(root,'src.js'),'fixture');await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Fixture report');
  const evidence={summary:'Fixture',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'Fixture slice',response:'Fixture approval'},codeFiles:['src.js']};
  const step=(outcome,extra={})=>readTask(file).then(t=>advance(file,{outcome,expectedRevision:t.revision,evidence:{...evidence,...extra}}));
  await step('ready');await step('approved');await assert.rejects(step('ready'),/Engineering plan/);await step('ready',{engineeringPlan:plan});await step('allowed');
  await assert.rejects(step('completed'),/engineering summary/);await step('completed',{engineering:implementation});await assert.rejects(step('passed'),/engineering review/);await step('passed',{engineeringReview:review});
  await step('failed');await step('replan');const current=await readTask(file);assert.equal(current.node,'scope_approval');assert.equal(current.engineeringPlan,undefined);assert.equal(current.engineering,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
