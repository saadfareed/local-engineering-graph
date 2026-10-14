import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,utimes,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createTask,readTask,status,advance,__snapshotCacheStats} from '../src/state.js';
import {runCheck,verifyCheckIntegrity,verifyCheck,__checkVerifyCacheStats} from '../src/checks.js';

const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const resetCheckStats=()=>{__checkVerifyCacheStats.verifications=0;__checkVerifyCacheStats.hits=0;};
const resetSnapshotStats=()=>{__snapshotCacheStats.hashes=0;__snapshotCacheStats.hits=0;};

// Minimal fixture: a v2 task with a code file, enough to runCheck + verifyCheckIntegrity directly.
async function checkFixture(fn){
  const root=await mkdtemp(join(tmpdir(),'history-cache-check-'));
  try{
    const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v2.json',import.meta.url)));
    const task=await createTask(root,graph,'History cache fixture'),file=join(root,'.engineering/tasks',task.id,'task.json');
    await writeFile(join(root,'code.js'),'original');
    await fn({root,file,task});
  }finally{await rm(root,{recursive:true,force:true});}
}

// Full v7 productivity fixture driven to `complete`, mirroring tests/quality.test.js. Produces a
// task whose events carry recorded planning/sandbox/review/criteria check runs plus artifact
// snapshots, so status() exercises historicalCheckDrift and evidence artifact drift.
async function completedV7(root){
  const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v7.json',import.meta.url)));
  delete graph.productMap;delete graph.productPreparation;delete graph.engineeringQuality;delete graph.criticalPlanning;
  const t=await createTask(root,graph,'History cache v7'),file=join(root,'.engineering/tasks',t.id,'task.json');
  const dir=join(root,'.engineering/tasks',t.id);
  await writeFile(join(root,'src.js'),'fixture');
  await writeFile(join(dir,'report.md'),'Fixture report');
  await writeFile(join(dir,'plan.md'),'# Fixture plan\n\nC1: verify the slice.');
  const contract='{"version":"1.0.0"}';await writeFile(join(root,'contract.json'),contract);
  const contractHash=createHash('sha256').update(contract).digest('hex');
  const base={summary:'Fixture',artifacts:['report.md'],approval:{criteriaIds:['C1'],decision:'approved',scope:'Fixture plan',response:'Approved fixture plan'},codeFiles:['src.js']};
  const step=(outcome,extra={})=>readTask(file).then(t=>advance(file,{outcome,expectedRevision:t.revision,evidence:{...base,...extra}}));
  const checked=async(output)=>{const argv=[process.execPath,'-e',output?`process.stdout.write('${output}')`:'process.exit(0)'];const result=await runCheck(file,await readTask(file),{argv});return {purpose:'fixture check',command:argv.join(' '),run:{path:result.path,sha256:result.sha256}};};
  await step('ready');await step('approved');
  await step('ready',{planningProtocol:{environment:'local',summary:'Inspected plan',checks:[await checked()],deliverySurfaces:['backend','frontend'],integrationContract:{path:'contract.json',format:'JSON',version:'1.0.0',demoCommand:'node demo.js',validationCommand:'node validate.js',consumers:['frontend']}}});
  await step('approved',{artifacts:['plan.md'],approval:{...base.approval,planArtifact:'plan.md'}});
  await step('allowed');
  const setup=await checked(),start=await checked(),health=await checked('ready'),focused=await checked(),provider=await checked(),consumer=await checked(),e2e=await checked(),shutdown=await checked();
  await step('completed',{sandboxExecution:{environment:'local',isolation:'temporary fixture',setupCommand:setup.command,setupRun:setup.run,startCommand:start.command,startRun:start.run,healthCommand:health.command,healthRun:health.run,healthResult:'passed',shutdownCommand:shutdown.command,shutdownRun:shutdown.run,checks:[focused],substitutions:[]},contractVerification:{contractVersion:'1.0.0',contractHash,providerChecks:[provider],consumerChecks:[{surface:'frontend',result:'passed',...consumer}],sandboxEndToEnd:{status:'passed',result:'passed',...e2e}}});
  await step('passed',{reviewProtocol:{environment:'local',summary:'Reviewed fixture',checks:[await checked()]}});
  await step('passed',{criteria:[{id:'C1',status:'verified',result:'passed',...await checked()}]});
  assert.equal((await readTask(file)).node,'complete');
  return {t,file,dir};
}

async function v7Fixture(fn){
  const root=await mkdtemp(join(tmpdir(),'history-cache-v7-'));
  try{await fn(root,await completedV7(root));}finally{await rm(root,{recursive:true,force:true});}
}

test('(a) a mutated check report is still detected after the verify cache is warm',()=>checkFixture(async({root,file,task})=>{
  const pass=await runCheck(file,task,{argv:[process.execPath,'-e','process.exit(0)']});
  const ref={path:pass.path,sha256:pass.sha256};
  // Warm the cache with a fully-passing verification.
  assert.equal((await verifyCheckIntegrity(file,task,ref,task.revision)).exitCode,0);
  const reportPath=join(root,'.engineering/tasks',task.id,pass.path),original=await readFile(reportPath);
  // Mutating the report bytes busts the sha256-keyed entry (and the stored stat): drift detected.
  await writeFile(reportPath,'{}');
  await assert.rejects(verifyCheckIntegrity(file,task,ref,task.revision),/changed|did not pass/);
  await writeFile(reportPath,original);
  // Restored bytes verify clean again.
  assert.equal((await verifyCheckIntegrity(file,task,ref,task.revision)).exitCode,0);
}));

test('(b) a mutated output log is still detected, including a same-size byte change with bumped mtime',()=>checkFixture(async({root,file,task})=>{
  const pass=await runCheck(file,task,{argv:[process.execPath,'-e',"process.stdout.write('abcd')"]});
  const ref={path:pass.path,sha256:pass.sha256};
  const dir=join(root,'.engineering/tasks',task.id);
  const stdoutPath=join(dir,pass.stdoutLog.path);
  assert.equal((await verifyCheckIntegrity(file,task,ref,task.revision)).exitCode,0);
  // Same-size byte change with a bumped mtime: the log sha differs, and the stat-keyed cache busts
  // on mtime so the full re-hash runs and catches it.
  const before=await stat(stdoutPath);
  await writeFile(stdoutPath,'wxyz');
  const future=new Date(before.mtimeMs+10000);
  await utimes(stdoutPath,future,future);
  assert.equal((await stat(stdoutPath)).size,before.size);
  await assert.rejects(verifyCheckIntegrity(file,task,ref,task.revision),/log changed/);
}));

test('(c) a mutated historical artifact is still detected via status, including a same-size byte change with bumped mtime',()=>v7Fixture(async(root,{file,dir})=>{
  // Clean baseline.
  assert.deepEqual((await status(file)).evidenceIntegrity.changedArtifacts,[]);
  const reportPath=join(dir,'report.md'),original=await readFile(reportPath,'utf8');
  assert.equal(original.length,'Fixture report'.length);
  // Same-size byte change with a bumped mtime proves mtime busts the artifact cache key.
  const before=await stat(reportPath);
  await writeFile(reportPath,'Fixture REPORT');
  const future=new Date(before.mtimeMs+10000);
  await utimes(reportPath,future,future);
  assert.equal((await stat(reportPath)).size,before.size);
  const drifted=await status(file);
  assert.ok(drifted.evidenceIntegrity.changedArtifacts.some(a=>a.path==='report.md'),'report.md drift reported');
  // Restore and confirm clean again.
  await writeFile(reportPath,original);
  assert.deepEqual((await status(file)).evidenceIntegrity.changedArtifacts,[]);
}));

test('(d) a repeat verification is served from cache: verifications flat, hits increase',()=>checkFixture(async({file,task})=>{
  const pass=await runCheck(file,task,{argv:[process.execPath,'-e','process.exit(0)']});
  const ref={path:pass.path,sha256:pass.sha256};
  resetCheckStats();
  await verifyCheckIntegrity(file,task,ref,task.revision); // first call verifies
  assert.equal(__checkVerifyCacheStats.verifications,1);
  assert.equal(__checkVerifyCacheStats.hits,0);
  await verifyCheckIntegrity(file,task,ref,task.revision); // unchanged: cache hit
  assert.equal(__checkVerifyCacheStats.verifications,1,'unchanged entry is not re-verified');
  assert.equal(__checkVerifyCacheStats.hits,1,'unchanged entry is served from cache');
}));

test('(d) status artifact reuse is observable: snapshot hits increase while hashes stay flat for unchanged artifacts',()=>v7Fixture(async(root,{file})=>{
  await status(file); // prime the artifact/content caches
  resetSnapshotStats();
  await status(file); // identical tree: unchanged artifact files served from cache, none re-hashed
  assert.equal(__snapshotCacheStats.hashes,0,'no unchanged file is re-hashed on an identical repeat');
  assert.ok(__snapshotCacheStats.hits>0,'unchanged artifacts/files are served from the content cache');
}));

test('(e) verifyCheck still runs its project comparison even with a cached verifyCheckIntegrity',()=>checkFixture(async({root,file,task})=>{
  const pass=await runCheck(file,task,{argv:[process.execPath,'-e','process.exit(0)']});
  const ref={path:pass.path,sha256:pass.sha256};
  // Warm the integrity cache so the inner sub-step is a hit on the next verifyCheck.
  resetCheckStats();
  assert.equal((await verifyCheck(file,task,ref)).exitCode,0);
  assert.equal(__checkVerifyCacheStats.verifications,1);
  // Change the project tree. The integrity sub-step is now a cache hit, but verifyCheck must still
  // recompute and compare the current project snapshot and reject.
  await writeFile(join(root,'code.js'),'changed');
  await assert.rejects(verifyCheck(file,task,ref),/Project changed/);
  assert.equal(__checkVerifyCacheStats.hits,1,'the integrity sub-step was served from cache on the rejecting call');
}));

test('(f) warm-cache status matches a cold fresh-process computation',()=>v7Fixture(async(root,{file})=>{
  // Warm run in this (cache-primed) process.
  await status(file);
  const warm=await status(file);
  // Cold run in a fresh process with empty caches.
  const run=promisify(execFile);
  const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const cold=JSON.parse((await run(process.execPath,[cli,'status',file],{cwd:root,env})).stdout);
  assert.deepEqual(warm.evidenceIntegrity.changedArtifacts,cold.evidenceIntegrity.changedArtifacts);
  assert.deepEqual(warm.checkIntegrity.changedChecks,cold.checkIntegrity.changedChecks);
  assert.deepEqual(warm.codeIntegrity.changedFiles,cold.codeIntegrity.changedFiles);
  assert.deepEqual(warm.projectIntegrity.changedPaths,cold.projectIntegrity.changedPaths);
}));
