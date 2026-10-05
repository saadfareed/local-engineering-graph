import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateDecisionAnalysis,validateCriticalPlanning} from '../src/quality.js';
import {createTask,readTask,advance} from '../src/state.js';
const costs=()=>Object.fromEntries(['build','operate','maintain','migrate'].map(category=>[category,{estimate:'Unknown until project discovery',basis:'No measured baseline or provider quote available',confidence:'unknown'}]));
const option=(id,description)=>({id,description,pros:['Fits the fixture requirements'],cons:['Has a maintenance tradeoff'],risks:['Needs verification against real usage'],costs:costs()});
const analysis={id:'D1',level:'product',proposal:'Split the initial product into multiple services',stance:'disagree',decisionCriteria:['Meets scope','Total effort','Operational complexity'],constraints:['One team'],confidence:'medium',reasons:['The fixture has one team and no independently scaled workload'],evidence:['Fixture brief: one team, one initial workflow'],assumptions:['Deployment needs remain simple'],options:[option('services','Multiple services'),option('module','One modular application')],proposedOptionId:'services',recommendedOptionId:'module',recommendationReason:'The modular option meets the stated needs with less operational overhead',revisitWhen:'Independent deployment or scaling becomes a demonstrated requirement'};
const plan={slice:'One workflow',reuse:'Existing modules',validationCommands:['node tests/workflow.js'],decisions:[{id:'D1',pattern:'Modular application',reason:'Fits scope',alternatives:['Multiple services'],tradeoffs:'Shared deployment',paths:['src.js'],analysis:{...analysis,level:'architecture'}}]};
test('agreement/disagreement must have reasons, evidence, tradeoffs and a consistent recommendation',()=>{
 validateDecisionAnalysis(analysis);const missing=structuredClone(analysis);missing.reasons=[];assert.throws(()=>validateDecisionAnalysis(missing),/reasons/);
 const inconsistent=structuredClone(analysis);inconsistent.recommendedOptionId='services';assert.throws(()=>validateDecisionAnalysis(inconsistent),/alternative/);
 const agreed={...analysis,stance:'agree',recommendedOptionId:'services'};validateDecisionAnalysis(agreed);
 const conditional={...agreed,stance:'conditional'};assert.throws(()=>validateDecisionAnalysis(conditional),/conditions/);validateDecisionAnalysis({...conditional,conditions:['An independent deployment requirement is verified']});
});
test('unknown costs are explicit; missing lifecycle costing and incomplete comparisons are refused',()=>{
 validateDecisionAnalysis(analysis);const missing=structuredClone(analysis);delete missing.options[0].costs.maintain;assert.throws(()=>validateDecisionAnalysis(missing),/maintain cost/);
 const noBasis=structuredClone(analysis);noBasis.options[0].costs.build.basis='';assert.throws(()=>validateDecisionAnalysis(noBasis),/basis/);
 assert.throws(()=>validateDecisionAnalysis({...analysis,options:[analysis.options[0]]}),/two realistic options/);
});
test('every material engineering decision has a matching decision analysis',()=>{
 validateCriticalPlanning(plan);const missing=structuredClone(plan);delete missing.decisions[0].analysis;assert.throws(()=>validateCriticalPlanning(missing),/Decision analysis/);
 const mismatch=structuredClone(plan);mismatch.decisions[0].analysis.id='D2';assert.throws(()=>validateCriticalPlanning(mismatch),/ID must match/);
});
test('v6 requires discovery/planning assessments and refreshes product assessment on replan',async()=>{
 const root=await mkdtemp(join(tmpdir(),'critical-planning-'));
 try{
  const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v6.json',import.meta.url)));delete graph.productMap;delete graph.productPreparation;
  const t=await createTask(root,graph,'Fixture'),file=join(root,'.engineering/tasks',t.id,'task.json');await writeFile(join(root,'src.js'),'fixture');await writeFile(join(root,'.engineering/tasks',t.id,'report.md'),'Fixture comparison');
  const evidence={summary:'Fixture evidence',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'Fixture scope',response:'Fixture approval'},codeFiles:['src.js']};
  const step=async(outcome,extra={})=>advance(file,{outcome,expectedRevision:(await readTask(file)).revision,evidence:{...evidence,...extra}});
  await assert.rejects(step('ready'),/proposalAssessment/);await step('ready',{proposalAssessment:[analysis]});await step('approved');await assert.rejects(step('ready'),/Engineering plan/);await step('ready',{engineeringPlan:plan});await step('allowed');
  await assert.rejects(step('replan'),/proposalAssessment/);const revised={...analysis,id:'P2',proposal:'Revised fixture scope'};await step('replan',{proposalAssessment:[revised]});const current=await readTask(file);assert.equal(current.node,'scope_approval');assert.equal(current.proposalAssessment[0].id,'P2');assert.equal(current.engineeringPlan,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
