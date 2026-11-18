// Universal API contract engine: parses the per-endpoint Markdown bundle
//   docs/api/<domain>/<endpoint>/{spec.md,policies.md,tests.md}
// and the master docs/api/INDEX.md into plain objects shared by the context compiler, the
// Apidog exporter, the framework adapters and the structural-memory sync. The parser is a small
// deterministic Markdown subset reader (headings, pipe tables, fenced blocks, bullet lists);
// the templates in docs/meta-os/templates/ are the authoritative shape.
import {readFile,readdir,stat} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';

const hash=text=>createHash('sha256').update(text).digest('hex');
const cell=s=>{const t=s.trim();return /^`[^`]*`$/.test(t)?t.slice(1,-1):t;};
export function parseMarkdown(text){
  const lines=text.split(/\r?\n/);
  const doc={title:null,headings:[],tables:[],fences:[],lists:[],sections:new Map()};
  let heading=null,i=0;
  const sectionLines=()=>{if(!doc.sections.has(heading))doc.sections.set(heading,[]);return doc.sections.get(heading);};
  while(i<lines.length){
    const line=lines[i];
    const h=/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if(h){heading=h[2].trim();doc.headings.push({level:h[1].length,text:heading,line:i});if(h[1].length===1&&!doc.title)doc.title=heading;i++;continue;}
    const f=/^```\s*([^\n]*)$/.exec(line);
    if(f){const info=f[1].trim();const body=[];i++;while(i<lines.length&&!/^```\s*$/.test(lines[i]))body.push(lines[i++]);i++;doc.fences.push({heading,info,body:body.join('\n')});continue;}
    if(/^\s*\|.*\|\s*$/.test(line)&&i+1<lines.length&&/^\s*\|?\s*:?-{2,}/.test(lines[i+1])){
      const headers=line.trim().slice(1,-1).split('|').map(cell);const rows=[];i+=2;
      while(i<lines.length&&/^\s*\|.*\|\s*$/.test(lines[i])){const cells=lines[i].trim().slice(1,-1).split('|').map(cell);rows.push(Object.fromEntries(headers.map((h,k)=>[h,cells[k]??''])));i++;}
      doc.tables.push({heading,headers,rows});continue;
    }
    const b=/^\s*[-*]\s+(.*)$/.exec(line);
    if(b){let list=doc.lists.at(-1);if(!list||list.heading!==heading||list.endLine!==i-1)doc.lists.push(list={heading,items:[],endLine:i});list.items.push(b[1].trim());list.endLine=i;}
    sectionLines().push(line);i++;
  }
  for(const [k,v] of doc.sections)doc.sections.set(k,v.join('\n').trim());
  return doc;
}
const kv=table=>Object.fromEntries((table?.rows??[]).map(r=>{const [k,v]=Object.values(r);return [k.trim(),v];}));
const splitCalls=text=>text.split(/\s*(?:->|→|=>)\s*/).map(s=>s.trim()).filter(Boolean);
export function parseSchemaFence(fence,label){
  if(!fence)return null;
  try{return JSON.parse(fence.body);}catch(e){throw Error(`Invalid JSON schema in ${label} (${fence.heading}): ${e.message}`);}
}
export function parseSpec(text,{path='spec.md'}={}){
  const doc=parseMarkdown(text);
  const meta=kv(doc.tables.find(t=>t.heading===doc.title&&t.headers[0]==='Field'));
  for(const required of ['id','method','path'])if(!meta[required])throw Error(`${path}: spec metadata table is missing "${required}"`);
  const request=parseSchemaFence(doc.fences.find(f=>f.heading==='Request'&&/^json/.test(f.info)),path);
  const responses={};
  for(const h of doc.headings.filter(h=>h.level===3&&/^\d{3}\b/.test(h.text))){
    const status=h.text.slice(0,3);
    responses[status]={description:h.text.slice(3).trim()||status,schema:parseSchemaFence(doc.fences.find(f=>f.heading===h.text&&/^json/.test(f.info)),path)};
  }
  const headers=(doc.tables.find(t=>/auth|headers/i.test(t.heading??''))?.rows??[]).map(r=>({name:r.Header??r.Name,required:/^(yes|true|required)$/i.test(r.Required??''),description:r.Description??''}));
  const scenarioTable=doc.tables.find(t=>/scenario call graph/i.test(t.heading??''));
  const scenarios=(scenarioTable?.rows??[]).map(r=>{
    const [id,...nameParts]=(r.Scenario??'').split(/\s+/);
    return {id,name:nameParts.join(' ')||id,trigger:r.Trigger??'',calls:splitCalls(r.Calls??''),mutations:(r.Mutations??'').split(/\s*[;,]\s*/).filter(m=>m&&!/^none$/i.test(m)),status:(r.Status??'').trim(),response:r.Response??''};
  });
  const params=[...meta.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(m=>m[1]);
  return {id:meta.id,domain:meta.domain??meta.id.split('.')[0],method:meta.method.toUpperCase(),path:meta.path,summary:meta.summary??'',adapter:meta.adapter??null,version:meta.version??'1',owner:meta.owner??null,
    tags:(meta.tags??'').split(/\s*,\s*/).filter(Boolean),useCase:doc.sections.get('Use case')??'',headers,params,request,responses,scenarios,sha256:hash(text),meta};
}
export function parsePolicies(text){
  const doc=parseMarkdown(text);
  const table=kv(doc.tables.find(t=>t.headers[0]==='Policy'));
  const invariants=doc.lists.find(l=>/invariants/i.test(l.heading??''))?.items??[];
  const latency=Number.parseInt(table.latency_p95_ms??'',10);
  return {rbac:table.rbac??null,idempotency:table.idempotency??null,transaction:table.transaction??null,queries:table.queries??null,latencyP95Ms:Number.isInteger(latency)?latency:null,rateLimit:table.rate_limit??null,raw:table,invariants,sha256:hash(text)};
}
export function parseTests(text){
  const doc=parseMarkdown(text);
  const tests=[];
  for(const h of doc.headings.filter(h=>h.level===2&&/^T\d+/.test(h.text))){
    const [id,...rest]=h.text.split(/\s+/);const title=rest.join(' ');
    const scenario=/\((S\d+[^)]*)\)\s*$/.exec(title)?.[1]??null;
    const items=doc.lists.filter(l=>l.heading===h.text).flatMap(l=>l.items);
    const step=prefix=>items.filter(i=>new RegExp(`^${prefix}:`,'i').test(i)).map(i=>i.replace(new RegExp(`^${prefix}:\\s*`,'i'),''));
    const assertFence=doc.fences.find(f=>f.heading===h.text&&/^json/.test(f.info));
    let assertions=null;if(assertFence){try{assertions=JSON.parse(assertFence.body);}catch(e){throw Error(`tests.md ${id}: invalid JSON assertions: ${e.message}`);}}
    tests.push({id,title:title.replace(/\s*\(S\d+[^)]*\)\s*$/,''),scenario,given:step('Given'),when:step('When'),then:step('Then'),assertions});
  }
  return {tests,sha256:hash(text)};
}
export function parseIndex(text){
  const doc=parseMarkdown(text);
  const table=doc.tables.find(t=>t.headers.includes('ID'));
  return (table?.rows??[]).map(r=>({id:r.ID.replace(/^\[([^\]]+)\].*$/,'$1'),link:/\]\(([^)]+)\)/.exec(r.ID)?.[1]??null,method:r.Method,path:r.Path,useCase:r['Use case'],adapter:r.Adapter,specHash:r['Spec hash'],status:r.Status,apidog:r.Apidog}));
}
export function renderIndex(rows,{title='API Index',generatedBy='engineering-os'}={}){
  const header=['ID','Method','Path','Use case','Adapter','Spec hash','Status','Apidog'];
  const lines=[`# ${title}`,'',`Generated by ${generatedBy}. One row per endpoint; deep specs live beside each row's link. Do not edit by hand.`,'',`| ${header.join(' | ')} |`,`| ${header.map(()=>'---').join(' | ')} |`];
  for(const r of [...rows].sort((a,b)=>a.id.localeCompare(b.id)))lines.push(`| [${r.id}](${r.link}) | ${r.method} | ${r.path} | ${r.useCase} | ${r.adapter??''} | ${r.specHash} | ${r.status??'draft'} | ${r.apidog??'unsynced'} |`);
  return lines.join('\n')+'\n';
}
async function readOptional(path){try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
/** Load one endpoint bundle directory. */
export async function loadBundle(root,dir){
  const specText=await readFile(join(root,dir,'spec.md'),'utf8');
  const spec=parseSpec(specText,{path:join(dir,'spec.md')});
  const policiesText=await readOptional(join(root,dir,'policies.md')),testsText=await readOptional(join(root,dir,'tests.md'));
  return {dir,spec,specText,policies:policiesText?parsePolicies(policiesText):null,policiesText,tests:testsText?parseTests(testsText):null,testsText};
}
/** Walk docs/api/** for spec.md files. Sorted, deterministic. */
export async function loadAllBundles(root,{apiDir='docs/api'}={}){
  const out=[];
  async function walk(dir){
    const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    if(entries.some(e=>e.isFile()&&e.name==='spec.md')){out.push(await loadBundle(root,relative(root,dir).split(sep).join('/')));return;}
    for(const e of entries)if(e.isDirectory())await walk(join(dir,e.name));
  }
  try{if((await stat(join(root,apiDir))).isDirectory())await walk(join(root,apiDir));}catch(e){if(e.code!=='ENOENT')throw e;}
  const ids=new Set();for(const b of out){if(ids.has(b.spec.id))throw Error(`Duplicate endpoint id ${b.spec.id}`);ids.add(b.spec.id);}
  return out;
}
export function indexRow(bundle,{apiDir='docs/api',status='draft',apidog='unsynced'}={}){
  const {spec,dir}=bundle;
  return {id:spec.id,link:relative(apiDir,dir).split(sep).join('/')+'/spec.md',method:spec.method,path:spec.path,useCase:spec.summary,adapter:spec.adapter,specHash:spec.sha256.slice(0,12),status,apidog};
}
/** Structural-memory sync: derive api_nodes/api_edges from scenario call graphs. */
export function structuralEdges(bundle,{anchorSha=null}={}){
  const {spec}=bundle,from=`endpoint:${spec.id}`,edges=[];
  for(const s of spec.scenarios){
    for(const call of s.calls){const target=call.split(/[(\s]/)[0];const method=target.split('.').at(-1)??'';const kind=/Repository|Repo|Model|ORM|Store/i.test(target)?(/^(insert|create|save|update|delete|remove|upsert|write|put)/i.test(method)?'writes':'reads'):/Serializer|Schema|DTO|Validator/i.test(target)?'serializes':'calls';edges.push({from,to:`${kindPrefix(target)}:${target}`,kind,evidence:`${spec.id}/${s.id}`,anchorSha});}
    for(const m of s.mutations){const name=m.split(/[(\s]/)[0];if(name)edges.push({from,to:`model:${name}`,kind:'writes',evidence:`${spec.id}/${s.id}`,anchorSha});}
  }
  const seen=new Set();return edges.filter(e=>{const k=`${e.to}|${e.kind}`;if(seen.has(k))return false;seen.add(k);return true;});
}
const kindPrefix=target=>/Repository|Repo$/i.test(target)?'repository':/Model$|^[A-Z][a-z]+$/.test(target)?'model':/Serializer|Schema|DTO/i.test(target)?'schema':'service';
