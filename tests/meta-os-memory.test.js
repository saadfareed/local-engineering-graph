import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {MemoryStore,TIERS,canonical,sha256,DDL} from '../src/memory/store.js';
import {compileContext} from '../src/memory/compiler.js';
import {loadAllBundles,structuralEdges} from '../src/contracts/spec.js';
import {scaffoldProject,cleanup,PACKAGE_ROOT} from './meta-os-helpers.mjs';

test('memory store: remember, ranked recall, reinforcement and tier filtering',()=>{
  const store=new MemoryStore();
  const id=store.remember({tier:'procedural',kind:'blueprint',key:'bp:fastapi:create',title:'FastAPI create blueprint',content:'router service repository idempotency key transaction',data:{adapter:'fastapi'}});
  store.remember({tier:'alignment',kind:'rule',key:'rule:early-return',title:'Prefer early returns',content:'avoid nested conditionals'});
  const hits=store.recall({query:'fastapi idempotency create'});
  assert.equal(hits[0].id,id);assert.deepEqual(hits[0].matched,['create','fastapi','idempotency']);
  assert.equal(store.recall({query:'fastapi',tiers:['alignment']}).length,0);
  const before=store.get('procedural','bp:fastapi:create').strength;
  store.remember({tier:'procedural',kind:'blueprint',key:'bp:fastapi:create',title:'FastAPI create blueprint',content:'router service repository idempotency key transaction'});
  assert.equal(store.get('procedural','bp:fastapi:create').strength,before+1);
  assert.throws(()=>store.remember({tier:'nope',kind:'x',key:'k',title:'t',content:'c'}),/Unknown memory tier/);
  assert.deepEqual(Object.keys(store.stats().byTier),TIERS);
  store.close();
});
test('memory store: anchored memories are invalidated when a file hash changes',()=>{
  const store=new MemoryStore();
  const h1='a'.repeat(64),h2='b'.repeat(64);
  const id=store.remember({tier:'episodic',kind:'episode',key:'ep:1',title:'verified orders.create',content:'passed all checks',files:[{path:'docs/api/orders/create/spec.md',sha256:h1}]});
  store.remember({tier:'episodic',kind:'episode',key:'ep:2',title:'other',content:'unrelated',files:[{path:'README.md',sha256:h1}]});
  assert.deepEqual(store.invalidateStale({'docs/api/orders/create/spec.md':h1,'README.md':h1}),{invalidated:0,ids:[]});
  const r=store.invalidateStale({'docs/api/orders/create/spec.md':h2,'README.md':h1});
  assert.deepEqual(r,{invalidated:1,ids:[id]});
  assert.equal(store.get('episodic','ep:1').valid,false);
  assert.equal(store.recall({query:'orders verified'}).length,0);
  assert.equal(store.recall({query:'orders verified',includeStale:true}).length,1);
  store.close();
});
test('structural memory: dependency graph and transitive impact',()=>{
  const store=new MemoryStore();
  store.link({from:'endpoint:orders.create',to:'model:Order',kind:'writes'});
  store.link({from:'endpoint:orders.get',to:'model:Order',kind:'reads'});
  store.link({from:'endpoint:invoices.create',to:'endpoint:orders.get',kind:'calls'});
  assert.deepEqual(store.impacted('model:Order').map(i=>[i.id,i.depth]),[['endpoint:orders.create',1],['endpoint:orders.get',1],['endpoint:invoices.create',2]]);
  assert.deepEqual(store.dependencies('endpoint:invoices.create').map(d=>d.id),['endpoint:orders.get']);
  assert.equal(store.stats().edges,3);
  store.close();
});
test('canonical JSON is key-order independent and the docs DDL matches the kernel DDL',async()=>{
  assert.equal(canonical({b:1,a:[{d:2,c:3}]}),'{"a":[{"c":3,"d":2}],"b":1}');
  assert.equal(sha256({b:1,a:2}),sha256({a:2,b:1}));
  const docs=await readFile(join(PACKAGE_ROOT,'docs','meta-os','schemas','memory.sql'),'utf8');
  assert.ok(docs.includes(DDL.trim()),'docs/meta-os/schemas/memory.sql is stale; run node scripts/meta-os-ddl.js');
});
test('context compiler: respects the token budget, is deterministic and records every source hash',async()=>{
  const root=await scaffoldProject();
  try{
    const store=new MemoryStore();
    const bundle=(await loadAllBundles(root))[0];
    for(const e of structuralEdges(bundle))store.link(e);
    store.remember({tier:'alignment',kind:'rule',key:'rule:no-n-plus-one',title:'Ban N+1 queries',content:'load relations with one join'});
    store.remember({tier:'procedural',kind:'blueprint',key:'bp:fastapi:create',title:'FastAPI create blueprint',content:'router service repository',data:{adapter:'fastapi'}});
    store.remember({tier:'procedural',kind:'blueprint',key:'bp:nestjs:create',title:'NestJS create blueprint',content:'controller service repository',data:{adapter:'nestjs'}});
    store.remember({tier:'episodic',kind:'failure',key:'fail:outbox',title:'orders.create outbox missing',content:'order written outside transaction'});
    const opts={root,store,endpointId:'orders.create',objective:'Implement orders.create in FastAPI per spec',taskId:'t1'};
    for(const budget of [300,800,4000]){
      const {manifest,markdown}=await compileContext({...opts,budgetTokens:budget});
      assert.ok(manifest.usedTokens<=budget,`${manifest.usedTokens} > ${budget}`);
      assert.ok(markdown.startsWith('# Context bundle: orders.create'));
    }
    const a=await compileContext({...opts,budgetTokens:4000}),b=await compileContext({...opts,budgetTokens:4000,taskDir:join(root,'.engineering','tasks','t1')});
    assert.equal(a.manifest.markdownSha256,b.manifest.markdownSha256);
    assert.equal(JSON.parse(await readFile(b.paths.manifest,'utf8')).markdownSha256,a.manifest.markdownSha256);
    const ids=a.manifest.sections.map(s=>s.id);
    assert.deepEqual(ids,['task','index','spec','policies','tests','alignment','procedural','structural','episodic']);
    assert.equal(a.manifest.sections.find(s=>s.id==='spec').sha256,bundle.spec.sha256);
    assert.ok(a.markdown.includes('FastAPI create blueprint')&&!a.markdown.includes('NestJS create blueprint'),'adapter filter on procedural tier');
    assert.ok(a.markdown.includes('Ban N+1 queries'),'global alignment rule reaches the worker without term overlap');
    assert.ok(a.markdown.includes('depends on model:Order (writes)'));
    await assert.rejects(compileContext({...opts,endpointId:'nope.missing'}),/no spec.md bundle/);
    store.close();
  }finally{await cleanup(root);}
});
