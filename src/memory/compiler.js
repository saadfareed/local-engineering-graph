// Context Compiler: before a Claude Code worker starts a graph node, pack a verified, budgeted
// (<4k tokens by default) context bundle from docs/api/INDEX.md, the endpoint bundle and all five
// memory tiers. Deterministic: same inputs -> same markdown -> same manifest hashes. The manifest
// records every source hash and memory id so a reviewer can audit exactly what the worker saw.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadBundle,loadAllBundles,parseIndex} from '../contracts/spec.js';
import {estimateTokens,sha256,tokenize,canonical} from './store.js';

// Priority order and budget caps (fraction of total). Earlier sections are packed first; a second
// pass lets truncated sections grow into whatever budget is left, still in priority order.
export const SECTION_PLAN=[
  {id:'task',cap:0.05},{id:'index',cap:0.08},{id:'spec',cap:0.35},{id:'policies',cap:0.12},{id:'tests',cap:0.12},
  {id:'alignment',cap:0.08},{id:'procedural',cap:0.10},{id:'structural',cap:0.05},{id:'episodic',cap:0.08},{id:'working',cap:0.05}
];
const compact=v=>JSON.stringify(v);
function truncate(text,maxTokens){
  if(estimateTokens(text)<=maxTokens)return {text,truncated:false};
  const lines=text.split('\n');let out=[],used=0;
  for(const line of lines){const t=estimateTokens(line+'\n');if(used+t>maxTokens-6)break;out.push(line);used+=t;}
  return {text:out.join('\n')+`\n…[truncated ${estimateTokens(text)-used} tokens]`,truncated:true};
}
export function condenseSpec(spec){
  const lines=[`${spec.method} ${spec.path}  (id: ${spec.id}, adapter: ${spec.adapter??'unset'}, v${spec.version})`,spec.summary];
  if(spec.headers.length)lines.push('Headers: '+spec.headers.map(h=>`${h.name}${h.required?'*':''}`).join(', '));
  if(spec.params.length)lines.push('Path params: '+spec.params.join(', '));
  if(spec.request)lines.push('Request schema: '+compact(spec.request));
  for(const [status,r] of Object.entries(spec.responses))lines.push(`Response ${status}${r.description?` ${r.description}`:''}: ${r.schema?compact(r.schema):'(no body)'}`);
  if(spec.scenarios.length){lines.push('Scenario call graph:');for(const s of spec.scenarios)lines.push(`- ${s.id} ${s.name} | when ${s.trigger} | calls ${s.calls.join(' -> ')||'none'} | mutates ${s.mutations.join('; ')||'none'} | ${s.status} ${s.response}`);}
  return lines.join('\n');
}
export function condensePolicies(policies){
  if(!policies)return '';
  const lines=Object.entries(policies.raw).map(([k,v])=>`- ${k}: ${v}`);
  if(policies.invariants.length)lines.push('Invariants:',...policies.invariants.map(i=>`- ${i}`));
  return lines.join('\n');
}
export function condenseTests(tests){
  if(!tests)return '';
  return tests.tests.map(t=>`- ${t.id}${t.scenario?` (${t.scenario})`:''} ${t.title}: when ${t.when.join('; ')||'?'} then ${t.then.join('; ')||'?'}${t.assertions?` | assert ${compact(t.assertions)}`:''}`).join('\n');
}
const memoryLines=rows=>rows.map(r=>`- [${r.kind} #${r.id}${r.anchor_sha?` @${r.anchor_sha.slice(0,7)}`:''}] ${r.title}: ${r.content.replace(/\s+/g,' ').trim()}`).join('\n');
/**
 * @param {object} o
 * @param {string} o.root project root; @param {import('./store.js').MemoryStore} o.store
 * @param {string} [o.endpointId] endpoint to compile for; omit for task-level context
 * @param {string} o.objective node objective text
 */
export async function compileContext({root,store,endpointId=null,objective,budgetTokens=4000,repo=null,anchorSha=null,taskId=null,taskDir=null,apiDir='docs/api',adapter=null,extraSections=[]}){
  if(!objective?.trim())throw Error('compileContext requires an objective');
  let indexRows=[];try{indexRows=parseIndex(await readFile(join(root,apiDir,'INDEX.md'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let bundle=null;
  if(endpointId){
    const row=indexRows.find(r=>r.id===endpointId);
    if(row?.link)bundle=await loadBundle(root,`${apiDir}/${row.link.replace(/\/spec\.md$/,'')}`);
    else bundle=(await loadAllBundles(root,{apiDir})).find(b=>b.spec.id===endpointId)??null;
    if(!bundle)throw Error(`Endpoint ${endpointId} has no spec.md bundle under ${apiDir}`);
  }
  const effectiveAdapter=adapter??bundle?.spec.adapter??null;
  const queryText=`${objective} ${endpointId??''} ${effectiveAdapter??''} ${bundle?.spec.summary??''} ${bundle?.spec.tags.join(' ')??''}`;
  const recall=(tier,extra={})=>store.recall({tiers:[tier],query:queryText,repo,anchorSha,limit:8,...extra});
  const nodeId=endpointId?`endpoint:${endpointId}`:null;
  const impacted=nodeId?store.impacted(nodeId,{maxDepth:3}):[],deps=nodeId?store.dependencies(nodeId):[];
  const sources={
    task:{tier:'working',text:[`Objective: ${objective.trim()}`,endpointId?`Endpoint: ${endpointId}`:null,effectiveAdapter?`Adapter: ${effectiveAdapter}`:null,anchorSha?`Anchor commit: ${anchorSha}`:null,taskId?`Task: ${taskId}`:null].filter(Boolean).join('\n')},
    index:{tier:'structural',text:indexRows.length?[...(endpointId?indexRows.filter(r=>r.id===endpointId):[]),...impacted.map(i=>indexRows.find(r=>`endpoint:${r.id}`===i.id)).filter(Boolean)].map(r=>`- ${r.id} ${r.method} ${r.path} — ${r.useCase} [${r.adapter}] spec ${r.specHash} ${r.status} apidog:${r.apidog}`).join('\n')||`(INDEX.md has ${indexRows.length} endpoints; none match)`:'(no docs/api/INDEX.md)'},
    spec:{tier:'structural',text:bundle?condenseSpec(bundle.spec):'',source:bundle?`${bundle.dir}/spec.md`:null,sha256:bundle?.spec.sha256},
    policies:{tier:'structural',text:condensePolicies(bundle?.policies),source:bundle?.policies?`${bundle.dir}/policies.md`:null,sha256:bundle?.policies?.sha256},
    tests:{tier:'structural',text:condenseTests(bundle?.tests),source:bundle?.tests?`${bundle.dir}/tests.md`:null,sha256:bundle?.tests?.sha256},
    // Alignment rules are global taste: merge term recall with the most reinforced rules so a rule
    // that shares no vocabulary with the objective (e.g. "no N+1") still reaches the worker.
    alignment:{tier:'alignment',rows:[...recall('alignment'),...store.strongest('alignment',{repo,limit:5})].filter((r,i,a)=>a.findIndex(x=>x.id===r.id)===i).slice(0,8)},
    procedural:{tier:'procedural',rows:recall('procedural').filter(r=>!effectiveAdapter||!r.data?.adapter||r.data.adapter===effectiveAdapter)},
    structural:{tier:'structural',text:[...deps.map(d=>`- depends on ${d.id} (${d.kind})`),...impacted.map(i=>`- impacts ${i.id} via ${i.via} (${i.kind}, depth ${i.depth})`)].join('\n')},
    episodic:{tier:'episodic',rows:recall('episodic')},
    working:{tier:'working',rows:taskId?store.recall({tiers:['working'],query:queryText,repo,limit:6}).filter(r=>r.task_id===taskId):[]}
  };
  for(const s of extraSections)sources[s.id]={tier:s.tier??'working',text:s.text};
  const plan=[...SECTION_PLAN,...extraSections.map(s=>({id:s.id,cap:s.cap??0.05}))];
  const title=`# Context bundle${endpointId?`: ${endpointId}`:''}`;
  const HEADING=14; // tokens reserved per section heading + blank lines, counted against the budget
  const packed=[];let used=estimateTokens(title)+2;
  for(const {id,cap} of plan){
    const src=sources[id];if(!src)continue;
    const text=(src.text??memoryLines(src.rows??[])).trim();if(!text)continue;
    const room=budgetTokens-used-HEADING;if(room<16)break;
    const {text:body,truncated}=truncate(text,Math.min(Math.max(32,Math.floor(budgetTokens*cap)),room));
    const tokens=estimateTokens(body);if(tokens<=0)continue;
    packed.push({id,tier:src.tier,body,full:text,tokens,truncated,source:src.source??null,sha256:src.sha256??sha256(text),memoryIds:(src.rows??[]).map(r=>r.id)});used+=tokens+HEADING;
  }
  // Second pass: let truncated sections grow into leftover budget, in priority order.
  for(const p of packed){if(!p.truncated)continue;const spare=budgetTokens-used;if(spare<=0)break;const {text:body,truncated}=truncate(p.full,p.tokens+spare);const t=estimateTokens(body);used+=t-p.tokens;p.body=body;p.tokens=t;p.truncated=truncated;}
  const markdown=[title,'',...packed.flatMap(p=>[`## ${p.id} (${p.tier}${p.truncated?', truncated':''})`,p.body,''])].join('\n');
  const manifest={version:1,endpointId,adapter:effectiveAdapter,objective:objective.trim(),taskId,repo,anchorSha,budgetTokens,usedTokens:estimateTokens(markdown),
    sections:packed.map(({id,tier,tokens,truncated,source,sha256:h,memoryIds})=>({id,tier,tokens,truncated,source,sha256:h,memoryIds})),
    bundle:bundle?{dir:bundle.dir,spec:bundle.spec.sha256,policies:bundle.policies?.sha256??null,tests:bundle.tests?.sha256??null}:null,
    queryTerms:[...tokenize(queryText).keys()].sort(),markdownSha256:sha256(markdown)};
  if(manifest.usedTokens>budgetTokens)throw Error(`Context compiler overflow: ${manifest.usedTokens} > ${budgetTokens}`);
  let paths=null;
  if(taskDir){
    const dir=join(taskDir,'context');await mkdir(dir,{recursive:true});
    const base=(endpointId??'task').replace(/[^A-Za-z0-9_.-]/g,'_');
    paths={markdown:join(dir,`${base}.md`),manifest:join(dir,`${base}.json`)};
    await writeFile(paths.markdown,markdown);await writeFile(paths.manifest,canonical(manifest)+'\n');
  }
  return {markdown,manifest,paths};
}
