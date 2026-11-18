import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {exportAll,openApiFromBundles,collectionFromBundles,summarizeReport,verifyAgainstSpec,writeIndex,pushOpenApi,runApidogCli} from '../src/exporters/apidog-sync.js';
import {loadAllBundles,parseIndex,parseSpec,parseTests} from '../src/contracts/spec.js';
import {scaffoldProject,cleanup} from './meta-os-helpers.mjs';

test('contract parser: rejects malformed bundles with precise errors',()=>{
  assert.throws(()=>parseSpec('# x\n\n| Field | Value |\n|---|---|\n| id | a.b |\n'),/missing "method"/);
  assert.throws(()=>parseTests('# t\n\n## T1 bad (S1)\n\n```json assert\n{nope}\n```\n'),/invalid JSON assertions/);
});
test('exporter: compiles docs/api into OpenAPI 3.1 and an importable test collection',async()=>{
  const root=await scaffoldProject({extraEndpoints:2});
  try{
    const {openapi,collection,manifest,files}=await exportAll({root,info:{title:'Shop',version:'2.0.0'}});
    assert.equal(openapi.openapi,'3.1.0');
    assert.deepEqual(Object.keys(openapi.paths).sort(),['/v1/items/{itemId}/v0','/v1/items/{itemId}/v1','/v1/orders']);
    const op=openapi.paths['/v1/orders'].post;
    assert.equal(op.operationId,'orders.create');assert.deepEqual(Object.keys(op.responses),['201','400','404','409']);
    assert.deepEqual(op.security,[{bearerAuth:[]}]);assert.deepEqual(op.parameters.map(p=>p.name),['Idempotency-Key','X-Request-Id']);
    assert.equal(op.requestBody.content['application/json'].schema.required[0],'cartId');
    assert.equal(op['x-engineering-os'].scenarios.length,5);assert.equal(op['x-engineering-os'].policies.latency_p95_ms,'120');
    assert.equal(openapi.paths['/v1/items/{itemId}/v0'].get.parameters[0].in,'path');
    assert.ok(openapi.components.schemas.Problem);
    const orders=collection.item.find(i=>i.name==='orders.create');
    assert.deepEqual(orders.item.map(i=>i.name),['orders.create::T1','orders.create::T2','orders.create::T3','orders.create::T4','orders.create::T5']);
    assert.equal(JSON.parse(orders.item[0].request.body.raw).cartId,'c-1');
    assert.ok(orders.item[0].request.header.some(h=>h.key==='Idempotency-Key'&&h.value==='k-1'));
    assert.match(orders.item[0].event[0].script.exec.join('\n'),/to\.have\.status\(201\)/);
    assert.equal(collection.item.find(i=>i.name==='catalog.item1').item[0].request.url.raw,'{{baseUrl}}/v1/items/i-1/v1');
    assert.equal(manifest.endpoints.length,3);assert.equal(JSON.parse(await readFile(files.openapi,'utf8')).info.title,'Shop');
    const bundles=await loadAllBundles(root);
    const broken=structuredClone(bundles[0]);broken.tests.tests[0].scenario='S9';
    assert.throws(()=>collectionFromBundles([broken]),/undefined scenario S9/);
    assert.equal(openApiFromBundles(bundles).info.title,'API');
  }finally{await cleanup(root);}
});
test('exporter: maps Apidog CLI reports back onto spec scenarios and updates INDEX.md',async()=>{
  const root=await scaffoldProject();
  try{
    const bundles=await loadAllBundles(root);
    const report={summary:{total:5,failed:1},results:[{name:'orders.create::T1',status:'passed'},{name:'orders.create::T2',passed:true},{name:'orders.create::T3',status:'failed'},{name:'orders.create::T4',assertions:[{passed:true}]},{name:'orders.create::T5',result:'success'}]};
    const summary=summarizeReport(report);
    assert.deepEqual([summary.total,summary.passed,summary.failed],[5,4,1]);
    const v=verifyAgainstSpec({summary,bundles});
    assert.equal(v.passed,false);assert.deepEqual(v.endpoints,{'orders.create':'failed'});
    assert.deepEqual(v.matrix.map(m=>m.status),['passed','passed','failed','passed','passed']);
    const partial=verifyAgainstSpec({summary:summarizeReport({items:[{name:'orders.create::T1',passed:true}]}),bundles});
    assert.equal(partial.endpoints['orders.create'],'incomplete');
    const first=await writeIndex({root,statuses:{'orders.create':'implemented'},apidog:{'orders.create':'synced 2026-11-16T00:00:00Z'}});
    const rows=parseIndex(await readFile(join(root,'docs','api','INDEX.md'),'utf8'));
    assert.deepEqual([rows[0].id,rows[0].status,rows[0].apidog,rows[0].link],['orders.create','implemented','synced 2026-11-16T00:00:00Z','orders/create/spec.md']);
    const again=await writeIndex({root});assert.equal(again.sha256,first.sha256,'regeneration preserves prior statuses');
    await writeFile(join(root,'docs','api','orders','create','spec.md'),(await readFile(join(root,'docs','api','orders','create','spec.md'),'utf8'))+'\n<!-- edited -->\n');
    await writeIndex({root});
    const changed=parseIndex(await readFile(join(root,'docs','api','INDEX.md'),'utf8'))[0];
    assert.deepEqual([changed.status,changed.apidog],['draft','unsynced'],'a changed spec hash resets status and sync state');
  }finally{await cleanup(root);}
});
test('exporter: pushes through the Apidog Open API and runs the CLI as a verifier',async()=>{
  const root=await scaffoldProject();
  try{
    const {openapi}=await exportAll({root});
    const calls=[];
    const res=await pushOpenApi({projectId:'42',document:openapi,token:'secret',fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({data:{counters:{endpointCreated:1}}}),{status:200});}});
    assert.equal(res.ok,true);assert.equal(calls[0].url,'https://api.apidog.com/v1/projects/42/import-openapi');
    assert.equal(calls[0].init.headers['X-Apidog-Api-Version'],'2024-03-28');assert.equal(calls[0].init.headers.authorization,'Bearer secret');
    const body=JSON.parse(calls[0].init.body);assert.equal(JSON.parse(body.input).openapi,'3.1.0');assert.equal(body.options.endpointOverwriteBehavior,'OVERWRITE_EXISTING');
    await assert.rejects(pushOpenApi({projectId:'42',document:openapi,token:''}),/access token/);
    const fakeCli=join(root,'fake-apidog.mjs');
    await writeFile(fakeCli,`import {writeFileSync} from 'node:fs';const out=process.argv[process.argv.indexOf('--out-dir')+1];writeFileSync(out+'/apidog-report.json',JSON.stringify({summary:{total:5,failed:0},results:['T1','T2','T3','T4','T5'].map(t=>({name:'orders.create::'+t,status:'passed'}))}));console.log('5 passed');`);
    const outDir=join(root,'.engineering','apidog','run-1');
    const run=await runApidogCli({cwd:root,outDir,argv:['node',fakeCli,'run','--access-token','SECRET123','-t','1','-r','cli,json','--out-dir',outDir]});
    assert.equal(run.passed,true);assert.equal(run.summary.total,5);assert.equal(run.command.includes('SECRET123'),false,'token redacted from recorded command');
    assert.match(run.reportSha256,/^[a-f0-9]{64}$/);
    const matrix=verifyAgainstSpec({summary:run.summary,bundles:await loadAllBundles(root)});assert.equal(matrix.passed,true);
    await assert.rejects(runApidogCli({cwd:root,outDir:join(root,'x'),accessToken:'t'}),/scenarioId/);
  }finally{await cleanup(root);}
});
