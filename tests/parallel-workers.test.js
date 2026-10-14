import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createTask,readTask,advance,cancel} from '../src/state.js';
import {runCheck} from '../src/checks.js';
import {validateGraph} from '../src/graph.js';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const graphsDir=fileURLToPath(new URL('../graphs/',import.meta.url));
const parentGraphPath=fileURLToPath(new URL('../graphs/parallel-build.v1.json',import.meta.url));
const childGraphPath=fileURLToPath(new URL('../graphs/product-build.v2.json',import.meta.url));
const childGraph=JSON.parse(await readFile(childGraphPath));
const parentGraph=JSON.parse(await readFile(parentGraphPath));
const env={...process.env};delete env.NODE_TEST_CONTEXT;

// ---------- Phase 0 + 1: graph validation ----------

test('parallel-build.v1.json validates',()=>{assert.ok(validateGraph(structuredClone(parentGraph)));});

test('all shipped graphs still validate',async()=>{
 const names=(await readdir(graphsDir)).filter(n=>n.endsWith('.json'));
 assert.ok(names.length>=8);
 for(const name of names)assert.ok(validateGraph(JSON.parse(await readFile(join(graphsDir,name)))));
});

test('parallelWorkers must be a boolean',()=>{
 const g=structuredClone(parentGraph);g.parallelWorkers='yes';
 assert.throws(()=>validateGraph(g),/Invalid parallel workers setting/);
});

test('parallelWorkers requires structured evidence',()=>{
 const g=structuredClone(parentGraph);delete g.evidenceMode;
 assert.throws(()=>validateGraph(g),/Parallel workers require structured evidence/);
 const g2=structuredClone(parentGraph);g2.evidenceMode='text';
 assert.throws(()=>validateGraph(g2),/Invalid evidence mode/);
});

test('flag off still requires the four base contracts (regression)',()=>{
 // A structured graph that lacks worker/reviewer/validator roles must still be rejected when the
 // parallelWorkers flag is absent. The parent graph has no such roles; without the flag it fails.
 const g=structuredClone(parentGraph);delete g.parallelWorkers;
 assert.throws(()=>validateGraph(g),/Required evidence contract missing: worker.completed/);
});

test('parallel parent whose integration node does not dominate success throws',()=>{
 const g=structuredClone(parentGraph);
 // Let dispatch reach complete directly, bypassing integration. Drop the requiredGate so the
 // evidence-contract dominator walk (not the requiredGates walk) is what rejects it.
 g.requiredGates=[];
 g.nodes.dispatch.outcomes=['ready','done','blocked'];
 g.edges.push({from:'dispatch',outcome:'done',to:'complete',maxTraversals:1});
 assert.throws(()=>validateGraph(g),/Success bypasses evidence contract: integration-coordinator.integrated/);
});

test('parallel parent keeps a user approval contract when it has an approval node',()=>{
 const g=structuredClone(parentGraph);
 // Insert a user approval node between dispatch and integration.
 g.nodes.dispatch.outcomes=['approve','blocked'];
 g.edges=g.edges.filter(e=>!(e.from==='dispatch'&&e.outcome==='ready'));
 g.nodes.approval={type:'approval',role:'user',outcomes:['approved','rejected']};
 g.edges.push({from:'dispatch',outcome:'approve',to:'approval',maxTraversals:3});
 g.edges.push({from:'approval',outcome:'approved',to:'integration',maxTraversals:3});
 g.edges.push({from:'approval',outcome:'rejected',to:'blocked',maxTraversals:1});
 assert.ok(validateGraph(g));
 // Removing the integration->complete domination while a user node exists still catches integration.
});

// ---------- Phase 2: child parent linkage ----------

async function tempRoot(prefix='parallel-'){return mkdtemp(join(tmpdir(),prefix));}
function taskFileFor(root,task){return join(root,'.engineering/tasks',task.id,'task.json');}

test('createTask records parent as an absolute path',async()=>{
 const root=await tempRoot();
 try{
  const parent=await createTask(root,parentGraph,'Parent');
  const parentFile=taskFileFor(root,parent);
  const child=await createTask(root,childGraph,'Child',{parent:parentFile});
  assert.equal(child.parent,resolve(parentFile));
  const reread=await readTask(taskFileFor(root,child));
  assert.equal(reread.parent,resolve(parentFile));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a task created without parent has parent:null and round-trips',async()=>{
 const root=await tempRoot();
 try{
  const child=await createTask(root,childGraph,'No parent');
  assert.equal(child.parent,null);
  const file=taskFileFor(root,child);
  const reread=await readTask(file);
  assert.equal(reread.parent,null);
  // Replay is unaffected: readTask round-trips without throwing.
  assert.equal(reread.revision,0);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('createTask rejects a missing or corrupt parent (like supersedes)',async()=>{
 const root=await tempRoot();
 try{
  await assert.rejects(createTask(root,childGraph,'Child',{parent:join(root,'nope.json')}));
  const corrupt=join(root,'corrupt.json');await writeFile(corrupt,'{not json');
  await assert.rejects(createTask(root,childGraph,'Child',{parent:corrupt}));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('CLI start --parent records parent, and combines with a superseded positional',async()=>{
 const root=await tempRoot();
 try{
  const command=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args],{cwd:root,env})).stdout);
  const parent=await command('start',root,parentGraphPath,'Parent');
  const parentFile=taskFileFor(root,parent);
  const child=await command('start',root,childGraphPath,'Child','--parent',parentFile);
  assert.equal(child.parent,resolve(parentFile));
  const superseded=await command('start',root,childGraphPath,'Old');
  const supersededFile=taskFileFor(root,superseded);
  const both=await command('start',root,childGraphPath,'Child2',supersededFile,'--parent',parentFile);
  assert.equal(both.parent,resolve(parentFile));
  assert.equal(both.supersedes,resolve(supersededFile));
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---------- Phase 3-5: integration gate end-to-end ----------

// Drive a product-build.v2 child all the way to its success terminal with scripted approval and a
// real criterion check-run. Returns the child's task file. Mirrors acceptance.test.js machinery.
async function buildChild(root,parentFile,name,{stopAt}={}){
 const child=await createTask(root,childGraph,name,parentFile?{parent:parentFile}:{});
 const file=taskFileFor(root,child);
 const dir=dirname(file);
 await writeFile(join(dir,'brief.md'),`Scope for ${name}: criteria C1 and C2. Synthetic approval for an automated fixture only.`);
 const base={summary:`Scripted child ${name}`,artifacts:['brief.md']};
 const step=async(outcome,extra={})=>{
  const t=await readTask(file);
  await advance(file,{outcome,expectedRevision:t.revision,evidence:{...base,...extra}});
 };
 await step('ready');
 if(stopAt==='scope_approval')return file;
 await step('approved',{approval:{decision:'approved',scope:`${name} v1`,response:'Synthetic approval',criteriaIds:['C1','C2']}});
 await step('ready');
 await step('allowed');
 // Implementation: write code the criterion test exercises.
 await writeFile(join(root,`${child.id}.js`),'export const ok=true;\n');
 const t=await readTask(file);
 await advance(file,{outcome:'completed',expectedRevision:t.revision,evidence:{...base,codeFiles:[`${child.id}.js`]}});
 if(stopAt==='review')return file;
 await step('passed'); // review
 if(stopAt==='validation')return file;
 const criteria=['C1','C2'].map(id=>({id,status:'verified',command:'node -e process.exit(0)',result:'passed'}));
 await step('passed',{criteria}); // validation -> complete
 return file;
}

// Run a combined integration check against the parent root and return a {command,run} entry.
async function integrationCheck(parentFile){
 const parent=await readTask(parentFile);
 const run=await runCheck(parentFile,parent,{argv:[process.execPath,'-e','process.exit(0)']});
 return {command:run.argv.join(' '),run:{path:run.path,sha256:run.sha256}};
}

// Advance a parent (parallel-build.v1) to its integration node, ready to accept 'integrated'.
async function dispatchParent(parentFile){
 await writeFile(join(dirname(parentFile),'dispatch.md'),'Dispatch plan: two workers alpha and beta.');
 const t=await readTask(parentFile);
 await advance(parentFile,{outcome:'ready',expectedRevision:t.revision,evidence:{summary:'dispatch',artifacts:['dispatch.md']}});
}

// childEntry takes the parent task file and the absolute child task file, and stores taskFile as a
// path relative to the parent task directory (the portable form the gate resolves).
function childEntry(parentFile,childFile,extra={}){
 const taskFile=relative(dirname(parentFile),childFile);
 return {taskFile,branch:'feature/x',mergedInto:'main',baseCommit:'a1b2c3d',headCommit:'deadbee',mergeCommit:'facef00',...extra};
}

// Build a parent + two completed children, return paths + a relative taskFile resolver.
async function parentWithChildren(root){
 const parent=await createTask(root,parentGraph,'Parent');
 const parentFile=taskFileFor(root,parent);
 const c1=await buildChild(root,parentFile,'alpha');
 const c2=await buildChild(root,parentFile,'beta');
 return {parentFile,c1,c2};
}

async function integrationArtifact(parentFile){
 await writeFile(join(dirname(parentFile),'integration.md'),'Integration report: children merged into main.');
 return 'integration.md';
}

async function integrate(parentFile,children,extra={}){
 const art=await integrationArtifact(parentFile);
 const check=await integrationCheck(parentFile);
 const t=await readTask(parentFile);
 return advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'integrated',artifacts:[art],children,integrationChecks:[check],...extra}});
}

test('integration gate: fan-out/fan-in reaches complete',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1,{branch:'feature/alpha'}),childEntry(parentFile,c2,{branch:'feature/beta'})];
  await integrate(parentFile,children);
  const done=await readTask(parentFile);
  assert.equal(done.node,'complete');
  assert.ok(done.integration);
  assert.equal(done.integration.children.length,2);
  // Convenience field is not recomputed by replay: readTask round-trips.
  assert.equal((await readTask(parentFile)).integration.mergedInto,'main');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects a child left non-terminal',async()=>{
 const root=await tempRoot();
 try{
  const parent=await createTask(root,parentGraph,'Parent');
  const parentFile=taskFileFor(root,parent);
  const c1=await buildChild(root,parentFile,'alpha');
  const c2=await buildChild(root,parentFile,'beta',{stopAt:'review'});
  await dispatchParent(parentFile);
  await assert.rejects(integrate(parentFile,[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})]),/success terminal/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects a child cancelled to an unsuccessful terminal',async()=>{
 const root=await tempRoot();
 try{
  const parent=await createTask(root,parentGraph,'Parent');
  const parentFile=taskFileFor(root,parent);
  const c1=await buildChild(root,parentFile,'alpha');
  const c2=await buildChild(root,parentFile,'beta',{stopAt:'review'});
  const t=await readTask(c2);await cancel(c2,{expectedRevision:t.revision,reason:'abandon'});
  await dispatchParent(parentFile);
  await assert.rejects(integrate(parentFile,[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})]),/success terminal/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration requires a combined integration check (mandatory)',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})];
  const art=await integrationArtifact(parentFile);
  const t=await readTask(parentFile);
  await assert.rejects(advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'x',artifacts:[art],children}}),/combined integration check/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects a stale or failing integration check',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const parent=await readTask(parentFile);
  const failing=await runCheck(parentFile,parent,{argv:[process.execPath,'-e','process.exit(3)']});
  const children=[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})];
  const art=await integrationArtifact(parentFile);
  const t=await readTask(parentFile);
  await assert.rejects(advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'x',artifacts:[art],children,integrationChecks:[{command:failing.argv.join(' '),run:{path:failing.path,sha256:failing.sha256}}]}}),/did not pass/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration fails when a child task.json is edited after terminal (integrity inheritance)',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const raw=JSON.parse(await readFile(c2,'utf8'));raw.revision=999;await writeFile(c2,JSON.stringify(raw));
  await assert.rejects(integrate(parentFile,[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})]),/Corrupted|corrupted/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects a child whose parent back-pointer mismatches',async()=>{
 const root=await tempRoot();
 try{
  const parent=await createTask(root,parentGraph,'Parent');
  const parentFile=taskFileFor(root,parent);
  const c1=await buildChild(root,parentFile,'alpha');
  const orphan=await buildChild(root,null,'orphan'); // created without --parent
  await dispatchParent(parentFile);
  await assert.rejects(integrate(parentFile,[childEntry(parentFile,c1),childEntry(parentFile,orphan,{branch:'feature/orphan'})]),/back-pointer/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects children declaring different mergedInto targets',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1,{mergedInto:'main'}),childEntry(parentFile,c2,{branch:'feature/beta',mergedInto:'develop'})];
  await assert.rejects(integrate(parentFile,children),/single mergedInto/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects a malformed SHA',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1,{baseCommit:'xyz'}),childEntry(parentFile,c2,{branch:'feature/beta'})];
  await assert.rejects(integrate(parentFile,children),/malformed SHA/);
  // Also a hex string longer than 40 is rejected.
  const children2=[childEntry(parentFile,c1,{headCommit:'a'.repeat(41)}),childEntry(parentFile,c2,{branch:'feature/beta'})];
  const t=await readTask(parentFile);
  await assert.rejects(integrate(parentFile,children2),/malformed SHA/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('integration rejects duplicate taskFile and escaping taskFile',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  await assert.rejects(integrate(parentFile,[childEntry(parentFile,c1),childEntry(parentFile,c1,{branch:'feature/dup'})]),/distinct/);
  const art=await integrationArtifact(parentFile);
  const t=await readTask(parentFile);
  const escaping={taskFile:'../../../../../../etc/passwd',branch:'x',mergedInto:'main'};
  await assert.rejects(advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'x',artifacts:[art],children:[escaping],integrationChecks:[await integrationCheck(parentFile)]}}),/escapes|relative|Expected file/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('mergeCommit equal to baseCommit is rejected',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1,{baseCommit:'abcdef0',mergeCommit:'abcdef0'}),childEntry(parentFile,c2,{branch:'feature/beta'})];
  await assert.rejects(integrate(parentFile,children),/mergeCommit must differ/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('optional ancestryChecks: passing accepted, project-mutating rejected, absent allowed',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})];
  // Write all artifacts first so the tree is stable before any check binds to it.
  const art=await integrationArtifact(parentFile);
  const parent=await readTask(parentFile);
  // Passing ancestry + integration checks (stubbed with node, not real git) are accepted.
  const ancestry=await runCheck(parentFile,parent,{argv:[process.execPath,'-e','process.exit(0)']});
  const check=await runCheck(parentFile,parent,{argv:[process.execPath,'-e','process.exit(0)']});
  const t=await readTask(parentFile);
  await advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'integrated',artifacts:[art],children,integrationChecks:[{command:check.argv.join(' '),run:{path:check.path,sha256:check.sha256}}],ancestryChecks:[{command:ancestry.argv.join(' '),run:{path:ancestry.path,sha256:ancestry.sha256}}]}});
  assert.equal((await readTask(parentFile)).node,'complete');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a project-mutating ancestry check is rejected',async()=>{
 const root=await tempRoot();
 try{
  const {parentFile,c1,c2}=await parentWithChildren(root);
  await dispatchParent(parentFile);
  const children=[childEntry(parentFile,c1),childEntry(parentFile,c2,{branch:'feature/beta'})];
  const art=await integrationArtifact(parentFile);
  const parent=await readTask(parentFile);
  const check=await runCheck(parentFile,parent,{argv:[process.execPath,'-e','process.exit(0)']});
  // An ancestry check that mutated the project during its own run is rejected by verifyCheck.
  const mutating=await runCheck(parentFile,parent,{argv:[process.execPath,'-e',"require('fs').writeFileSync('mutated.txt','x')"]});
  // Remove the mutation so the mandatory integration check still binds to a stable tree; the
  // ancestry check is rejected on its own recorded projectChangedDuringRun flag.
  await rm(join(dirname(parentFile),'mutated.txt'),{force:true});
  const t=await readTask(parentFile);
  await assert.rejects(advance(parentFile,{outcome:'integrated',expectedRevision:t.revision,evidence:{summary:'x',artifacts:[art],children,integrationChecks:[{command:check.argv.join(' '),run:{path:check.path,sha256:check.sha256}}],ancestryChecks:[{command:mutating.argv.join(' '),run:{path:mutating.path,sha256:mutating.sha256}}]}}),/did not pass|Project changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---------- Phase 5: concurrency ----------

test('two children advance in parallel without lock contention, then integrate',async()=>{
 const root=await tempRoot('parallel-conc-');
 try{
  const parent=await createTask(root,parentGraph,'Parent');
  const parentFile=taskFileFor(root,parent);
  // Build both children concurrently; independent per-file locks mean no EEXIST contention.
  const [c1,c2]=await Promise.all([buildChild(root,parentFile,'alpha'),buildChild(root,parentFile,'beta')]);
  await dispatchParent(parentFile);
  await integrate(parentFile,[childEntry(parentFile,c1,{branch:'feature/alpha'}),childEntry(parentFile,c2,{branch:'feature/beta'})]);
  assert.equal((await readTask(parentFile)).node,'complete');
 }finally{await rm(root,{recursive:true,force:true});}
});

// ---------- Backward compatibility ----------

test('a normal non-parallel task flow produces no parent/integration artifacts',async()=>{
 const root=await tempRoot('parallel-bc-');
 try{
  const t=await createTask(root,childGraph,'Normal');
  const file=taskFileFor(root,t);
  assert.equal(t.parent,null);
  const raw=JSON.parse(await readFile(file,'utf8'));
  assert.equal(raw.parent,null);
  assert.equal(raw.integration,undefined);
  const reread=await readTask(file);
  assert.equal(reread.integration,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
