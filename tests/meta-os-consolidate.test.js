import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,readdir,mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {MemoryStore} from '../src/memory/store.js';
import {appendDelta,consolidate,lineDiff,slug} from '../src/memory/consolidate.js';
import {scaffoldProject,cleanup} from './meta-os-helpers.mjs';

const card={cardId:'card-stack-t1',question:'Which framework for the orders service?',recommendedOptionId:'fastapi',chosenOptionId:'nestjs',chosenLabel:'NestJS',overrodeRecommendation:true,humanRationale:'Team is TypeScript-only; keep one language.',
  options:[{id:'fastapi',label:'FastAPI',summary:'async python',tradeoffs:{pros:['fast to write'],cons:['second language']}},{id:'nestjs',label:'NestJS',summary:'unified TS',tradeoffs:{pros:['one language'],cons:['heavier DI'],risks:['ORM maturity']}}],impact:{endpoints:['orders.create'],reversibility:'hard'}};

test('lineDiff and slug are deterministic',()=>{
  assert.deepEqual(lineDiff('a\nb\nc','a\nB\nc\nd').hunks.map(h=>h.op+h.text),['-b','+B','+d']);
  assert.equal(slug('Never log address payloads!'),'never-log-address-payloads');
});
test('HITL deltas are schema-validated and appended as JSONL',async()=>{
  const root=await scaffoldProject();
  try{
    const store=new MemoryStore();
    const d=await appendDelta({root,store,delta:{kind:'preference',taskId:'t1',actor:'human',preference:{statement:'Prefer repositories over active record',category:'architecture'}}});
    assert.match(d.deltaId,/^delta-/);assert.equal(d.ruleKey,'prefer-repositories-over-active-record');
    await assert.rejects(appendDelta({root,store,delta:{kind:'review_rejection',taskId:'t1',actor:'human'}}),/missing required property "review"/);
    await assert.rejects(appendDelta({root,store,delta:{kind:'spec_edit',taskId:'t1',actor:'robot',edit:{path:'x',before:'',after:''}}}),/actor/);
    const lines=(await readFile(join(root,'.engineering','human-overrides.jsonl'),'utf8')).trim().split('\n');
    assert.equal(lines.length,1);assert.equal(store.stats().pendingDeltas,1);
  }finally{await cleanup(root);}
});
test('sleep cycle: ADRs, rule promotion after repeated feedback, preferences, episodic edits, idempotency',async()=>{
  const root=await scaffoldProject();const osHome=await mkdtemp(join(tmpdir(),'oshome-'));
  try{
    const store=new MemoryStore();
    await appendDelta({root,store,delta:{kind:'decision_card_answer',taskId:'t1',node:'stack_selection',actor:'human',card}});
    for(const t of ['t1','t2'])await appendDelta({root,store,delta:{kind:'review_rejection',taskId:t,actor:'human',review:{rule:'Never log address payloads',finding:'logger.info(address)',severity:'major',scope:'global'}}});
    await appendDelta({root,store,delta:{kind:'review_rejection',taskId:'t1',actor:'human',review:{rule:'Use early returns',finding:'nested ifs'}}});
    await appendDelta({root,store,delta:{kind:'spec_edit',taskId:'t1',actor:'human',edit:{path:'docs/api/orders/create/spec.md',before:'a\nb',after:'a\nB',reason:'tighten 409'}}});
    await appendDelta({root,store,delta:{kind:'preference',taskId:'t1',actor:'human',preference:{statement:'Prefer explicit repository classes',category:'architecture',scope:'global'}}});
    await appendDelta({root,store,delta:{kind:'preference',taskId:'t1',actor:'agent',preference:{statement:'agent noise must be ignored'}}});
    const r1=await consolidate({root,store,osHome,promoteAfter:3,runId:'run1'});
    assert.equal(r1.adrs.length,1);assert.match(r1.adrs[0].file,/^docs\/adr\/ADR-0001-which-framework/);
    const adr=await readFile(join(root,r1.adrs[0].file),'utf8');
    assert.match(adr,/### NestJS \(chosen\)/);assert.match(adr,/### FastAPI \(agent recommendation\)/);assert.match(adr,/overriding the agent recommendation/);assert.match(adr,/Rationale \(human\): Team is TypeScript-only/);
    assert.deepEqual(r1.promotedRules,[]);
    assert.deepEqual(r1.candidates.map(c=>[c.ruleKey,c.occurrences]),[['never-log-address-payloads',2],['never-log-address-payloads',2],['use-early-returns',1]]);
    assert.ok(r1.preferences.includes('pref:prefer-explicit-repository-classes'));assert.ok(r1.preferences.some(p=>p.startsWith('pref:team-is-typescript-only')));
    assert.equal(r1.episodes.length,1);assert.equal(r1.consolidatedDeltas.length,6);
    assert.equal(store.stats().pendingDeltas,1,'agent-authored delta is left alone');
    assert.equal(store.get('episodic','adr:0001').files[0].path,r1.adrs[0].file);
    // Third occurrence of the same rule in a third task promotes it.
    await appendDelta({root,store,delta:{kind:'review_rejection',taskId:'t3',actor:'human',review:{rule:'Never log address payloads',finding:'again',scope:'global'}}});
    const r2=await consolidate({root,store,osHome,promoteAfter:3,runId:'run2'});
    assert.deepEqual(r2.promotedRules,[{ruleKey:'never-log-address-payloads',occurrences:3,scope:'global'}]);assert.equal(r2.adrs.length,0);
    const learned=JSON.parse(await readFile(join(root,'policies','learned.json'),'utf8'));
    assert.equal(learned.rules[0].id,'learned-never-log-address-payloads');assert.equal(learned.rules[0].enforcement,'instructional');
    assert.match(await readFile(join(osHome,'alignment','rules.jsonl'),'utf8'),/never-log-address-payloads/);
    assert.equal(store.recall({query:'log address payload',tiers:['alignment']})[0].key,'rule:never-log-address-payloads');
    const r3=await consolidate({root,store,osHome,promoteAfter:3,runId:'run3'});
    assert.deepEqual([r3.adrs.length,r3.promotedRules.length,r3.consolidatedDeltas.length],[0,0,0],'idempotent');
    assert.equal((await readdir(join(root,'docs','adr'))).length,1);
    assert.equal(JSON.parse(await readFile(join(root,'policies','learned.json'),'utf8')).rules.length,1);
    assert.equal(store.consolidationLog('run2').map(l=>l.action).includes('rule_promoted'),true);
    const episodes=(await readFile(join(root,'.engineering','memory','episodes.jsonl'),'utf8')).trim().split('\n');
    assert.equal(episodes.length,2);
    store.close();
  }finally{await cleanup(root);}
});
test('sleep cycle: merged swarm units become procedural blueprints',async()=>{
  const root=await scaffoldProject();const osHome=await mkdtemp(join(tmpdir(),'oshome-'));
  try{
    const store=new MemoryStore();
    const swarmDir=join(root,'.engineering','tasks','t9','swarm');await mkdir(join(swarmDir,'u1'),{recursive:true});
    await writeFile(join(swarmDir,'u1','evidence.json'),JSON.stringify({record:{changedFiles:['app/orders/router.py','app/orders/service.py'],verifiers:[{id:'tests',command:'pytest -q'}]}}));
    await writeFile(join(swarmDir,'swarm-report.json'),JSON.stringify({record:{taskId:'t9',units:[{unit:'u1',endpointId:'orders.create',status:'merged',headSha:'1'.repeat(40),mergeSha:'2'.repeat(40),evidenceSha256:'3'.repeat(64),evidencePath:'swarm/u1/evidence.json'},{unit:'u2',endpointId:'orders.create',status:'failed'}]}}));
    const r=await consolidate({root,store,osHome,swarmReportPath:join(swarmDir,'swarm-report.json'),runId:'bp'});
    assert.deepEqual(r.blueprints.map(b=>b.key),['bp:fastapi:orders.create']);
    const bp=JSON.parse(await readFile(join(osHome,'procedural','blueprints','fastapi','orders.create.json'),'utf8'));
    assert.deepEqual(bp.changedFiles,['app/orders/router.py','app/orders/service.py']);assert.equal(bp.scenarios.length,5);
    const mem=store.get('procedural','bp:fastapi:orders.create');assert.equal(mem.data.adapter,'fastapi');assert.equal(mem.anchor_sha,'2'.repeat(40));
    assert.equal(store.recall({query:'fastapi orders create',tiers:['procedural']})[0].key,'bp:fastapi:orders.create');
    store.close();
  }finally{await cleanup(root);}
});
