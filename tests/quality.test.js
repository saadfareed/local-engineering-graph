import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateEngineeringPlan,validateEngineeringImplementation,validateEngineeringReview,validatePlanningProtocol,validateSandboxExecution,validateContractVerification,validateReviewProtocol} from '../src/quality.js';
import {createTask,readTask,status,advance} from '../src/state.js';
import {runCheck} from '../src/checks.js';
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
test('productivity protocols require runnable stage checks and contract coverage',()=>{
 const planning={environment:'local repository',summary:'Checked stack and contract approach',checks:[{purpose:'validate plan',command:'npm run validate'}],deliverySurfaces:['backend','frontend','mobile'],integrationContract:{path:'contracts/api.yaml',format:'OpenAPI',version:'1.0.0',demoCommand:'npm run demo-api',validationCommand:'npm run lint-api',consumers:['frontend','mobile']}};
 assert.equal(validatePlanningProtocol(planning),planning);
 const missing=structuredClone(planning);missing.integrationContract.consumers=['frontend'];assert.throws(()=>validatePlanningProtocol(missing),/every declared consumer/);
 const sandbox={environment:'local sandbox',isolation:'disposable database and test credentials',setupCommand:'npm run sandbox:setup',startCommand:'npm run sandbox:start',healthCommand:'npm run sandbox:health',healthResult:'ready',shutdownCommand:'npm run sandbox:stop',checks:[{purpose:'focused tests',command:'npm test'}],substitutions:[]};
 assert.equal(validateSandboxExecution(sandbox),sandbox);assert.throws(()=>validateSandboxExecution({...sandbox,healthResult:''}),/sandbox setup/);
  const contracts={contractVersion:'1.0.0',contractHash:'a'.repeat(64),providerChecks:[{purpose:'provider contract',command:'npm run test:provider'}],consumerChecks:[{surface:'frontend',command:'npm run test:web-contract',result:'passed'},{surface:'mobile',command:'npm run test:mobile-contract',result:'passed'}],sandboxEndToEnd:{status:'passed',command:'npm run test:e2e',result:'passed'}};
  assert.equal(validateContractVerification(planning,contracts),contracts);assert.throws(()=>validateContractVerification(planning,{...contracts,consumerChecks:contracts.consumerChecks.slice(0,1)}),/every consumer/);
  assert.throws(()=>validatePlanningProtocol({...planning,deliverySurfaces:['backend','front-end']}),/supported delivery surfaces/);
  assert.throws(()=>validateContractVerification(planning,{...contracts,sandboxEndToEnd:{...contracts.sandboxEndToEnd,status:'blocked'}}),/cannot complete implementation/);
 assert.equal(validateReviewProtocol({environment:'local',summary:'Reviewed integration',checks:[{purpose:'contract diff',command:'npm run contract:diff'}]}).summary,'Reviewed integration');
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
test('v7 runner enforces plan approval, sandbox execution and stage protocols',async()=>{
 const root=await mkdtemp(join(tmpdir(),'productivity-v7-'));
 try{
  const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v7.json',import.meta.url)));delete graph.productMap;delete graph.productPreparation;delete graph.engineeringQuality;delete graph.criticalPlanning;
  const t=await createTask(root,graph,'Fixture full-stack implementation'),file=join(root,'.engineering/tasks',t.id,'task.json');
  await writeFile(join(root,'src.js'),'fixture');await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Fixture report');
  await writeFile(join(root,'.engineering/tasks',t.id,'plan.md'),'# Fixture plan\n\nC1: verify the slice.');
  const contract='{"version":"1.0.0"}';await writeFile(join(root,'contract.json'),contract);
  const contractHash=createHash('sha256').update(contract).digest('hex');
  const base={summary:'Fixture',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'Fixture plan',response:'Approved fixture plan'},codeFiles:['src.js']};
  const step=(outcome,extra={})=>readTask(file).then(t=>advance(file,{outcome,expectedRevision:t.revision,evidence:{...base,...extra}}));
  const checked=async(output)=>{const argv=[process.execPath,'-e',output?`process.stdout.write('${output}')`:'process.exit(0)'];const result=await runCheck(file,await readTask(file),{argv});return {purpose:'fixture check',command:argv.join(' '),run:{path:result.path,sha256:result.sha256}};};
  await step('ready');await step('approved');
  await assert.rejects(step('ready'),/Planning protocol/);
  await step('ready',{planningProtocol:{environment:'local',summary:'Inspected plan',checks:[await checked()],deliverySurfaces:['backend','frontend'],integrationContract:{path:'contract.json',format:'JSON',version:'1.0.0',demoCommand:'node demo.js',validationCommand:'node validate.js',consumers:['frontend']}}});
  const planningRun=(await readTask(file)).events.at(-1).evidence.planningProtocol.checks[0].run;
  const planningReport=join(root,'.engineering/tasks',t.id,planningRun.path),originalReport=await readFile(planningReport);
  await writeFile(planningReport,'{}');
  assert.equal((await status(file)).checkIntegrity.changedChecks.length,1);
  await writeFile(planningReport,originalReport);
  assert.equal((await readTask(file)).node,'plan_approval');
  await assert.rejects(step('approved'),/Markdown plan artifact/);
  await writeFile(join(root,'contract.json'),'changed');
  assert.equal((await status(file)).contractIntegrity.changed,true);
  await assert.rejects(step('approved',{artifacts:['plan.md'],approval:{...base.approval,planArtifact:'plan.md'}}),/Integration contract changed/);
  await writeFile(join(root,'contract.json'),contract);
  await step('approved',{artifacts:['plan.md'],approval:{...base.approval,planArtifact:'plan.md'}});
  await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Changed scope');
  await assert.rejects(step('allowed'),/Approved artifacts changed/);
  await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Fixture report');
  await step('allowed');
  await assert.rejects(step('completed'),/sandbox setup/);
  const setup=await checked(),start=await checked(),health=await checked('ready'),focused=await checked(),provider=await checked(),consumer=await checked(),e2e=await checked(),shutdown=await checked();
  await step('completed',{sandboxExecution:{environment:'local',isolation:'temporary fixture',setupCommand:setup.command,setupRun:setup.run,startCommand:start.command,startRun:start.run,healthCommand:health.command,healthRun:health.run,healthResult:'passed',shutdownCommand:shutdown.command,shutdownRun:shutdown.run,checks:[focused],substitutions:[]},contractVerification:{contractVersion:'1.0.0',contractHash,providerChecks:[provider],consumerChecks:[{surface:'frontend',result:'passed',...consumer}],sandboxEndToEnd:{status:'passed',result:'passed',...e2e}}});
  await assert.rejects(step('passed'),/Review protocol/);
  await step('passed',{reviewProtocol:{environment:'local',summary:'Reviewed fixture',checks:[await checked()]}});
  await step('passed',{criteria:[{id:'C1',status:'verified',result:'passed',...await checked()}]});
  assert.equal((await readTask(file)).node,'complete');
 }finally{await rm(root,{recursive:true,force:true});}
});
