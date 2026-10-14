import {mkdir,readFile,writeFile,rename,open,unlink,stat,readdir,realpath,lstat,readlink} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {checkProduct,loadProduct,checkProductPrepared} from './product.js';
import {validateEngineeringPlan,validateEngineeringImplementation,validateEngineeringReview,validateProposalAssessment,validateCriticalPlanning,validatePlanningProtocol,validateSandboxExecution,validateContractVerification,validateReviewProtocol} from './quality.js';
import {validateGraph} from './graph.js';
import {verifyCheck,verifyCheckIntegrity} from './checks.js';
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const key=e=>`${e.from}:${e.outcome}`;
const remaining=(t,e)=>e.maxTraversals-(t.traversals[key(e)]??0);
async function durableWrite(path,content){
  const handle=await open(path,'wx');
  try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
}
async function syncDirectory(path){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
export async function createTask(root,graph,objective,{supersedes}={}) {
  validateGraph(graph);if(!objective?.trim())throw Error('Objective required');
  if(supersedes)await readTask(supersedes);
  const id=randomUUID(),dir=join(resolve(root),'.engineering','tasks',id);
  await mkdir(dir,{recursive:true});
  const task={schemaVersion:3,id,objective,root:resolve(root),supersedes:supersedes?resolve(supersedes):null,graph:structuredClone(graph),graphHash:digest(graph),node:graph.start,revision:0,traversals:{},events:[],code:null};
  await durableWrite(join(dir,'task.json'),JSON.stringify(task,null,2));await syncDirectory(dir);return task;
}
export async function readTask(file){
  const t=JSON.parse(await readFile(file,'utf8'));
  if(!t||typeof t!=='object'||!t.graph||typeof t.graph!=='object')throw Error('Unsupported or corrupted task');
  if(t.projectSnapshotRef!==undefined){
    if(typeof t.projectSnapshotRef!=='string'||!/^[a-f0-9]{64}$/.test(t.projectSnapshotRef))throw Error('Corrupted project snapshot reference');
    if(t.projectSnapshot===undefined){
      const data=await readFile(join(dirname(file),`project-snapshot-${t.projectSnapshotRef}.json`));
      if(digest(data)!==t.projectSnapshotRef)throw Error('Corrupted project snapshot data');
      t.projectSnapshot=JSON.parse(data);
    }
  }
  if(![1,2,3].includes(t.schemaVersion)||digest(t.graph)!==t.graphHash||!t.graph.nodes[t.node]||!Number.isInteger(t.revision)||t.revision<0||!Array.isArray(t.events)||!t.traversals)throw Error('Unsupported or corrupted task');
  validateGraph(t.graph);
  if(t.projectSnapshotVersion!==undefined&&![1,2].includes(t.projectSnapshotVersion))throw Error('Unsupported project snapshot version');
  validateHistory(t);
  return t;
}
function validateHistory(t) {
  if(!t.traversals||typeof t.traversals!=='object'||Array.isArray(t.traversals)||Object.values(t.traversals).some(v=>!Number.isSafeInteger(v)||v<0)) throw Error('Corrupted traversal counts');
  let node=t.graph.start;
  let approvedScope,approvedPlan;
  const counts=Object.create(null);
  for (const [index,event] of t.events.entries()) {
    if (t.graph.nodes[node].type==='terminal') throw Error('Corrupted terminal history');
    if (!event || event.revision!==index+1 || event.node!==node) throw Error('Corrupted task history');
    if(t.schemaVersion===3&&t.graph.evidenceMode==='structured'&&event.outcome!=='cancelled') {
      const e=event.evidence;
      if(!e||!e.artifactSnapshot||typeof e.artifactSnapshot!=='object'||!Array.isArray(e.artifacts)||e.artifacts.some(path=>typeof e.artifactSnapshot[path]!=='string'||!/^[a-f0-9]{64}$/.test(e.artifactSnapshot[path]))) throw Error('Corrupted evidence snapshot');
      if(t.graph.nodes[node].type==='approval'&&event.outcome==='approved') {
        const approval={scope:e.approval?.scope,criteriaIds:e.approval?.criteriaIds,artifacts:e.artifactSnapshot};
        if(node==='plan_approval'&&t.graph.productivityProtocols&&e.approval?.planArtifact)approvedPlan={...approval,planArtifact:e.approval.planArtifact};
        else approvedScope=approval;
      }
      if(event.outcome==='replan'){approvedScope=undefined;approvedPlan=undefined;}
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
  if(t.schemaVersion===3&&digest(t.approvedPlan??null)!==digest(approvedPlan??null))throw Error('Corrupted plan approval state');
  if (t.schemaVersion===3 && (typeof t.root!=='string'||!isAbsolute(t.root)||typeof t.id!=='string')) throw Error('Invalid task root or ID');
}
async function containedFull(root,path) {
  if (typeof path!=='string'||!path||isAbsolute(path)) throw Error('Paths must be relative');
  const full=resolve(root,path),base=await realpath(root),actual=await realpath(full),rel=relative(base,actual);
  if (rel==='..'||rel.startsWith('../')||isAbsolute(rel)) throw Error('Path escapes project or task directory');
  if (!(await stat(full)).isFile()) throw Error('Expected file');
  return full;
}
async function safeFile(root,path) {return readFile(await containedFull(root,path));}
// Incremental content-hash cache keyed by absolute path + stat (size,mtimeMs). Relies on the
// "local files are trusted input" boundary (docs/architecture.md): on an honest filesystem any
// content change moves size or mtimeMs, so any stat change forces a full re-read+re-hash and
// preserves byte-identical hash outputs. The containment/realpath/isFile validation in
// containedFull still runs on every walk; only the read+hash of an already-validated path is
// cached. The Map persists for the life of the process and grows unbounded, a tradeoff that only
// matters for long-lived processes (CLI invocations are short-lived single processes).
const hashCache=new Map();
export const __snapshotCacheStats={hashes:0,hits:0};
async function cachedFileHash(root,path,size,mtimeMs,symlink) {
  const full=await containedFull(root,path);
  // Symlinks are never cached: safeFile reads the resolved target's content, but an lstat reports
  // the link's own size+mtime which does not change when the target changes, so a stat-keyed cache
  // would serve a stale hash. Links are rare; always re-read them to preserve identical hashes.
  if(symlink){__snapshotCacheStats.hashes++;return digest(await readFile(full));}
  const entry=hashCache.get(full);
  if(entry&&entry.size===size&&entry.mtimeMs===mtimeMs){__snapshotCacheStats.hits++;return entry.hash;}
  const hash=digest(await readFile(full));hashCache.set(full,{size,mtimeMs,hash});__snapshotCacheStats.hashes++;return hash;
}
async function artifactSnapshot(file,paths) {
  const result=Object.create(null);
  for (const path of paths) result[path]=digest(await safeFile(dirname(file),path));
  return result;
}
async function verifyApproval(file,t) {
  if (t.schemaVersion!==3) return;
  for(const approval of [t.approvedScope,t.approvedPlan])if(approval&&digest(await artifactSnapshot(file,Object.keys(approval.artifacts)))!==digest(approval.artifacts))throw Error('Approved artifacts changed; replan before implementation or passing');
}
export async function projectSnapshot(root,version=2,codeHashes) {
  const result=Object.create(null);
  const excluded=new Set(['.git','.engineering','node_modules','.product-map.lock','.product-map.recover']);
  const metadataAndDependencies=new Set(['.git','node_modules']);
  async function walk(directory) {
    for (const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const skip=version===1?excluded.has(entry.name):metadataAndDependencies.has(entry.name)||(directory===root&&excluded.has(entry.name));
      if (skip) continue;
      const full=join(directory,entry.name),path=relative(root,full);
      if (entry.isDirectory()) {
        if(version===2)result[path]=digest({type:'directory',mode:(await lstat(full)).mode&0o7777});
        await walk(full);
      }
      else if (entry.isFile()||entry.isSymbolicLink()) {
        const st=await lstat(full),content=await cachedFileHash(root,path,st.size,st.mtimeMs,entry.isSymbolicLink());
        codeHashes?.set(path,content);
        result[path]=version===1?content:digest({type:entry.isSymbolicLink()?'symlink':'file',mode:st.mode&0o7777,...(entry.isSymbolicLink()?{target:await readlink(full)}:{}),content});
      }
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
  const persisted={...t};
  if(t.projectSnapshot!==undefined){
    const data=JSON.stringify(t.projectSnapshot),hash=digest(data),path=join(dirname(file),`project-snapshot-${hash}.json`);
    try{await durableWrite(path,data);await syncDirectory(dirname(file));}
    catch(e){if(e.code!=='EEXIST')throw e;if(digest(await readFile(path))!==hash)throw Error('Corrupted existing project snapshot');}
    persisted.projectSnapshotRef=hash;
    delete persisted.projectSnapshot;
    t.projectSnapshotRef=hash;
  }else delete persisted.projectSnapshotRef;
  try{await durableWrite(tmp,JSON.stringify(persisted,null,2));await rename(tmp,file);await syncDirectory(dirname(file));}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
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
async function verifyRecordedChecks(file,t,checks,getSnapshot){
  if(!Array.isArray(checks)||!checks.length)throw Error('Passing stage requires executed checks');
  const reports=[];
  for(const check of checks){
    if(typeof check?.command!=='string'||!check.command.trim())throw Error('Executed check requires command');
    const report=await verifyCheck(file,t,check.run,getSnapshot?await getSnapshot():undefined);
    if(report.argv.join(' ')!==check.command)throw Error('Executed check command differs from evidence');
    reports.push(report);
  }
  return reports;
}
async function verifySandboxLifecycle(file,t,record,getSnapshot){
  const stages=['setup','start','health','shutdown'];
  const checks=stages.map(stage=>({command:record[`${stage}Command`],run:record[`${stage}Run`]}));
  const reports=await verifyRecordedChecks(file,t,checks,getSnapshot);
  for(let i=1;i<reports.length;i++)if(reports[i].startedAt<reports[i-1].finishedAt)throw Error('Sandbox lifecycle checks are out of order');
  if(record.healthResult!=='passed'&&!reports[2].stdout.includes(record.healthResult)&&!reports[2].stderr.includes(record.healthResult))throw Error('Sandbox health result does not match recorded output');
  return reports;
}
function recordedRuns(e){
  const result=[];
  for(const group of [e?.planningProtocol?.checks,e?.sandboxExecution?.checks,e?.contractVerification?.providerChecks,e?.contractVerification?.consumerChecks,e?.reviewProtocol?.checks,e?.criteria])
    if(Array.isArray(group))for(const check of group)if(check?.run)result.push(check.run);
  if(e?.contractVerification?.sandboxEndToEnd?.run)result.push(e.contractVerification.sandboxEndToEnd.run);
  if(e?.sandboxExecution)for(const stage of ['setup','start','health','shutdown'])if(e.sandboxExecution[`${stage}Run`])result.push(e.sandboxExecution[`${stage}Run`]);
  return result;
}
async function historicalCheckDrift(file,t){
  const changed=[];
  for(const event of t.events)for(const ref of recordedRuns(event.evidence)){
    try{await verifyCheckIntegrity(file,t,ref,event.revision-1);}
    catch(error){changed.push({revision:event.revision,path:ref?.path??null,error:error.message});}
  }
  return changed;
}
async function checkEvidence(file,t,outcome,e){
  if(t.graph.evidenceMode!=='structured'){if(typeof e!=='string'||!e.trim())throw Error('Evidence or decision required');return;}
  if(!e||typeof e!=='object'||typeof e.summary!=='string'||!e.summary.trim()||!Array.isArray(e.artifacts)||!e.artifacts.length)throw Error('Structured evidence requires summary and artifacts');
  for(const p of e.artifacts){if(typeof p!=='string'||!p)throw Error('Invalid artifact path');if(t.schemaVersion===3)await safeFile(dirname(file),p);else await readFile(resolve(dirname(file),p));}
  const role=t.graph.nodes[t.node].role;
  let currentCheckSnapshot;
  const getSnapshot=async()=>currentCheckSnapshot??=await projectSnapshot(t.root);
  if (t.schemaVersion===3) e.artifactSnapshot=await artifactSnapshot(file,e.artifacts);
  if(t.graph.nodes[t.node].type==='approval'){
    if(!e.approval||e.approval.decision!==outcome||typeof e.approval.scope!=='string'||!e.approval.scope.trim()||typeof e.approval.response!=='string'||!e.approval.response.trim())throw Error('Approval requires matching decision, scope and actual response');
  }
  if (t.schemaVersion===3 && t.graph.nodes[t.node].type==='approval' && outcome==='approved') {
    const ids=e.approval.criteriaIds;
    if (!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length) throw Error('Approval requires distinct criteriaIds');
    const approval={scope:e.approval.scope,criteriaIds:[...ids],artifacts:e.artifactSnapshot};
    if(t.graph.productivityProtocols&&t.node==='plan_approval'){
      if(typeof e.approval.planArtifact!=='string'||!e.artifacts.includes(e.approval.planArtifact)||!e.approval.planArtifact.toLowerCase().endsWith('.md'))throw Error('Plan approval requires a Markdown plan artifact');
      if(!t.approvedScope||ids.length!==t.approvedScope.criteriaIds.length||ids.some(id=>!t.approvedScope.criteriaIds.includes(id)))throw Error('Plan approval criteria must match approved scope criteria');
      t.approvedPlan={...approval,planArtifact:e.approval.planArtifact};
    }else t.approvedScope=approval;
  }
  if(t.graph.criticalPlanning&&((role==='supreme-coordinator'&&outcome==='ready')||outcome==='replan'))t.proposalAssessment=structuredClone(validateProposalAssessment(e.proposalAssessment));
  if(t.graph.criticalPlanning&&role==='planner'&&outcome==='ready')validateCriticalPlanning(e.engineeringPlan);
  if(t.graph.engineeringQuality&&role==='planner'&&outcome==='ready')t.engineeringPlan=structuredClone(validateEngineeringPlan(e.engineeringPlan));
  if(t.graph.engineeringQuality&&role==='worker'&&outcome==='completed')t.engineering=structuredClone(validateEngineeringImplementation(t.engineeringPlan,e.engineering));
  if(t.graph.engineeringQuality&&role==='reviewer'&&outcome==='passed')validateEngineeringReview(t.engineeringPlan,e.engineeringReview);
  if(t.graph.productivityProtocols&&role==='planner'&&outcome==='ready'){
    t.planningProtocol=structuredClone(validatePlanningProtocol(e.planningProtocol));
    await verifyRecordedChecks(file,t,e.planningProtocol.checks,getSnapshot);
    if(t.planningProtocol.integrationContract)t.contractHash=digest(await safeFile(t.root,t.planningProtocol.integrationContract.path));
  }
  if(t.graph.productivityProtocols&&role==='worker'&&outcome==='completed'){
    validateSandboxExecution(e.sandboxExecution);
    validateContractVerification(t.planningProtocol,e.contractVerification);
    const lifecycle=await verifySandboxLifecycle(file,t,e.sandboxExecution,getSnapshot);
    if(t.contractHash){
      const current=digest(await safeFile(t.root,t.planningProtocol.integrationContract.path));
      if(current!==t.contractHash||e.contractVerification.contractHash!==current)throw Error('Integration contract changed since planning; replan before implementation completion');
    }
    const focused=await verifyRecordedChecks(file,t,e.sandboxExecution.checks,getSnapshot);
    if(focused.some(report=>report.startedAt<lifecycle[2].finishedAt||report.finishedAt>lifecycle[3].startedAt))throw Error('Sandbox checks must run between health and shutdown');
    if(t.planningProtocol.integrationContract){
      await verifyRecordedChecks(file,t,e.contractVerification.providerChecks,getSnapshot);
      await verifyRecordedChecks(file,t,e.contractVerification.consumerChecks,getSnapshot);
      if(e.contractVerification.sandboxEndToEnd.status==='passed')await verifyRecordedChecks(file,t,[e.contractVerification.sandboxEndToEnd],getSnapshot);
    }
  }
  if(t.graph.productivityProtocols&&role==='reviewer'&&outcome==='passed'){
    validateReviewProtocol(e.reviewProtocol);
    await verifyRecordedChecks(file,t,e.reviewProtocol.checks,getSnapshot);
  }
  if(role==='worker'&&outcome==='completed'){
    let files=e.codeFiles;
    if(t.graph.productMap){
      await checkProduct(t.root);const model=await loadProduct(t.root);
      if(!Array.isArray(e.featureIds)||!e.featureIds.length||new Set(e.featureIds).size!==e.featureIds.length)throw Error('Implementation requires distinct featureIds');
      const mapped=[];
      for(const id of e.featureIds){
        const f=model.features.get(id);if(!f||f.status!=='implemented')throw Error(`Feature must be registered and implemented: ${id}`);
        if(t.graph.productivityProtocols){
          const executed=new Set(e.sandboxExecution.checks.map(check=>check.command));
          if(f.tests.some(test=>!executed.has(test.command)))throw Error(`Mapped feature tests need runner check records: ${id}`);
        }
        mapped.push(f.manifestPath,f.scope,f.policies,...(model.product.schemaVersion===2?[f.documentation,f.userFlows,join(f.directory,'synchronization.json')]:[]),...f.components.map(c=>c.path),...f.tests.map(test=>test.path));
      }
      if(!Array.isArray(files))throw Error('Code files required');
      files=[...new Set([...files,...mapped,'PRODUCT.json','PRODUCT.md',model.product.policies,model.product.architecture,...(model.product.schemaVersion===2?Object.values(model.product.documents):[])])];
      t.featureIds=e.featureIds;
    }
    t.code=await snapshots(t.root,files,t.schemaVersion===3);
    if(t.schemaVersion===3) {
      t.projectSnapshot=await getSnapshot(); // same root, version 2 and tree state as the memoized check snapshot
      t.projectSnapshotVersion=2;
    }
  }
  if(t.graph.productMap&&['reviewer','validator'].includes(role)&&outcome==='passed')await checkProduct(t.root);
  if(['reviewer','validator'].includes(role)&&['passed','changes_required','failed'].includes(outcome)){
    if(!t.code)throw Error('Implementation code snapshot required');
    if(outcome==='passed'&&digest(await snapshots(t.root,Object.keys(t.code),t.schemaVersion===3))!==digest(t.code))throw Error('Code changed since implementation; return to implementation before passing');
    if(outcome==='passed'&&t.schemaVersion===3&&digest(await projectSnapshot(t.root,t.projectSnapshotVersion??1))!==digest(t.projectSnapshot)) throw Error('Code changed in project since implementation; return to implementation before passing');
    if(role==='validator'&&outcome==='passed'&&(!Array.isArray(e.criteria)||!e.criteria.length||e.criteria.some(c=>!c.id||c.status!=='verified'||typeof c.command!=='string'||!c.command.trim()||typeof c.result!=='string'||!c.result.trim())))throw Error('Validation requires verified criteria with commands and results');
    if(role==='validator'&&outcome==='passed'&&t.schemaVersion===3) {
      const ids=e.criteria.map(c=>c.id),required=(t.graph.productivityProtocols?t.approvedPlan:t.approvedScope)?.criteriaIds;
      if(!required||new Set(ids).size!==ids.length||ids.length!==required.length||required.some(id=>!ids.includes(id))) throw Error('Validation must cover every approved criterion exactly once');
    }
    if(role==='validator'&&outcome==='passed'&&t.graph.productivityProtocols)await verifyRecordedChecks(file,t,e.criteria,getSnapshot);
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
    if(t.contractHash&&['approved','allowed','completed','passed'].includes(outcome)&&digest(await safeFile(t.root,t.planningProtocol.integrationContract.path))!==t.contractHash)throw Error('Integration contract changed since planning; replan');
    if(outcome!=='replan'&&(t.graph.nodes[edge.to].role==='worker'||outcome==='passed')) await verifyApproval(file,t);
    evidence=structuredClone(evidence);
    await checkEvidence(file,t,outcome,evidence);
    if(t.graph.productivityProtocols&&t.graph.nodes[edge.to].success&&await historicalCheckDrift(file,t).then(changed=>changed.length))throw Error('Historical check reports changed; restore them before completion');
    if(outcome==='replan'){t.code=null;delete t.approvedScope;delete t.approvedPlan;delete t.projectSnapshot;delete t.projectSnapshotVersion;delete t.featureIds;delete t.engineeringPlan;delete t.engineering;delete t.planningProtocol;delete t.contractHash;}
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
    try { const st=await lstat(await containedFull(dirname(file),path));current=await cachedFileHash(dirname(file),path,st.size,st.mtimeMs,st.isSymbolicLink()); } catch { current=null; }
    if(current!==expected)changedArtifacts.push({revision:event.revision,path});
  }
  const codeHashes=new Map();
  const projectIntegrity={checked:t.schemaVersion===3&&!!t.projectSnapshot,changedPaths:[],error:null};
  if(projectIntegrity.checked)try {
    const current=await projectSnapshot(t.root,t.projectSnapshotVersion??1,codeHashes);
    projectIntegrity.changedPaths=[...new Set([...Object.keys(t.projectSnapshot),...Object.keys(current)])].sort().filter(path=>t.projectSnapshot[path]!==current[path]);
  } catch(e) {projectIntegrity.error=e.message;}
  const codeIntegrity={checked:!!t.code,changedFiles:[]};
  if(t.code)for(const [path,expected] of Object.entries(t.code)) {
    let current;
    try {current=codeHashes.has(path)?codeHashes.get(path):(await snapshots(t.root,[path],t.schemaVersion===3))[path];} catch {current=null;}
    if(current!==expected)codeIntegrity.changedFiles.push(path);
  }
  const checkIntegrity={checked:!!t.graph.productivityProtocols,changedChecks:t.graph.productivityProtocols?await historicalCheckDrift(file,t):[]};
  const contractIntegrity={checked:!!t.contractHash,changed:false,error:null};
  if(contractIntegrity.checked)try{contractIntegrity.changed=digest(await safeFile(t.root,t.planningProtocol.integrationContract.path))!==t.contractHash;}catch(error){contractIntegrity.error=error.message;}
  return {...t,evidenceIntegrity:{checked:t.schemaVersion===3&&t.graph.evidenceMode==='structured',changedArtifacts},checkIntegrity,contractIntegrity,codeIntegrity,projectIntegrity,remainingOutcomes:Object.fromEntries(t.graph.edges.filter(e=>e.from===t.node).map(e=>[e.outcome,remaining(t,e)]))};}
