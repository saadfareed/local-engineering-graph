import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {SwarmBus,ensureKeys,verifyEvidenceFile,verifySigned,signRecord,runProcess} from '../src/daemon/bus.js';
import {assertValid} from '../src/schema/validate.js';
import {scaffoldProject,cleanup,fakeWorker,PACKAGE_ROOT} from './meta-os-helpers.mjs';

const git=(cwd,args)=>spawnSync('git',args,{cwd,encoding:'utf8'}).stdout.trim();
const LAYOUT=JSON.parse(await readFile(join(PACKAGE_ROOT,'src','schema','ui-layout.schema.json'),'utf8'));

test('runProcess: captures exit codes, hashed logs and timeouts without a shell',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rp-'));
  const ok=await runProcess(['node','-e','console.log("hi");process.exit(0)'],{cwd:dir,logPrefix:join(dir,'ok')});
  assert.equal(ok.exitCode,0);assert.match(ok.stdoutPreview,/hi/);assert.match(ok.stdoutSha256,/^[a-f0-9]{64}$/);
  const slow=await runProcess(['node','-e','setTimeout(()=>{},5000)'],{cwd:dir,timeoutMs:200});
  assert.equal(slow.timedOut,true);assert.notEqual(slow.exitCode,0);
  await assert.rejects(runProcess(['node',''],{cwd:dir}),/argv/);
});
test('evidence signing: Ed25519 keys are created once, signatures verify and tampering is detected',async()=>{
  const osHome=await mkdtemp(join(tmpdir(),'oshome-'));
  const k1=await ensureKeys(osHome),k2=await ensureKeys(osHome);
  assert.equal(k1.fingerprint,k2.fingerprint);
  const signed=signRecord({unit:'u1',passed:true},k1);
  assert.deepEqual(verifySigned(signed,k1.publicPem),{ok:true,reason:null});
  const tampered={...signed,record:{...signed.record,passed:false}};
  assert.equal(verifySigned(tampered,k1.publicPem).ok,false);
  const other=await ensureKeys(await mkdtemp(join(tmpdir(),'oshome2-')));
  assert.equal(verifySigned(signed,other.publicPem).ok,false);
});
test('swarm bus: isolates units in worktrees, merges only verified units, signs evidence and serves layouts',async()=>{
  const root=await scaffoldProject({git:true});const osHome=await mkdtemp(join(tmpdir(),'oshome-'));
  try{
    const worker=await fakeWorker(root);
    const taskDir=join(root,'.engineering','tasks','task-1');
    const bus=new SwarmBus({root,taskDir,osHome,contextCompiler:async u=>({markdown:`# ctx ${u.id}`})});
    const events=[];bus.on('event',e=>events.push(e.type));
    const {server,port}=await bus.serve();
    try{
      const {report,signed}=await bus.dispatch({units:[{id:'u1',brief:'build u1',endpointId:'orders.create'},{id:'u2',brief:'build u2'},{id:'bad',brief:'fails'},{id:'idle',brief:'no output'}],
        worker:{argv:['node',worker,'{unit}']},verifiers:[{id:'exists',argv:['node','-e','require("node:fs").statSync(process.argv[1])','{unit}.txt']}],
        integrationVerifiers:[{id:'count',argv:['node','-e','if(require("node:fs").readdirSync(".").filter(f=>f.endsWith(".txt")).length!==2)process.exit(1)']}],concurrency:3});
      assert.deepEqual(report.units.map(u=>[u.unit,u.status]),[['u1','merged'],['u2','merged'],['bad','failed'],['idle','failed']]);
      assert.equal(report.passed,false,'a failed unit fails the swarm even though integration verifiers passed');
      assert.equal(report.integrationVerifiers[0].passed,true);
      const keys=await ensureKeys(osHome);
      assert.equal((await verifyEvidenceFile(join(taskDir,'swarm','swarm-report.json'),keys.publicPem)).ok,true);
      const u1=JSON.parse(await readFile(join(taskDir,'swarm','u1','evidence.json'),'utf8'));
      assert.equal(verifySigned(u1,keys.publicPem).ok,true);
      assert.deepEqual(u1.record.changedFiles,['u1.txt']);assert.equal(u1.record.contextSha256.length,64);assert.equal(u1.record.endpointId,'orders.create');
      const idle=JSON.parse(await readFile(join(taskDir,'swarm','idle','evidence.json'),'utf8'));
      assert.deepEqual(idle.record.failureReasons,['verifier failed','no changes produced']);
      assert.equal(git(root,['rev-parse','--verify',`${report.integrationBranch}^{commit}`]),report.integrationSha);
      assert.equal(git(root,['log','--oneline',report.integrationBranch]).split('\n').length,5,'base + 2 worker commits + 2 merges');
      assert.ok(!git(root,['worktree','list']).includes('/u1'),'merged worktrees are cleaned up');
      assert.ok(git(root,['worktree','list']).includes('/bad'),'failed worktrees are kept for inspection');
      assert.equal(git(root,['status','--porcelain','--untracked-files=no']),'','main checkout untouched');
      const log=(await readFile(join(root,'.engineering','events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
      assert.equal(log[0].type,'swarm.started');assert.equal(log.at(-1).type,'swarm.finished');assert.ok(events.includes('unit.merged')&&events.includes('unit.failed'));
      const layout=await (await fetch(`http://127.0.0.1:${port}/layout`)).json();
      assertValid(LAYOUT,layout,'layout');assert.match(layout.title,/failed$/);
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/state`)).json()).units.u1.status,'merged');
      assert.equal(signed.sha256.length,64);
    }finally{server.close();}
    const ok=await new SwarmBus({root,taskDir:join(root,'.engineering','tasks','task-2'),osHome}).dispatch({units:[{id:'u1',brief:'b'},{id:'u2',brief:'b'}],worker:{argv:['node',worker,'{unit}']},verifiers:[{id:'t',argv:['node','-e','process.exit(0)']}]});
    assert.equal(ok.report.passed,true);
    await assert.rejects(new SwarmBus({root,taskDir:join(root,'.engineering','tasks','task-3'),osHome}).dispatch({units:[{id:'u1',brief:'b'},{id:'u1',brief:'b'}]}),/Duplicate unit id/);
  }finally{await cleanup(root);}
});
test('swarm bus: merge conflicts are reported, not merged',async()=>{
  const root=await scaffoldProject({git:true});const osHome=await mkdtemp(join(tmpdir(),'oshome-'));
  try{
    const worker=join(root,'conflict-worker.mjs');
    await writeFile(worker,`import {writeFileSync} from 'node:fs';writeFileSync('shared.txt','written by '+process.env.ENGINEERING_OS_UNIT+'\\n');`);
    const {report}=await new SwarmBus({root,taskDir:join(root,'.engineering','tasks','t'),osHome}).dispatch({units:[{id:'a',brief:'x'},{id:'b',brief:'y'}],worker:{argv:['node',worker]},verifiers:[{id:'ok',argv:['node','-e','process.exit(0)']}],concurrency:1});
    assert.deepEqual(report.units.map(u=>u.status),['merged','conflict']);assert.equal(report.passed,false);
  }finally{await cleanup(root);}
});
