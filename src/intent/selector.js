// Intent-to-Ecosystem compiler, slice 1: the Automatic Stack Selector.
// Scores every installed framework adapter (adapter.json manifests under ~/.engineering-os/adapters
// or the package's docs/meta-os/adapters) against an intent profile and emits an AWAITING_HUMAN
// decision card (src/schema/decision-card.schema.json). Scores are explainable per dimension so the
// human sees why FastAPI beat NestJS, and the alignment tier can bias the weights (team preferences).
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {assertValid} from '../schema/validate.js';
import {nowIso} from '../kernel/util.js';

const CARD_SCHEMA=JSON.parse(await readFile(new URL('../schema/decision-card.schema.json',import.meta.url),'utf8'));
const MANIFEST_SCHEMA=JSON.parse(await readFile(new URL('../schema/adapter-manifest.schema.json',import.meta.url),'utf8'));
export const DIMENSIONS=['latency','throughput','asyncIo','relationalAdmin','typeSafety','teamTypescript','teamPython','teamGo','teamJava','aiIntegration','enterprise','rapidPrototyping'];
/** Load every adapter.json in the given directories (later directories override earlier ids). */
export async function loadAdapters(dirs){
  const found=new Map();
  for(const dir of dirs){
    let entries=[];try{entries=await readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
    for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      const file=e.isDirectory()?join(dir,e.name,'adapter.json'):e.name.endsWith('.adapter.json')?join(dir,e.name):null;
      if(!file)continue;
      let manifest;try{manifest=JSON.parse(await readFile(file,'utf8'));}catch(err){if(err.code==='ENOENT')continue;throw Error(`${file}: ${err.message}`);}
      assertValid(MANIFEST_SCHEMA,manifest,`adapter manifest ${file}`);found.set(manifest.id,{...manifest,file});
    }
  }
  return [...found.values()];
}
/**
 * intent = {name, summary, needs:{latency:0..1, throughput, asyncIo, relationalAdmin, typeSafety, aiIntegration, enterprise, rapidPrototyping}, team:{typescript,python,go,java: 0..1}, endpoints?:number, existing?:{language?,framework?}}
 * preferences = alignment rows (optional) with data.adapterBias {adapterId: -1..1}
 */
export function scoreAdapters(adapters,intent,{preferences=[]}={}){
  const needs={...(intent.needs??{})};
  for(const [lang,w] of Object.entries(intent.team??{}))needs[`team${lang[0].toUpperCase()}${lang.slice(1)}`]=w;
  const weights=Object.fromEntries(DIMENSIONS.map(d=>[d,Math.max(0,Math.min(1,Number(needs[d]??0)))]));
  const total=Object.values(weights).reduce((a,b)=>a+b,0)||1;
  const bias=Object.assign({},...preferences.map(p=>p.data?.adapterBias??{}));
  return adapters.map(a=>{
    const breakdown={};let score=0;
    for(const d of DIMENSIONS){const w=weights[d];if(!w)continue;const s=Number(a.selection.strengths[d]??0);breakdown[d]=Math.round(w*s*100/total*100)/100;score+=w*s/total;}
    let adjust=0;
    if(intent.existing?.framework&&a.framework.toLowerCase()===intent.existing.framework.toLowerCase())adjust+=0.25;
    else if(intent.existing?.language&&a.language===intent.existing.language)adjust+=0.1;
    if(bias[a.id])adjust+=Math.max(-0.3,Math.min(0.3,Number(bias[a.id])));
    if(adjust)breakdown.adjustments=Math.round(adjust*100*100)/100;
    return {adapter:a,score:Math.round(Math.min(1,Math.max(0,score+adjust))*10000)/100,breakdown};
  }).sort((a,b)=>b.score-a.score||a.adapter.id.localeCompare(b.adapter.id));
}
export function selectionCard({taskId,intent,ranked,node='stack_selection',createdAt=nowIso()}){
  if(!ranked.length)throw Error('No adapters available to select from');
  const top=ranked[0],second=ranked[1];
  const margin=second?top.score-second.score:top.score;
  const card={version:1,cardId:`card-stack-${taskId}`,taskId,node,kind:'framework_selection',
    question:`Which backend stack should ${intent.name??'this service'} be built on?`,
    context:[`Intent: ${intent.summary??'(none)'}`,`Estimated endpoints: ${intent.endpoints??'unknown'}`,`Weighted needs: ${Object.entries(intent.needs??{}).map(([k,v])=>`${k}=${v}`).join(', ')||'none'}`,`Team: ${Object.entries(intent.team??{}).map(([k,v])=>`${k}=${v}`).join(', ')||'unspecified'}`].join('\n'),
    options:ranked.slice(0,4).map(r=>({id:r.adapter.id,label:`${r.adapter.name} (${r.adapter.language})`,summary:r.adapter.selection.notes??`${r.adapter.framework} ${r.adapter.frameworkVersion??''}`.trim(),
      tradeoffs:{pros:Object.entries(r.adapter.selection.strengths).filter(([,v])=>v>=0.8).map(([k])=>`strong ${k}`),cons:Object.entries(r.adapter.selection.strengths).filter(([,v])=>v<=0.4).map(([k])=>`weak ${k}`),risks:[]},
      score:r.score,scoreBreakdown:r.breakdown,adapter:r.adapter.id})),
    recommendation:{optionId:top.adapter.id,rationale:`${top.adapter.name} scores ${top.score} vs ${second?`${second.adapter.name} at ${second.score}`:'no alternative'}; strongest on ${Object.entries(top.breakdown).filter(([k])=>k!=='adjustments').sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k).join(', ')}.`,
      confidence:Math.round(Math.min(0.95,0.5+margin/40)*100)/100,revisitTrigger:'Team composition, latency budget or data model complexity changes materially.'},
    impact:{files:['docs/api/INDEX.md','.engineering/stack.json'],endpoints:[],repos:[],policies:['policies/learned.json'],reversibility:'hard'},
    ui:{layout:'cards',allowFreeText:true,multiSelect:false},createdAt};
  return assertValid(CARD_SCHEMA,card,'decision card');
}
export async function selectStack({taskId,intent,adapterDirs,preferences=[]}){
  const adapters=await loadAdapters(adapterDirs);
  const ranked=scoreAdapters(adapters,intent,{preferences});
  return {ranked:ranked.map(r=>({id:r.adapter.id,score:r.score,breakdown:r.breakdown})),card:selectionCard({taskId,intent,ranked})};
}
