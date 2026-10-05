import {mkdir,readFile,writeFile,rename,open,unlink,stat} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {validateGraph} from './graph.js';
const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const key=e=>`${e.from}:${e.outcome}`;
const remaining=(t,e)=>e.maxTraversals-(t.traversals[key(e)]??0);
export async function createTask(root,graph,objective,{supersedes}={}) {
  validateGraph(graph);if(!objective?.trim())throw Error('Objective required');
  if(supersedes)await readTask(supersedes);
  const id=randomUUID(),dir=join(resolve(root),'.engineering','tasks',id);
  await mkdir(dir,{recursive:true});
  const task={schemaVersion:2,id,objective,root:resolve(root),supersedes:supersedes?resolve(supersedes):null,graph:structuredClone(graph),graphHash:digest(graph),node:graph.start,revision:0,traversals:{},events:[],code:null};
  await writeFile(join(dir,'task.json'),JSON.stringify(task,null,2),{flag:'wx'});return task;
}
export async function readTask(file){
  const t=JSON.parse(await readFile(file,'utf8'));
  if(![1,2].includes(t.schemaVersion)||digest(t.graph)!==t.graphHash||!t.graph.nodes[t.node]||!Number.isInteger(t.revision)||t.revision<0||!Array.isArray(t.events)||!t.traversals)throw Error('Unsupported or corrupted task');
  validateGraph(t.graph);return t;
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
async function snapshots(root,paths){
  if(!Array.isArray(paths)||!paths.length)throw Error('Code files required');
  const result={};for(const p of paths){if(typeof p!=='string'||!p)throw Error('Invalid code path');const full=resolve(root,p),rel=relative(root,full);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Code path escapes project');result[p]=digest(await readFile(full));}return result;
}
async function checkEvidence(file,t,outcome,e){
  if(t.graph.evidenceMode!=='structured'){if(typeof e!=='string'||!e.trim())throw Error('Evidence or decision required');return;}
  if(!e||typeof e!=='object'||typeof e.summary!=='string'||!e.summary.trim()||!Array.isArray(e.artifacts)||!e.artifacts.length)throw Error('Structured evidence requires summary and artifacts');
  for(const p of e.artifacts){if(typeof p!=='string'||!p)throw Error('Invalid artifact path');await readFile(resolve(dirname(file),p));}
  const role=t.graph.nodes[t.node].role;
  if(t.graph.nodes[t.node].type==='approval'){
    if(!e.approval||e.approval.decision!==outcome||typeof e.approval.scope!=='string'||!e.approval.scope.trim()||typeof e.approval.response!=='string'||!e.approval.response.trim())throw Error('Approval requires matching decision, scope and actual response');
  }
  if(role==='worker'&&outcome==='completed')t.code=await snapshots(t.root,e.codeFiles);
  if(['reviewer','validator'].includes(role)&&['passed','changes_required','failed'].includes(outcome)){
    if(!t.code)throw Error('Implementation code snapshot required');
    if(outcome==='passed'&&digest(await snapshots(t.root,Object.keys(t.code)))!==digest(t.code))throw Error('Code changed since implementation; return to implementation before passing');
    if(role==='validator'&&outcome==='passed'&&(!Array.isArray(e.criteria)||!e.criteria.length||e.criteria.some(c=>!c.id||c.status!=='verified'||typeof c.command!=='string'||!c.command.trim()||typeof c.result!=='string'||!c.result.trim())))throw Error('Validation requires verified criteria with commands and results');
  }
}
export async function advance(file,{outcome,evidence,expectedRevision}){
  return mutate(file,expectedRevision,async t=>{
    if(t.graph.nodes[t.node].type==='terminal')throw Error('Task already terminated');
    const edge=t.graph.edges.find(e=>e.from===t.node&&e.outcome===outcome);if(!edge)throw Error('Invalid outcome');
    if(remaining(t,edge)<=0)throw Error('Traversal budget exhausted; cancel or supersede task');
    const submission=t.graph.nodes[edge.to].submissionOutcome;
    if(submission){const exit=t.graph.edges.find(e=>e.from===edge.to&&e.outcome===submission);if(!exit||remaining(t,exit)<=0)throw Error('No implementation submissions remain; cancel or supersede task before doing more work');}
    await checkEvidence(file,t,outcome,evidence);
    if(outcome==='replan')t.code=null;
    t.traversals[key(edge)]=(t.traversals[key(edge)]??0)+1;
    t.events.push({revision:t.revision+1,node:t.node,outcome,evidence,time:new Date().toISOString()});t.node=edge.to;t.revision++;
  });
}
export async function cancel(file,{expectedRevision,reason}){
  return mutate(file,expectedRevision,t=>{if(t.graph.nodes[t.node].type==='terminal')throw Error('Task already terminated');if(typeof reason!=='string'||!reason.trim())throw Error('Cancellation reason required');const terminal=Object.keys(t.graph.nodes).find(id=>t.graph.nodes[id].type==='terminal'&&!t.graph.nodes[id].success);if(!terminal)throw Error('No unsuccessful terminal available');t.events.push({revision:t.revision+1,node:t.node,outcome:'cancelled',evidence:reason,time:new Date().toISOString()});t.node=terminal;t.revision++;});
}
export async function status(file){const t=await readTask(file);return {...t,remainingOutcomes:Object.fromEntries(t.graph.edges.filter(e=>e.from===t.node).map(e=>[e.outcome,remaining(t,e)]))};}
