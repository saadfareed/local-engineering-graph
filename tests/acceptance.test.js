import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const graph=fileURLToPath(new URL('../graphs/product-build.v2.json',import.meta.url));
const env={...process.env};delete env.NODE_TEST_CONTEXT;

test('CLI acceptance: implement a task tracker, execute criteria, resume, repair drift and complete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'engineering-acceptance-'));
 const command=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args],{cwd:root,env})).stdout);
 try {
  const task=await command('start',root,graph,'Acceptance fixture: create, complete and delete tasks');
  const dir=join(root,'.engineering/tasks',task.id),file=join(dir,'task.json');
  await writeFile(join(dir,'brief.md'),'Test fixture scope: C1 creates and lists a task; C2 completes the selected task; C3 deletes it while preserving others. Approval is synthetic test data, not a human approval.');
  const base={summary:'Scripted acceptance fixture',artifacts:['brief.md']};
  const advance=async(outcome,extra={})=>{
   const state=await command('status',file);
   const evidence=join(dir,'transition.json');await writeFile(evidence,JSON.stringify({...base,...extra}));
   return command('advance',file,outcome,String(state.revision),'@'+evidence);
  };
  await advance('ready');
  await advance('approved',{approval:{decision:'approved',scope:'Acceptance fixture v1',response:'Synthetic approval for this automated fixture only',criteriaIds:['C1','C2','C3']}});
  await advance('ready');await advance('allowed');
  await writeFile(join(root,'tracker.mjs'),`export function createTracker() {
 const tasks = new Map(); let nextId = 1;
 return {
  add(title) { if (!title.trim()) throw Error('Title required'); const id = nextId++; tasks.set(id, {id, title, complete: false}); return id; },
  complete(id) { const task = tasks.get(id); if (!task) throw Error('Unknown task'); task.complete = true; },
  remove(id) { return tasks.delete(id); },
  list() { return [...tasks.values()].map(task => ({...task})); }
 };
}
`);
  await writeFile(join(root,'tracker.test.mjs'),`import test from 'node:test';
import assert from 'node:assert/strict';
import {createTracker} from './tracker.mjs';
test('C1: creates and lists tasks', () => { const t=createTracker(); const id=t.add('First'); assert.deepEqual(t.list(),[{id,title:'First',complete:false}]); assert.throws(()=>t.add(' '),/Title required/); });
test('C2: completes only the selected task', () => { const t=createTracker(); const a=t.add('First'); t.add('Second'); t.complete(a); assert.deepEqual(t.list().map(x=>x.complete),[true,false]); assert.throws(()=>t.complete(999),/Unknown task/); });
test('C3: deletes only the selected task', () => { const t=createTracker(); const a=t.add('First'); const b=t.add('Second'); assert.equal(t.remove(a),true); assert.deepEqual(t.list().map(x=>x.id),[b]); assert.equal(t.remove(a),false); });
`);
  let checkNumber=0,checkArtifact;
  const verify=async()=>{
   const {stdout,stderr}=await run(process.execPath,['--test','tracker.test.mjs'],{cwd:root,env});
   assert.match(stdout,/# fail 0/);checkArtifact=`test-output-${++checkNumber}.txt`;await writeFile(join(dir,checkArtifact),stdout+stderr);return stdout;
  };
  const output=await verify();
  const implementation=()=>({codeFiles:['tracker.mjs','tracker.test.mjs'],artifacts:['brief.md',checkArtifact]});
  await advance('completed',implementation());
  // Every command starts a fresh process and reloads persisted task state.
  const resumed=await command('status',file);assert.equal(resumed.node,'review');
  assert.deepEqual(resumed.codeIntegrity.changedFiles,[]);assert.deepEqual(resumed.projectIntegrity.changedPaths,[]);
  await writeFile(join(root,'tracker.mjs'),(await readFile(join(root,'tracker.mjs'),'utf8'))+'\n// external edit\n');
  const drift=await command('status',file);assert.deepEqual(drift.codeIntegrity.changedFiles,['tracker.mjs']);
  await assert.rejects(advance('passed'),error=>/Code changed/.test(error.stderr));
  await advance('changes_required');await verify();await advance('completed',implementation());
  await writeFile(join(dir,'review.md'),'Scripted self-review: scope has three operations, no external side effects; criterion tests cover target isolation and missing IDs. This is not independent review.');
  await advance('passed',{artifacts:['brief.md','review.md',checkArtifact]});
  await advance('passed',{artifacts:['brief.md','review.md',checkArtifact],criteria:['C1','C2','C3'].map(id=>({id,status:'verified',command:'node --test tracker.test.mjs',result:`Actual subprocess exited 0; all criterion tests passed. See ${checkArtifact}.`}))});
  const completed=await command('status',file);assert.equal(completed.node,'complete');
  assert.equal(completed.revision,9);assert.deepEqual(completed.evidenceIntegrity.changedArtifacts,[]);
  assert.deepEqual(completed.projectIntegrity.changedPaths,[]);assert.equal(completed.projectIntegrity.error,null);
  assert.match(output,/C1/);assert.match(output,/C2/);assert.match(output,/C3/);
 } finally {await rm(root,{recursive:true,force:true});}
});
