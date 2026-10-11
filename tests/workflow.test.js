import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateGraph} from '../src/graph.js';
import {createTask,readTask,advance} from '../src/state.js';
const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v1.json',import.meta.url),'utf8'));
test('rejects unhandled outcomes, unbounded edges and approval bypass',()=>{
 for(const mutate of [g=>g.nodes.discovery.outcomes.push('unknown'),g=>delete g.edges[0].maxTraversals,g=>g.edges.find(e=>e.from==='discovery'&&e.outcome==='ready').to='planning']){
 const g=structuredClone(graph);mutate(g);assert.throws(()=>validateGraph(g));}
});
test('rejects malformed productivity protocol flag',()=>{
 const g=structuredClone(graph);g.productivityProtocols='false';
 assert.throws(()=>validateGraph(g),/Invalid productivity protocols setting/);
});
test('task resumes, pins graph, rejects stale updates and reaches completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'engineering-test-'));
 try{
 const g=structuredClone(graph),t=await createTask(root,g,'Build task tracker');g.version=99;
 const file=join(root,'.engineering','tasks',t.id,'task.json');
 assert.equal((await readTask(file)).graph.version,1);
 await assert.rejects(advance(file,{outcome:'ready',expectedRevision:1,evidence:'brief'}),/Stale/);
 let revision=0;
 for(const outcome of ['ready','approved','ready','allowed','completed','passed','passed']){
 const next=await advance(file,{outcome,expectedRevision:revision++,evidence:'Recorded task evidence'});assert.equal(next.revision,revision);}
 assert.equal((await readTask(file)).node,'complete');
 await assert.rejects(advance(file,{outcome:'passed',expectedRevision:7,evidence:'again'}),/terminated/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('repair loops stop at edge budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'engineering-test-'));try{
 const g=structuredClone(graph);g.edges.find(e=>e.from==='implementation'&&e.outcome==='completed').maxTraversals=1;
 const t=await createTask(root,g,'Demo'),file=join(root,'.engineering','tasks',t.id,'task.json');let revision=0;
 for(const outcome of ['ready','approved','ready','allowed','completed','changes_required'])await advance(file,{outcome,expectedRevision:revision++,evidence:'evidence'});
 await assert.rejects(advance(file,{outcome:'completed',expectedRevision:revision,evidence:'retry'}),/budget/);
 }finally{await rm(root,{recursive:true,force:true});}
});
