const text=value=>typeof value==='string'&&value.trim().length>0;
function strings(values,label){if(!Array.isArray(values)||!values.length||values.some(v=>!text(v))||new Set(values).size!==values.length)throw Error(`Engineering ${label} requires distinct nonempty values`);}
export function validateEngineeringPlan(plan){
  if(!plan||!text(plan.slice)||!text(plan.reuse)||!Array.isArray(plan.decisions)||!plan.decisions.length)throw Error('Engineering plan requires a vertical slice, reuse assessment and design decisions');
  const ids=new Set();for(const decision of plan.decisions){
    if(!decision||!text(decision.id)||ids.has(decision.id)||!text(decision.pattern)||!text(decision.reason)||!text(decision.tradeoffs))throw Error('Design decisions require unique IDs, pattern, reason and tradeoffs');
    strings(decision.alternatives,'decision alternatives');strings(decision.paths,'decision paths');ids.add(decision.id);
  }
  strings(plan.validationCommands,'validation commands');return plan;
}
function decisionsCovered(plan,ids){validateEngineeringPlan(plan);strings(ids,'decision IDs');if(ids.length!==plan.decisions.length||plan.decisions.some(d=>!ids.includes(d.id)))throw Error('Engineering evidence must cover every current design decision');}
export function validateEngineeringImplementation(plan,record){
  if(!record||!text(record.reuseResult)||!text(record.summary))throw Error('Implementation requires engineering summary and reuse result');
  decisionsCovered(plan,record.decisionIds);
  const p=record.performance;
  if(!p||!['measured','not-applicable'].includes(p.status)||!text(p.reason))throw Error('Engineering performance assessment requires status and reason');
  if(p.status==='measured'&&(!text(p.command)||!text(p.result)))throw Error('Measured performance requires command and result');
  return record;
}
export function validateEngineeringReview(plan,record){
  if(!record)throw Error('Review pass requires engineering review evidence');decisionsCovered(plan,record.decisionIds);
  for(const name of ['simplicity','boundaries','testability','performance','scopeAndReuse'])if(record.checks?.[name]?.status!=='passed'||!text(record.checks[name].evidence))throw Error(`Engineering review requires passed ${name} check with evidence`);
  return record;
}

export function validateDecisionAnalysis(analysis){
  if(!analysis||!text(analysis.id)||!['product','domain','architecture','feature','component','delivery','operations'].includes(analysis.level)||!text(analysis.proposal)||!['agree','disagree','conditional'].includes(analysis.stance))throw Error('Decision analysis requires ID, level, proposal and reasoned stance');
  strings(analysis.decisionCriteria,'decision criteria');
  if(!Array.isArray(analysis.constraints)||analysis.constraints.some(c=>!text(c))||!['high','medium','low','unknown'].includes(analysis.confidence))throw Error('Decision analysis requires constraints and recommendation confidence');
  strings(analysis.reasons,'agreement/disagreement reasons');strings(analysis.evidence,'decision evidence');
  if(!Array.isArray(analysis.assumptions)||analysis.assumptions.some(a=>!text(a)))throw Error('Decision assumptions must be recorded (an empty array is allowed)');
  if(!Array.isArray(analysis.options)||analysis.options.length<2)throw Error('Compare at least two realistic options');
  const ids=new Set();for(const option of analysis.options){
    if(!option||!text(option.id)||ids.has(option.id)||!text(option.description))throw Error('Decision options require distinct IDs and descriptions');ids.add(option.id);
    for(const field of ['pros','cons','risks'])strings(option[field],`option ${field}`);
    for(const category of ['build','operate','maintain','migrate']){
      const cost=option.costs?.[category];if(!cost||!text(cost.estimate)||!text(cost.basis)||!['high','medium','low','unknown'].includes(cost.confidence))throw Error(`Option ${category} cost requires estimate, basis and confidence`);
    }
  }
  if(!ids.has(analysis.proposedOptionId)||!ids.has(analysis.recommendedOptionId)||!text(analysis.recommendationReason)||!text(analysis.revisitWhen))throw Error('Recommendation must select a compared option with rationale and revisit trigger');
  if(analysis.stance==='agree'&&analysis.recommendedOptionId!==analysis.proposedOptionId)throw Error('Agreement must recommend the proposed option');
  if(analysis.stance==='disagree'&&analysis.recommendedOptionId===analysis.proposedOptionId)throw Error('Disagreement must recommend an alternative');
  if(analysis.stance==='conditional')strings(analysis.conditions,'conditions for agreement');
  return analysis;
}
export function validateProposalAssessment(assessments){
  if(!Array.isArray(assessments)||!assessments.length)throw Error('Discovery/replanning requires proposalAssessment');
  const ids=new Set();for(const analysis of assessments){validateDecisionAnalysis(analysis);if(ids.has(analysis.id))throw Error('Duplicate proposal assessment ID');ids.add(analysis.id);}
  if(!assessments.some(a=>a.level==='product'))throw Error('Proposal assessment must cover product scope');return assessments;
}
export function validateCriticalPlanning(plan){
  validateEngineeringPlan(plan);for(const decision of plan.decisions){validateDecisionAnalysis(decision.analysis);if(decision.analysis.id!==decision.id)throw Error('Design decision analysis ID must match its decision');}return plan;
}
