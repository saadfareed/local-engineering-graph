// Apidog Sync & Verification Bridge.
//
// Compiles docs/api/** Markdown bundles into OpenAPI 3.1 plus a Postman-v2.1 compatible test
// collection (Apidog imports both), pushes the contract to Apidog through its Open API
// (POST /v1/projects/{id}/import-openapi, header X-Apidog-Api-Version: 2024-03-28) and runs the
// Apidog CLI (`apidog run --access-token … -t <scenario> -r cli,json --out-dir …`) during
// validation gates. CLI results are mapped back to spec scenarios by the naming convention
// "<endpointId>::<testId>" and written into INDEX.md's Apidog column.
//
// Only the compile step is fully deterministic. Push and run talk to Apidog; confirm the Open API
// request options and the JSON reporter shape against current Apidog docs (brief 06) before
// relying on them unattended. Tokens are read from the environment, never from files in the repo.
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadAllBundles,renderIndex,indexRow,parseIndex} from '../contracts/spec.js';
import {runProcess} from '../daemon/bus.js';
import {canonical,sha256,nowIso} from '../kernel/util.js';

export const PROBLEM_SCHEMA={type:'object',required:['code','message'],properties:{code:{type:'string'},message:{type:'string'},details:{type:'object',additionalProperties:true}}};
const toTitle=id=>id.split(/[^A-Za-z0-9]+/).filter(Boolean).map(s=>s[0].toUpperCase()+s.slice(1)).join('');

/** OpenAPI 3.1 document from parsed bundles. */
export function openApiFromBundles(bundles,{info={title:'API',version:'1.0.0'},servers=[],components={}}={}){
  const doc={openapi:'3.1.0',info,servers,paths:{},components:{schemas:{Problem:PROBLEM_SCHEMA,...(components.schemas??{})},securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',bearerFormat:'JWT'},...(components.securitySchemes??{})}},tags:[]};
  const tags=new Set();
  for(const b of [...bundles].sort((a,b)=>a.spec.id.localeCompare(b.spec.id))){
    const {spec,policies,tests}=b;tags.add(spec.domain);
    const parameters=[...spec.params.map(name=>({name,in:'path',required:true,schema:{type:'string'}})),
      ...spec.headers.filter(h=>!/^authorization$/i.test(h.name)).map(h=>({name:h.name,in:'header',required:h.required,description:h.description,schema:{type:'string'}}))];
    const op={operationId:spec.id,summary:spec.summary,description:spec.useCase||undefined,tags:[spec.domain],parameters,
      responses:Object.fromEntries(Object.entries(spec.responses).map(([status,r])=>[status,{description:r.description,...(r.schema?{content:{'application/json':{schema:r.schema}}}:{})}])),
      'x-engineering-os':{endpointId:spec.id,specSha256:spec.sha256,adapter:spec.adapter,version:spec.version,owner:spec.owner,scenarios:spec.scenarios,policies:policies?{...policies.raw,invariants:policies.invariants,sha256:policies.sha256}:null,tests:tests?tests.tests.map(t=>({id:t.id,scenario:t.scenario,title:t.title})):[]}};
    if(spec.request&&!['GET','DELETE','HEAD'].includes(spec.method))op.requestBody={required:true,content:{'application/json':{schema:spec.request}}};
    if(spec.headers.some(h=>/^authorization$/i.test(h.name)))op.security=[{bearerAuth:[]}];
    if(!Object.keys(op.responses).length)op.responses={default:{description:'Unspecified'}};
    (doc.paths[spec.path]??={})[spec.method.toLowerCase()]=op;
  }
  doc.tags=[...tags].sort().map(name=>({name}));
  return doc;
}
// ---- Postman v2.1 collection (Apidog imports it as endpoints + test cases) ---------------------
function assertionScript(test,endpointId){
  const a=test.assertions??{},lines=[];
  if(a.status!==undefined)lines.push(`pm.test(${JSON.stringify(`${endpointId}::${test.id} status ${a.status}`)}, function () { pm.response.to.have.status(${Number(a.status)}); });`);
  if(a.body&&typeof a.body==='object')lines.push(`pm.test(${JSON.stringify(`${endpointId}::${test.id} body subset`)}, function () { const body = pm.response.json(); const expected = ${JSON.stringify(a.body)}; for (const k of Object.keys(expected)) pm.expect(body[k]).to.eql(expected[k]); });`);
  for(const [path,frag] of Object.entries(a.jsonpath??{})){
    const accessor=path.replace(/^\$\.?/,'').split('.').filter(Boolean).map(p=>`[${JSON.stringify(p)}]`).join('');
    const checks=[];if(frag.type)checks.push(`pm.expect(typeof v).to.eql(${JSON.stringify(frag.type==='integer'?'number':frag.type)});`);if(frag.minimum!==undefined)checks.push(`pm.expect(v).to.be.at.least(${Number(frag.minimum)});`);if(frag.enum)checks.push(`pm.expect(${JSON.stringify(frag.enum)}).to.include(v);`);if(frag.pattern)checks.push(`pm.expect(String(v)).to.match(new RegExp(${JSON.stringify(frag.pattern)}));`);
    lines.push(`pm.test(${JSON.stringify(`${endpointId}::${test.id} ${path}`)}, function () { const v = pm.response.json()${accessor}; ${checks.join(' ')} });`);
  }
  return lines;
}
export function collectionFromBundles(bundles,{name='engineering-os',baseUrlVar='baseUrl'}={}){
  const item=[];
  for(const b of [...bundles].sort((a,b)=>a.spec.id.localeCompare(b.spec.id))){
    const {spec,tests}=b;
    if(tests)for(const t of tests.tests)if(t.scenario&&!spec.scenarios.some(s=>s.id===t.scenario.split(/\s/)[0]))throw Error(`${spec.id}: test ${t.id} references undefined scenario ${t.scenario}`);
    const requests=(tests?.tests??[]).map(t=>{
      const req=t.assertions?.request??{};
      let path=spec.path;for(const [k,v] of Object.entries(req.path??{}))path=path.replace(`{${k}}`,encodeURIComponent(String(v)));
      const header=[...spec.headers.filter(h=>h.required||req.headers?.[h.name]!==undefined).map(h=>({key:h.name,value:req.headers?.[h.name]??(/^authorization$/i.test(h.name)?'Bearer {{token}}':`{{${h.name.toLowerCase().replace(/[^a-z0-9]+/g,'_')}}}`)})),{key:'Content-Type',value:'application/json'}];
      return {name:`${spec.id}::${t.id}`,event:[{listen:'test',script:{type:'text/javascript',exec:assertionScript(t,spec.id)}}],
        request:{method:spec.method,header,url:{raw:`{{${baseUrlVar}}}${path}`,host:[`{{${baseUrlVar}}}`],path:path.split('/').filter(Boolean)},...(req.body!==undefined?{body:{mode:'raw',raw:JSON.stringify(req.body,null,2),options:{raw:{language:'json'}}}}:{})},
        description:[t.title,...t.given.map(g=>`Given: ${g}`),...t.when.map(w=>`When: ${w}`),...t.then.map(x=>`Then: ${x}`)].join('\n')};
    });
    item.push({name:spec.id,description:spec.summary,item:requests});
  }
  return {info:{name,schema:'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',description:'Generated by engineering-os from docs/api; do not edit.'},item,variable:[{key:baseUrlVar,value:'http://127.0.0.1:8000'},{key:'token',value:''}]};
}
/** Compile everything under docs/api into .engineering/apidog/{openapi.json,collection.json,manifest.json}. */
export async function exportAll({root,apiDir='docs/api',outDir='.engineering/apidog',info,servers}={}){
  const bundles=await loadAllBundles(root,{apiDir});
  if(!bundles.length)throw Error(`No endpoint bundles under ${apiDir}`);
  const openapi=openApiFromBundles(bundles,{info:info??{title:'API',version:'1.0.0'},servers:servers??[]});
  const collection=collectionFromBundles(bundles);
  const dir=resolve(root,outDir);await mkdir(dir,{recursive:true});
  const files={openapi:join(dir,'openapi.json'),collection:join(dir,'collection.json'),manifest:join(dir,'manifest.json')};
  await writeFile(files.openapi,JSON.stringify(openapi,null,2)+'\n');await writeFile(files.collection,JSON.stringify(collection,null,2)+'\n');
  const manifest={version:1,generatedAt:nowIso(),endpoints:bundles.map(b=>({id:b.spec.id,specSha256:b.spec.sha256,policiesSha256:b.policies?.sha256??null,testsSha256:b.tests?.sha256??null,tests:(b.tests?.tests??[]).map(t=>`${b.spec.id}::${t.id}`)})),openapiSha256:sha256(canonical(openapi)),collectionSha256:sha256(canonical(collection))};
  await writeFile(files.manifest,JSON.stringify(manifest,null,2)+'\n');
  return {bundles,openapi,collection,manifest,files};
}
/** Push the OpenAPI document to Apidog. Token comes from `token` or APIDOG_ACCESS_TOKEN. */
export async function pushOpenApi({projectId,document,token=process.env.APIDOG_ACCESS_TOKEN,apiBase='https://api.apidog.com',apiVersion='2024-03-28',options={},fetchImpl=globalThis.fetch,timeoutMs=60000}){
  if(!projectId)throw Error('pushOpenApi requires projectId');if(!token)throw Error('pushOpenApi requires an Apidog access token (APIDOG_ACCESS_TOKEN)');
  const body={input:JSON.stringify(document),options:{endpointOverwriteBehavior:'OVERWRITE_EXISTING',schemaOverwriteBehavior:'OVERWRITE_EXISTING',updateFolderOfChangedEndpoint:false,...options}};
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetchImpl(`${apiBase}/v1/projects/${encodeURIComponent(projectId)}/import-openapi`,{method:'POST',headers:{'content-type':'application/json','X-Apidog-Api-Version':apiVersion,authorization:`Bearer ${token}`},body:JSON.stringify(body),signal:controller.signal});
    const text=await res.text();let parsed=null;try{parsed=JSON.parse(text);}catch{}
    return {ok:res.ok,status:res.status,body:parsed??text,syncedAt:nowIso(),documentSha256:sha256(canonical(document))};
  }finally{clearTimeout(timer);}
}
/** Run the Apidog CLI as a deterministic verifier and collect its JSON report. */
export async function runApidogCli({cwd,outDir,bin='apidog',accessToken=process.env.APIDOG_ACCESS_TOKEN,scenarioId=null,folderId=null,testSuite=null,environmentId=null,extraArgs=[],argv=null,timeoutMs=30*60*1000,env={}}){
  await mkdir(outDir,{recursive:true});
  let command=argv;
  if(!command){
    if(!accessToken)throw Error('runApidogCli requires an access token (APIDOG_ACCESS_TOKEN)');
    if(!scenarioId&&!folderId&&!testSuite)throw Error('runApidogCli requires scenarioId, folderId or testSuite');
    command=[bin,'run','--access-token',accessToken,...(scenarioId?['-t',String(scenarioId)]:[]),...(folderId?['-f',String(folderId)]:[]),...(testSuite?['--test-suite',String(testSuite)]:[]),...(environmentId?['-e',String(environmentId)]:[]),'-r','cli,json','--out-dir',outDir,...extraArgs];
  }
  const result=await runProcess(command,{cwd,env,timeoutMs,logPrefix:join(outDir,'apidog-cli')});
  const reports=(await readdir(outDir)).filter(f=>f.endsWith('.json')&&f!=='summary.json').sort();
  let report=null,reportPath=null,reportSha256=null;
  if(reports.length){reportPath=join(outDir,reports.at(-1));const text=await readFile(reportPath,'utf8');reportSha256=sha256(text);try{report=JSON.parse(text);}catch{report=null;}}
  const summary=report?summarizeReport(report):{total:0,passed:0,failed:0,items:[],parsed:false};
  const redacted=command.map((a,i)=>command[i-1]==='--access-token'?'***':a);
  const out={command:redacted.join(' '),exitCode:result.exitCode,timedOut:result.timedOut,durationMs:result.durationMs,stdoutSha256:result.stdoutSha256,stderrSha256:result.stderrSha256,reportPath,reportSha256,summary,passed:result.exitCode===0&&!result.timedOut&&summary.failed===0,ranAt:nowIso()};
  await writeFile(join(outDir,'summary.json'),JSON.stringify(out,null,2)+'\n');
  return out;
}
/** Shape-tolerant reader for the Apidog CLI JSON reporter: walks the tree for named items with a pass/fail marker. */
export function summarizeReport(report){
  const items=new Map();
  const passedOf=o=>{
    if(typeof o.passed==='boolean')return o.passed;
    for(const k of ['status','result','state']){const v=o[k];if(typeof v==='string'){if(/^(pass|passed|success|succeeded|ok)$/i.test(v))return true;if(/^(fail|failed|error|errored)$/i.test(v))return false;}}
    if(Array.isArray(o.assertions)&&o.assertions.length)return o.assertions.every(a=>passedOf(a)!==false);
    if(typeof o.failedCount==='number'||typeof o.failCount==='number')return (o.failedCount??o.failCount)===0;
    return null;
  };
  const walk=(node,depth)=>{
    if(!node||typeof node!=='object'||depth>12)return;
    if(Array.isArray(node)){node.forEach(n=>walk(n,depth+1));return;}
    const name=node.name??node.title??node.requestName;
    const p=passedOf(node);
    if(typeof name==='string'&&p!==null&&!items.has(name))items.set(name,p);
    for(const v of Object.values(node))if(v&&typeof v==='object')walk(v,depth+1);
  };
  walk(report,0);
  const list=[...items].map(([name,passed])=>({name,passed})).sort((a,b)=>a.name.localeCompare(b.name));
  const counters=report?.summary??report?.stats??report;
  const total=Number.isInteger(counters?.total)?counters.total:list.length,failed=Number.isInteger(counters?.failed??counters?.failedCount)?(counters.failed??counters.failedCount):list.filter(i=>!i.passed).length;
  return {total,passed:total-failed,failed,items:list,parsed:true};
}
/** Join CLI results to spec scenarios: every tests.md case must have a passing Apidog item named "<endpointId>::<testId>". */
export function verifyAgainstSpec({summary,bundles}){
  const byName=new Map(summary.items.map(i=>[i.name,i.passed]));
  const matrix=[];
  for(const b of bundles)for(const t of b.tests?.tests??[]){const name=`${b.spec.id}::${t.id}`;const p=byName.get(name);matrix.push({endpointId:b.spec.id,test:t.id,scenario:t.scenario,apidogItem:name,status:p===undefined?'missing':p?'passed':'failed'});}
  const byEndpoint={};for(const row of matrix)(byEndpoint[row.endpointId]??=[]).push(row);
  const endpoints=Object.fromEntries(Object.entries(byEndpoint).map(([id,rows])=>[id,rows.every(r=>r.status==='passed')?'verified':rows.some(r=>r.status==='failed')?'failed':'incomplete']));
  return {matrix,endpoints,passed:matrix.length>0&&matrix.every(r=>r.status==='passed')};
}
/** Regenerate docs/api/INDEX.md, merging prior Status/Apidog cells with the overrides supplied. */
export async function writeIndex({root,apiDir='docs/api',bundles=null,statuses={},apidog={}}){
  bundles??=await loadAllBundles(root,{apiDir});
  let previous=[];try{previous=parseIndex(await readFile(join(root,apiDir,'INDEX.md'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const prev=new Map(previous.map(r=>[r.id,r]));
  const rows=bundles.map(b=>{const p=prev.get(b.spec.id);const changed=p&&p.specHash!==b.spec.sha256.slice(0,12);return indexRow(b,{apiDir,status:statuses[b.spec.id]??(changed?'draft':p?.status??'draft'),apidog:apidog[b.spec.id]??(changed?'unsynced':p?.apidog??'unsynced')});});
  const text=renderIndex(rows);await mkdir(join(root,apiDir),{recursive:true});await writeFile(join(root,apiDir,'INDEX.md'),text);
  return {rows,sha256:sha256(text)};
}
export const toSchemaName=toTitle;
