// HITL Delta capture + Sleep-Cycle Consolidator.
//
// appendDelta(): validates and appends an exact before/after record to .engineering/human-overrides.jsonl
// (the truth) and mirrors it into the memory store's hitl_deltas index.
// consolidate(): the post-task reflection engine. It turns every pending human delta into durable
// memory: decision-card answers become ADRs (docs/adr/ADR-NNNN-*.md + episodic memory), spec/plan
// edits become episodic diffs, review rejections are tallied by normalized rule and promoted into
// policies/learned.json + alignment memory once they recur across `promoteAfter` distinct tasks,
// preferences go straight to alignment memory, and merged swarm units are distilled into
// procedural blueprints under ~/.engineering-os/procedural/. Idempotent: deltas are marked
// consolidated in the store and re-running produces no duplicate ADRs, rules or blueprints.
import {readFile,writeFile,appendFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {assertValid} from '../schema/validate.js';
import {loadAllBundles} from '../contracts/spec.js';
import {condenseSpec} from './compiler.js';
import {canonical,sha256,nowIso} from '../kernel/util.js';

const DELTA_SCHEMA=JSON.parse(await readFile(new URL('../schema/hitl-delta.schema.json',import.meta.url),'utf8'));
export const slug=text=>String(text).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'rule';
async function readJsonl(path){try{return (await readFile(path,'utf8')).split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
async function exists(p){try{await readFile(p);return true;}catch{return false;}}

/** Append a HITL delta. `delta` may omit deltaId/createdAt/version; before/after hashes are filled in. */
export async function appendDelta({root,delta,store=null,path=null}){
  const record={version:1,deltaId:`delta-${randomUUID()}`,createdAt:nowIso(),repo:null,...delta};
  if(record.edit){record.edit.beforeSha256??=sha256(record.edit.before);record.edit.afterSha256??=sha256(record.edit.after);}
  if(record.kind==='review_rejection'&&record.review?.rule)record.ruleKey??=slug(record.review.rule);
  if(record.kind==='preference'&&record.preference?.statement)record.ruleKey??=slug(record.preference.statement);
  assertValid(DELTA_SCHEMA,record,'HITL delta');
  const file=path??join(resolve(root),'.engineering','human-overrides.jsonl');
  await mkdir(join(file,'..'),{recursive:true});await appendFile(file,canonical(record)+'\n');
  store?.recordDelta(record);
  return record;
}
/** Minimal LCS line diff for episodic records (bounded so pathological inputs stay cheap). */
export function lineDiff(before,after,{maxLines=1500}={}){
  const a=before.split('\n'),b=after.split('\n');
  if(a.length>maxLines||b.length>maxLines)return {summary:`large edit: ${a.length} -> ${b.length} lines`,hunks:[]};
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const hunks=[];let i=0,j=0;
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){i++;j++;continue;}
    if(i<a.length&&(j>=b.length||dp[i+1][j]>=dp[i][j+1])){hunks.push({op:'-',line:i+1,text:a[i]});i++;}
    else{hunks.push({op:'+',line:j+1,text:b[j]});j++;}
  }
  return {summary:`${hunks.filter(h=>h.op==='-').length} removed, ${hunks.filter(h=>h.op==='+').length} added`,hunks};
}
async function nextAdrNumber(adrDir){
  let max=0;try{for(const f of await readdir(adrDir)){const m=/^ADR-(\d{4})/.exec(f);if(m)max=Math.max(max,Number(m[1]));}}catch(e){if(e.code!=='ENOENT')throw e;}
  return max+1;
}
export function renderAdr({number,title,date,status='accepted',context,options,decision,rationale,consequences,impact,source}){
  const lines=[`# ADR-${String(number).padStart(4,'0')}: ${title}`,'',`- Status: ${status}`,`- Date: ${date}`,`- Source: ${source}`,'','## Context','',context||'(no context recorded)','','## Options considered',''];
  for(const o of options)lines.push(`### ${o.label}${o.chosen?' (chosen)':''}${o.recommended?' (agent recommendation)':''}`,'',o.summary||'',...(o.tradeoffs?.pros?.length?['','Pros:',...o.tradeoffs.pros.map(p=>`- ${p}`)]:[]),...(o.tradeoffs?.cons?.length?['','Cons:',...o.tradeoffs.cons.map(c=>`- ${c}`)]:[]),'');
  lines.push('## Decision','',decision,'',rationale?`Rationale (human): ${rationale}`:'Rationale: not recorded.','','## Consequences','',...(consequences.length?consequences.map(c=>`- ${c}`):['- See chosen option tradeoffs.']),'');
  if(impact&&Object.keys(impact).length)lines.push('## Impact','',...Object.entries(impact).filter(([,v])=>Array.isArray(v)?v.length:v).map(([k,v])=>`- ${k}: ${Array.isArray(v)?v.join(', '):v}`),'');
  return lines.join('\n');
}
/**
 * Run one sleep cycle. Returns a summary and writes .engineering/consolidations/<runId>.json.
 * @param {object} o
 * @param {string} o.root project root; @param {import('./store.js').MemoryStore} o.store
 */
export async function consolidate({root,store,osHome=join(homedir(),'.engineering-os'),repo=null,anchorSha=null,promoteAfter=3,swarmReportPath=null,runId=`cons-${randomUUID()}`,date=nowIso().slice(0,10)}){
  root=resolve(root);
  const deltasPath=join(root,'.engineering','human-overrides.jsonl'),adrDir=join(root,'docs','adr'),episodesPath=join(root,'.engineering','memory','episodes.jsonl');
  const learnedPath=join(root,'policies','learned.json'),alignDir=join(osHome,'alignment'),procDir=join(osHome,'procedural','blueprints');
  const summary={runId,date,adrs:[],episodes:[],promotedRules:[],candidates:[],preferences:[],blueprints:[],consolidatedDeltas:[],skipped:[]};
  // 1. Ingest the JSONL truth into the store index (idempotent).
  for(const d of await readJsonl(deltasPath)){try{assertValid(DELTA_SCHEMA,d,'HITL delta');store.recordDelta(d);}catch(e){summary.skipped.push({deltaId:d?.deltaId,reason:e.message.split('\n')[0]});}}
  const pending=store.pendingDeltas().filter(d=>d.payload.actor==='human');
  let learned=null;const loadLearned=async()=>learned??=JSON.parse(await readFile(learnedPath,'utf8').catch(()=>'{"version":1,"rules":[]}'));
  for(const d of pending){
    const p=d.payload,done=[];
    try{
      if(p.kind==='decision_card_answer'){
        const c=p.card,chosen=(c.options??[]).find(o=>o.id===c.chosenOptionId);
        const number=await nextAdrNumber(adrDir),title=c.question?.replace(/\?+$/,'')||`Decision ${c.cardId}`;
        const file=`ADR-${String(number).padStart(4,'0')}-${slug(title)}.md`;
        const text=renderAdr({number,title,date,context:c.question,options:(c.options??[]).map(o=>({...o,chosen:o.id===c.chosenOptionId,recommended:o.id===c.recommendedOptionId})),
          decision:`Chose "${c.chosenLabel??chosen?.label??c.chosenOptionId}"${c.overrodeRecommendation?' (overriding the agent recommendation)':''}.`,rationale:c.humanRationale,consequences:[...(chosen?.tradeoffs?.cons??[]).map(x=>`Accepted: ${x}`),...(chosen?.tradeoffs?.risks??[]).map(x=>`Risk: ${x}`)],impact:c.impact,source:`task ${p.taskId}, card ${c.cardId}, delta ${p.deltaId}`});
        await mkdir(adrDir,{recursive:true});await writeFile(join(adrDir,file),text);
        const adrKey=`adr:${String(number).padStart(4,'0')}`;
        store.remember({tier:'episodic',kind:'adr',key:adrKey,title:`ADR-${String(number).padStart(4,'0')} ${title}`,content:`Decision: ${c.chosenLabel??c.chosenOptionId}. ${c.humanRationale??''}`.trim(),data:{file:`docs/adr/${file}`,cardId:c.cardId,overrode:Boolean(c.overrodeRecommendation),impact:c.impact??null},repo,taskId:p.taskId,anchorSha,files:[{path:`docs/adr/${file}`,sha256:sha256(text)}]});
        await store.recordEpisode({episodeId:`${p.deltaId}:adr`,taskId:p.taskId,repo,kind:'adr',outcome:c.chosenOptionId,summary:title,evidenceSha256:sha256(text),anchorSha,data:{file:`docs/adr/${file}`},jsonlPath:episodesPath});
        summary.adrs.push({number,file:`docs/adr/${file}`,deltaId:p.deltaId});store.logConsolidation(runId,'adr_created',`docs/adr/${file}`,{deltaId:p.deltaId});
        if(c.overrodeRecommendation&&c.humanRationale){const key=`pref:${slug(c.humanRationale)}`;store.remember({tier:'alignment',kind:'preference',key,title:`Overrode agent on ${c.cardId}`,content:c.humanRationale,data:{source:p.deltaId,kind:'override'},repo:null});summary.preferences.push(key);}
      }else if(p.kind==='spec_edit'||p.kind==='plan_edit'){
        const diff=lineDiff(p.edit.before,p.edit.after);
        const key=`edit:${p.deltaId}`;
        store.remember({tier:'episodic',kind:'human_edit',key,title:`Human ${p.kind.replace('_',' ')} of ${p.edit.path}`,content:`${p.edit.reason??'(no reason given)'}\n${diff.summary}\n${diff.hunks.slice(0,40).map(h=>`${h.op} ${h.text}`).join('\n')}`,data:{path:p.edit.path,before:p.edit.beforeSha256,after:p.edit.afterSha256,hunks:diff.hunks.length},repo,taskId:p.taskId,anchorSha,files:[{path:p.edit.path,sha256:p.edit.afterSha256}]});
        await store.recordEpisode({episodeId:`${p.deltaId}:edit`,taskId:p.taskId,repo,kind:'human_edit',outcome:p.kind,summary:`${p.edit.path}: ${diff.summary}`,evidenceSha256:p.edit.afterSha256,anchorSha,jsonlPath:episodesPath});
        summary.episodes.push(key);store.logConsolidation(runId,'episode_recorded',key,{path:p.edit.path});
        if(p.ruleKey)await tally(p,`Edit rule: ${p.edit.reason??p.ruleKey}`,p.review?.scope??'project');
      }else if(p.kind==='review_rejection'){
        await tally(p,p.review.rule,p.review.scope??'project');
      }else if(p.kind==='preference'){
        const key=`pref:${p.ruleKey??slug(p.preference.statement)}`;
        store.remember({tier:'alignment',kind:'preference',key,title:p.preference.statement.slice(0,80),content:p.preference.statement,data:{category:p.preference.category??'other',scope:p.preference.scope??'global',source:p.deltaId},repo:(p.preference.scope??'global')==='project'?repo:null});
        await mkdir(alignDir,{recursive:true});await appendFile(join(alignDir,'preferences.jsonl'),canonical({key,statement:p.preference.statement,category:p.preference.category??'other',scope:p.preference.scope??'global',deltaId:p.deltaId,taskId:p.taskId,date})+'\n');
        summary.preferences.push(key);store.logConsolidation(runId,'preference_recorded',key,{deltaId:p.deltaId});
      }
      done.push(d.delta_id);
    }catch(e){summary.skipped.push({deltaId:d.delta_id,reason:e.message});}
    if(done.length){store.markConsolidated(done);summary.consolidatedDeltas.push(...done);}
  }
  async function tally(p,ruleText,scope){
    const ruleKey=p.ruleKey??slug(ruleText),occurrences=store.ruleOccurrences(ruleKey);
    const key=`rule:${ruleKey}`;
    if(occurrences>=promoteAfter){
      const policies=await loadLearned();
      if(!policies.rules.some(r=>r.id===`learned-${ruleKey}`)){
        policies.rules.push({id:`learned-${ruleKey}`,enforcement:'instructional',rule:ruleText,scope,occurrences,promotedAt:date,sources:[p.deltaId]});
        await mkdir(join(learnedPath,'..'),{recursive:true});await writeFile(learnedPath,JSON.stringify(policies,null,2)+'\n');
        store.logConsolidation(runId,'rule_promoted',key,{occurrences,scope});summary.promotedRules.push({ruleKey,occurrences,scope});
        await mkdir(alignDir,{recursive:true});await appendFile(join(alignDir,'rules.jsonl'),canonical({key,rule:ruleText,scope,occurrences,promotedAt:date,repo:scope==='project'?repo:null})+'\n');
      }
      store.remember({tier:'alignment',kind:'rule',key,title:ruleText.slice(0,80),content:ruleText,data:{scope,occurrences,promoted:true,source:p.deltaId},repo:scope==='project'?repo:null});
      const candidate=store.get('alignment',`candidate:${ruleKey}`);if(candidate?.valid)store.invalidate(candidate.id,`promoted to ${key}`);
    }else{
      store.remember({tier:'alignment',kind:'rule_candidate',key:`candidate:${ruleKey}`,title:ruleText.slice(0,80),content:`${ruleText} (seen ${occurrences}/${promoteAfter} times)`,data:{scope,occurrences,promoted:false,source:p.deltaId},repo:scope==='project'?repo:null});
      summary.candidates.push({ruleKey,occurrences,needed:promoteAfter});
    }
  }
  // 3. Procedural blueprints from merged swarm units (clean, verified implementations).
  if(swarmReportPath&&await exists(swarmReportPath)){
    const signed=JSON.parse(await readFile(swarmReportPath,'utf8')),report=signed.record??signed;
    const bundles=await loadAllBundles(root).catch(()=>[]);
    for(const u of report.units??[]){
      if(u.status!=='merged'||!u.endpointId)continue;
      const b=bundles.find(x=>x.spec.id===u.endpointId);if(!b)continue;
      const adapter=b.spec.adapter??'generic',key=`bp:${adapter}:${u.endpointId}`;
      let evidence=null;try{evidence=JSON.parse(await readFile(join(swarmReportPath,'..','..',u.evidencePath),'utf8')).record;}catch{}
      const blueprint={version:1,adapter,endpointId:u.endpointId,method:b.spec.method,path:b.spec.path,tags:b.spec.tags,summary:b.spec.summary,specSha256:b.spec.sha256,policies:b.policies?.raw??null,scenarios:b.spec.scenarios.map(s=>({id:s.id,status:s.status,calls:s.calls,mutations:s.mutations})),changedFiles:evidence?.changedFiles??[],verifiers:(evidence?.verifiers??[]).map(v=>({id:v.id,command:v.command})),headSha:u.headSha,mergeSha:u.mergeSha,taskId:report.taskId,extractedAt:nowIso()};
      const dir=join(procDir,adapter);await mkdir(dir,{recursive:true});const file=join(dir,`${u.endpointId}.json`);await writeFile(file,JSON.stringify(blueprint,null,2)+'\n');
      store.remember({tier:'procedural',kind:'blueprint',key,title:`${adapter} blueprint: ${b.spec.method} ${b.spec.path}`,content:`${condenseSpec(b.spec)}\nFiles: ${blueprint.changedFiles.join(', ')}`,data:{adapter,endpointId:u.endpointId,file,tags:b.spec.tags},repo:null,taskId:report.taskId,anchorSha:u.mergeSha??anchorSha,files:[{path:`${b.dir}/spec.md`,sha256:b.spec.sha256}],tags:[adapter,...b.spec.tags]});
      await store.recordEpisode({episodeId:`${report.taskId}:${u.unit}:merged`,taskId:report.taskId,repo,kind:'swarm_unit',outcome:'merged',summary:`${u.endpointId} merged at ${u.mergeSha}`,evidenceSha256:u.evidenceSha256,anchorSha:u.mergeSha,jsonlPath:episodesPath});
      summary.blueprints.push({key,file});store.logConsolidation(runId,'blueprint_extracted',key,{file});
    }
  }
  const outDir=join(root,'.engineering','consolidations');await mkdir(outDir,{recursive:true});
  await writeFile(join(outDir,`${runId}.json`),JSON.stringify(summary,null,2)+'\n');
  return summary;
}
