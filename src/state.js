import {mkdir,readFile,writeFile,rename,open,unlink,stat,readdir,realpath} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {checkProduct,loadProduct,checkProductPrepared} from './product.js';
import {validateEngineeringPlan,validateEngineeringImplementation,validateEngineeringReview,validateProposalAssessment,validateCriticalPlanning} from './quality.js';
import {validateGraph} from './graph.js';
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const key=e=>`${e.from}:${e.outcome}`;
const remaining=(t,e)=>e.maxTraversals-(t.traversals[key(e)]??0);
export async function createTask(root,graph,objective,{supersedes}={}) {
  validateGraph(graph);if(!objective?.trim())throw Error('Objective required');
  if(supersedes)await readTask(supersedes);
  const id=randomUUID(),dir=join(resolve(root),'.engineering','tasks',id);
  await mkdir(dir,{recursive:true});
  const task={schemaVersion:3,id,objective,root:resolve(root),supersedes:supersedes?resolve(supersedes):null,graph:structuredClone(graph),graphHash:digest(graph),node:graph.start,revision:0,traversals:{},events:[],code:null};
  await writeFile(join(dir,'task.json'),JSON.stringify(task,null,2),{flag:'wx'});return task;
}
export async function readTask(file){
  const t=JSON.parse(await readFile(file,'utf8'));
  if(!t||typeof t!=='object'||!t.graph||typeof t.graph!=='object')throw Error('Unsupported or corrupted task');
  if(![1,2,3].includes(t.schemaVersion)||digest(t.graph)!==t.graphHash||!t.graph.nodes[t.node]||!Number.isInteger(t.revision)||t.revision<0||!Array.isArray(t.events)||!t.traversals)throw Error('Unsupported or corrupted task');
  validateGraph(t.graph);
  validateHistory(t);
  return t;
}
function validateHistory(t) {
  if(!t.traversals||typeof t.traversals!=='object'||Array.isArray(t.traversals)||Object.values(t.traversals).some(v=>!Number.isSafeInteger(v)||v<0)) throw Error('Corrupted traversal counts');
  let node=t.graph.start;
  let approvedScope;
  const counts=Object.create(null);
  for (const [index,event] of t.events.entries()) {
    if (t.graph.nodes[node].type==='terminal') throw Error('Corrupted terminal history');
    if (!event || event.revision!==index+1 || event.node!==node) throw Error('Corrupted task history');
    if(t.schemaVersion===3&&t.graph.evidenceMode==='structured'&&event.outcome!=='cancelled') {
      const e=event.evidence;
      if(!e||!e.artifactSnapshot||typeof e.artifactSnapshot!=='object'||!Array.isArray(e.artifacts)||e.artifacts.some(path=>typeof e.artifactSnapshot[path]!=='string'||!/^[a-f0-9]{64}$/.test(e.artifactSnapshot[path]))) throw Error('Corrupted evidence snapshot');
      if(t.graph.nodes[node].type==='approval'&&event.outcome==='approved') approvedScope={scope:e.approval?.scope,criteriaIds:e.approval?.criteriaIds,artifacts:e.artifactSnapshot};
      if(event.outcome==='replan')approvedScope=undefined;
    }
    if (event.outcome==='cancelled') {
      node=Object.keys(t.graph.nodes).find(id=>t.graph.nodes[id].type==='terminal'&&!t.graph.nodes[id].success);
      if (!node) throw Error('Corrupted cancellation');
    } else {
      const edge=t.graph.edges.find(e=>e.from===node&&e.outcome===event.outcome);
      if (!edge) throw Error('Corrupted task transition');
      counts[key(edge)]=(counts[key(edge)]??0)+1;
      if (counts[key(edge)]>edge.maxTraversals) throw Error('Corrupted traversal budget');
      node=edge.to;
    }
  }
  if (node!==t.node || t.revision!==t.events.length ||
      Object.keys(t.traversals).length!==Object.keys(counts).length ||
      Object.entries(counts).some(([k,v])=>t.traversals[k]!==v)) throw Error('Corrupted task state');
  if(t.schemaVersion===3&&digest(t.approvedScope??null)!==digest(approvedScope??null))throw Error('Corrupted approval state');
  if (t.schemaVersion===3 && (typeof t.root!=='string'||!isAbsolute(t.root)||typeof t.id!=='string')) throw Error('Invalid task root or ID');
}
async function safeFile(root,path) {
  if (typeof path!=='string'||!path||isAbsolute(path)) throw Error('Paths must be relative');
  const full=resolve(root,path),base=await realpath(root),actual=await realpath(full),rel=relative(base,actual);
  if (rel==='..'||rel.startsWith('../')||isAbsolute(rel)) throw Error('Path escapes project or task directory');
  if (!(await stat(full)).isFile()) throw Error('Expected file');
  return readFile(full);
}
async function artifactSnapshot(file,paths) {
  const result=Object.create(null);
  for (const path of paths) result[path]=digest(await safeFile(dirname(file),path));
  return result;
}
async function verifyApproval(file,t) {
  if (t.schemaVersion!==3 || !t.approvedScope) return;
  if (digest(await artifactSnapshot(file,Object.keys(t.approvedScope.artifacts)))!==digest(t.approvedScope.artifacts)) throw Error('Approved artifacts changed; replan before implementation or passing');
}
async function projectSnapshot(root) {
  const result=Object.create(null);
  const excluded=new Set(['.git','.engineering','node_modules','.product-map.lock','.product-map.recover']);
  async function walk(directory) {
    for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name)) continue;
      const full=join(directory,entry.name),path=relative(root,full);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()||entry.isSymbolicLink()) result[path]=digest(await safeFile(root,path));
      else throw Error(`Unsupported snapshot entry: ${path}`);
    }
  }
  await walk(root);return result;
}
async function acquire(file){
  let lock;
  try{lock=await open(`${file}.lock`,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Task is locked; use recover TASK_FILE after the writer exits');throw e;}
  try{await lock.writeFile(JSON.stringify({pid:process.pid,host:hostname(),createdAt:new Date().toISOString()}));await lock.sync();}
  catch(e){await lock.close();await unlink(`${file}.lock`);throw e;}
  return lock;
}
async function save(file,t){
  const tmp=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(tmp,JSON.stringify(t,null,2));await rename(tmp,file);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function mutate(file,expectedRevision,fn){
  const lock=await acquire(file);
  try{const t=await readTask(file);if(t.revision!==expectedRevision)throw Error('Stale revision');await fn(t);await save(file,t);return t;}
  finally{await lock.close();await unlink(`${file}.lock`);}
}
export async function recover(file){
  // A separate recovery mutex prevents two recovery commands racing each other.
  const recovery=await open(`${file}.recover`,'wx');
  try{
    const path=`${file}.lock`,before=await stat(path),raw=await readFile(path,'utf8');
    let metadata;try{metadata=JSON.parse(raw);}catch{throw Error('Lock metadata is incomplete; inspect manually before recovery');}
    if(metadata.host!==hostname()||!Number.isInteger(metadata.pid)||metadata.pid<1)throw Error('Cannot establish local lock ownership; inspect manually');
    try{process.kill(metadata.pid,0);throw Error('Writer is still active; recovery refused');}catch(e){if(e.code!=='ESRCH')throw e;}
    await readTask(file);
    const backup=`${file}.backup.${randomUUID()}`;await writeFile(backup,await readFile(file),{flag:'wx'});
    const after=await stat(path);if(before.ino!==after.ino||raw!==await readFile(path,'utf8'))throw Error('Lock changed during recovery');
    await unlink(path);return {recovered:true,backup};
  }finally{await recovery.close();await unlink(`${file}.recover`);}
}
async function snapshots(root,paths,strict=true){
  if(!Array.isArray(paths)||!paths.length)throw Error('Code files required');
  const result=Object.create(null);for(const p of paths){if(typeof p!=='string'||!p)throw Error('Invalid code path');const full=resolve(root,p),rel=relative(root,full);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('Code path escapes project');result[p]=digest(strict?await safeFile(root,p):await readFile(full));}return result;
}
async function checkEvidence(file,t,outcome,e){
  if(t.graph.evidenceMode!=='structured'){if(typeof e!=='string'||!e.trim())throw Error('Evidence or decision required');return;}
  if(!e||typeof e!=='object'||typeof e.summary!=='string'||!e.summary.trim()||!Array.isArray(e.artifacts)||!e.artifacts.length)throw Error('Structured evidence requires summary and artifacts');
  for(const p of e.artifacts){if(typeof p!=='string'||!p)throw Error('Invalid artifact path');if(t.schemaVersion===3)await safeFile(dirname(file),p);else await readFile(resolve(dirname(file),p));}
  const role=t.graph.nodes[t.node].role;
  if (t.schemaVersion===3) e.artifactSnapshot=await artifactSnapshot(file,e.artifacts);
  if(t.graph.nodes[t.node].type==='approval'){
    if(!e.approval||e.approval.decision!==outcome||typeof e.approval.scope!=='string'||!e.approval.scope.trim()||typeof e.approval.response!=='string'||!e.approval.response.trim())throw Error('Approval requires matching decision, scope and actual response');
  }
  if (t.schemaVersion===3 && t.graph.nodes[t.node].type==='approval' && outcome==='approved') {
    const ids=e.approval.criteriaIds;
    if (!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length) throw Error('Approval requires distinct criteriaIds');
    t.approvedScope={scope:e.approval.scope,criteriaIds:[...ids],artifacts:e.artifactSnapshot};
  }
  if(t.graph.criticalPlanning&&((role==='supreme-coordinator'&&outcome==='ready')||outcome==='replan'))t.proposalAssessment=structuredClone(validateProposalAssessment(e.proposalAssessment));
  if(t.graph.criticalPlanning&&role==='planner'&&outcome==='ready')validateCriticalPlanning(e.engineeringPlan);
  if(t.graph.engineeringQuality&&role==='planner'&&outcome==='ready')t.engineeringPlan=structuredClone(validateEngineeringPlan(e.engineeringPlan));
  if(t.graph.engineeringQuality&&role==='worker'&&outcome==='completed')t.engineering=structuredClone(validateEngineeringImplementation(t.engineeringPlan,e.engineering));
  if(t.graph.engineeringQuality&&role==='reviewer'&&outcome==='passed')validateEngineeringReview(t.engineeringPlan,e.engineeringReview);
  if(role==='worker'&&outcome==='completed'){
    let files=e.codeFiles;
    if(t.graph.productMap){
      await checkProduct(t.root);const model=await loadProduct(t.root);
      if(!Array.isArray(e.featureIds)||!e.featureIds.length||new Set(e.featureIds).size!==e.featureIds.length)throw Error('Implementation requires distinct featureIds');
      const mapped=[];
      for(const id of e.featureIds){const f=model.features.get(id);if(!f||f.status!=='implemented')throw Error(`Feature must be registered and implemented: ${id}`);mapped.push(f.manifestPath,f.scope,f.policies,...(model.product.schemaVersion===2?[f.documentation,f.userFlows,join(f.directory,'synchronization.json')]:[]),...f.components.map(c=>c.path),...f.tests.map(test=>test.path));}
      if(!Array.isArray(files))throw Error('Code files required');
      files=[...new Set([...files,...mapped,'PRODUCT.json','PRODUCT.md',model.product.policies,model.product.architecture,...(model.product.schemaVersion===2?Object.values(model.product.documents):[])])];
      t.featureIds=e.featureIds;
    }
    t.code=await snapshots(t.root,files,t.schemaVersion===3);
    if(t.schemaVersion===3) t.projectSnapshot=await projectSnapshot(t.root);
  }
  if(t.graph.productMap&&['reviewer','validator'].includes(role)&&outcome==='passed')await checkProduct(t.root);
  if(['reviewer','validator'].includes(role)&&['passed','changes_required','failed'].includes(outcome)){
    if(!t.code)throw Error('Implementation code snapshot required');
    if(outcome==='passed'&&digest(await snapshots(t.root,Object.keys(t.code),t.schemaVersion===3))!==digest(t.code))throw Error('Code changed since implementation; return to implementation before passing');
    if(outcome==='passed'&&t.schemaVersion===3&&digest(await projectSnapshot(t.root))!==digest(t.projectSnapshot)) throw Error('Code changed in project since implementation; return to implementation before passing');
    if(role==='validator'&&outcome==='passed'&&(!Array.isArray(e.criteria)||!e.criteria.length||e.criteria.some(c=>!c.id||c.status!=='verified'||typeof c.command!=='string'||!c.command.trim()||typeof c.result!=='string'||!c.result.trim())))throw Error('Validation requires verified criteria with commands and results');
    if(role==='validator'&&outcome==='passed'&&t.schemaVersion===3) {
      const ids=e.criteria.map(c=>c.id),required=t.approvedScope?.criteriaIds;
      if(!required||new Set(ids).size!==ids.length||ids.length!==required.length||required.some(id=>!ids.includes(id))) throw Error('Validation must cover every approved criterion exactly once');
    }
  }
}
export async function advance(file,{outcome,evidence,expectedRevision}){
  return mutate(file,expectedRevision,async t=>{
    if(t.graph.nodes[t.node].type==='terminal')throw Error('Task already terminated');
    const edge=t.graph.edges.find(e=>e.from===t.node&&e.outcome===outcome);if(!edge)throw Error('Invalid outcome');
    if(remaining(t,edge)<=0)throw Error('Traversal budget exhausted; cancel or supersede task');
    const submission=t.graph.nodes[edge.to].submissionOutcome;
    if(submission){const exit=t.graph.edges.find(e=>e.from===edge.to&&e.outcome===submission);if(!exit||remaining(t,exit)<=0)throw Error('No implementation submissions remain; cancel or supersede task before doing more work');}
    if(t.graph.productPreparation&&t.graph.nodes[edge.to].role==='worker'&&(!t.code||t.graph.nodes[t.node].role==='domain-coordinator'))await checkProductPrepared(t.root);
    if(outcome!=='replan'&&(t.graph.nodes[edge.to].role==='worker'||outcome==='passed')) await verifyApproval(file,t);
    evidence=structuredClone(evidence);
    await checkEvidence(file,t,outcome,evidence);
    if(outcome==='replan'){t.code=null;delete t.approvedScope;delete t.projectSnapshot;delete t.featureIds;delete t.engineeringPlan;delete t.engineering;}
    t.traversals[key(edge)]=(t.traversals[key(edge)]??0)+1;
    t.events.push({revision:t.revision+1,node:t.node,outcome,evidence,time:new Date().toISOString()});t.node=edge.to;t.revision++;
  });
}
export async function cancel(file,{expectedRevision,reason}){
  return mutate(file,expectedRevision,t=>{if(t.graph.nodes[t.node].type==='terminal')throw Error('Task already terminated');if(typeof reason!=='string'||!reason.trim())throw Error('Cancellation reason required');const terminal=Object.keys(t.graph.nodes).find(id=>t.graph.nodes[id].type==='terminal'&&!t.graph.nodes[id].success);if(!terminal)throw Error('No unsuccessful terminal available');t.events.push({revision:t.revision+1,node:t.node,outcome:'cancelled',evidence:reason,time:new Date().toISOString()});t.node=terminal;t.revision++;});
}
export async function status(file){
  const t=await readTask(file),changedArtifacts=[];
  for(const event of t.events) for(const [path,expected] of Object.entries(event.evidence?.artifactSnapshot??{})) {
    let current;
    try { current=digest(await safeFile(dirname(file),path)); } catch { current=null; }
    if(current!==expected)changedArtifacts.push({revision:event.revision,path});
  }
  return {...t,evidenceIntegrity:{checked:t.schemaVersion===3,changedArtifacts},remainingOutcomes:Object.fromEntries(t.graph.edges.filter(e=>e.from===t.node).map(e=>[e.outcome,remaining(t,e)]))};}
