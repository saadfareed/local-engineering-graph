import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {validate,assertValid} from '../src/schema/validate.js';
import {loadAdapters,scoreAdapters,selectionCard,selectStack} from '../src/intent/selector.js';
import {PACKAGE_ROOT} from './meta-os-helpers.mjs';

const schema=async name=>JSON.parse(await readFile(join(PACKAGE_ROOT,'src','schema',`${name}.schema.json`),'utf8'));
test('schema validator: core keywords',()=>{
  const s={type:'object',required:['a'],properties:{a:{type:'integer',minimum:1},b:{type:'array',items:{enum:['x','y']},uniqueItems:true},c:{anyOf:[{type:'string'},{type:'null'}]}},additionalProperties:false,
    allOf:[{if:{properties:{a:{const:2}}},then:{required:['b']}}]};
  assert.deepEqual(validate(s,{a:1,c:null}),[]);
  assert.match(validate(s,{a:0}).join(),/below minimum/);
  assert.match(validate(s,{a:1,b:['x','x']}).join(),/not unique/);
  assert.match(validate(s,{a:1,b:['z']}).join(),/expected one of/);
  assert.match(validate(s,{a:1,z:1}).join(),/unexpected property "z"/);
  assert.match(validate(s,{a:2}).join(),/missing required property "b"/);
  assert.match(validate(s,{a:1,c:3}).join(),/anyOf/);
  assert.throws(()=>assertValid(s,{},'thing'),/Invalid thing/);
  assert.throws(()=>validate({$ref:'#/$defs/missing'},1),/Unresolved/);
});
test('reference adapter manifests and the example UI layout validate against their schemas',async()=>{
  const adapters=await loadAdapters([join(PACKAGE_ROOT,'docs','meta-os','adapters')]);
  assert.deepEqual(adapters.map(a=>a.id),['fastapi','nestjs']);
  const manifest=await schema('adapter-manifest');
  assert.deepEqual(validate(manifest,{...adapters[0],file:undefined}),[]);
  assert.match(validate(manifest,{...adapters[0],language:'cobol'}).join(),/language/);
  const layout=await schema('ui-layout');
  assert.deepEqual(validate(layout,{version:1,title:'Validation',regions:[{id:'main',component:'evidence-matrix',props:{rows:[]}},{id:'side',component:'diff',props:{},source:{kind:'task',ref:'swarm/u1/evidence.json'}}],actions:[{id:'adv',label:'Advance',kind:'advance',target:'passed'}]}),[]);
  assert.match(validate(layout,{version:1,title:'x',regions:[{id:'main',component:'hologram',props:{}}]}).join(),/component/);
});
test('stack selector: explainable scores, team bias and a schema-valid decision card',async()=>{
  const dirs=[join(PACKAGE_ROOT,'docs','meta-os','adapters')];
  const adapters=await loadAdapters(dirs);
  const ts=scoreAdapters(adapters,{needs:{typeSafety:0.9,asyncIo:0.6},team:{typescript:1}});
  assert.equal(ts[0].adapter.id,'nestjs');assert.ok(ts[0].score>ts[1].score);assert.ok('teamTypescript' in ts[0].breakdown);
  const py=scoreAdapters(adapters,{needs:{aiIntegration:1},team:{python:1}});
  assert.equal(py[0].adapter.id,'fastapi');
  const biased=scoreAdapters(adapters,{needs:{aiIntegration:1},team:{python:1}},{preferences:[{data:{adapterBias:{nestjs:0.3,fastapi:-0.3}}}]});
  assert.ok(biased.find(r=>r.adapter.id==='nestjs').score>py.find(r=>r.adapter.id==='nestjs').score);
  const existing=scoreAdapters(adapters,{needs:{aiIntegration:1},existing:{framework:'NestJS'}});
  assert.equal(existing.find(r=>r.adapter.id==='nestjs').breakdown.adjustments,25);
  const {card}=await selectStack({taskId:'t1',intent:{name:'orders',summary:'checkout',needs:{typeSafety:0.9},team:{typescript:1}},adapterDirs:dirs});
  assert.deepEqual(validate(await schema('decision-card'),card),[]);
  assert.equal(card.kind,'framework_selection');assert.equal(card.recommendation.optionId,'nestjs');assert.equal(card.options[0].adapter,'nestjs');
  assert.throws(()=>selectionCard({taskId:'t',intent:{},ranked:[]}),/No adapters/);
  const delta=await schema('hitl-delta');
  assert.deepEqual(validate(delta,{version:1,deltaId:'delta-1',kind:'decision_card_answer',taskId:'t1',actor:'human',createdAt:'2026-11-16T00:00:00Z',card:{cardId:card.cardId,chosenOptionId:'nestjs'}}),[]);
});
