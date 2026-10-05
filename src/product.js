import {mkdir,readFile,writeFile,rename,unlink,rm,realpath,stat,open,lstat,readlink,symlink,chmod} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {hostname} from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
const slug=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const documentTemplates={
  scope:['PRODUCT-SCOPE.md','Product scope','Define the problem, target users, included/excluded behavior, success criteria and approval reference.'],
  architectureRoadmap:['ARCHITECTURE-ROADMAP.md','Architecture roadmap','Describe the current/target architecture, component boundaries, sequencing, dependencies, technical risks and decision references. Choose a small vertical slice, assess reuse, justify patterns and alternatives, and define verification commands.'],
  roadmap:['PRODUCT-ROADMAP.md','Product roadmap','Map feature IDs to milestones, priorities, dependencies, acceptance criteria and delivery status.'],
  domains:['PRODUCT-DOMAINS.md','Product domains','Define domain IDs, responsibilities, owners, data ownership and cross-domain contracts.'],
  userFlows:['USER-FLOWS.md','Product user flows','Assign stable flow IDs. Describe actors, entry conditions, feature IDs, steps, success/error/permission paths and recovery.'],
  documentation:['USER-GUIDE.md','Product user guide','Document setup, user-facing behavior, examples, limitations and troubleshooting. Keep it aligned with the implemented version.']
};
const manualDocuments=p=>p.schemaVersion===2?Object.values(p.documents).filter(path=>path!==p.documents.features):[];
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function local(root,path){
  if(!nonempty(path)||isAbsolute(path))throw Error('Paths must be project-relative');
  const full=resolve(root,path),rel=relative(root,full);
  if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error(`Path escapes project: ${path}`);
  return full;
}
async function contained(root,path){
  const full=local(root,path),actual=await realpath(full),base=await realpath(root),rel=relative(base,actual);
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error(`Symlink escapes project: ${path}`);
  return full;
}
async function file(root,path){const full=await contained(root,path);if(!(await stat(full)).isFile())throw Error(`Expected file: ${path}`);return readFile(full);}
async function readJSON(root,path){return JSON.parse(await file(root,path));}
const transactions=new AsyncLocalStorage();
async function journalPath(path,directory=false) {
  const transaction=transactions.getStore();
  if(!transaction || transaction.entries.some(e=>e.path===path)) return;
  if(directory) {
    try {await lstat(path);throw Object.assign(new Error(`Directory already exists: ${path}`),{code:'EEXIST'});}
    catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  let previous=null,mode,link;
  if(!directory) try {
    const metadata=await lstat(path);
    if(metadata.isSymbolicLink())link=await readlink(path);
    else if(metadata.isFile()){previous=(await readFile(path)).toString('base64');mode=metadata.mode&0o7777;}
    else throw Error(`Unsupported transaction target: ${path}`);
  } catch(e) {if(e.code!=='ENOENT')throw e;}
  transaction.entries.push({path,previous,directory,...(mode===undefined?{}:{mode}),...(link===undefined?{}:{link})});
  const temporary=transaction.path+'.tmp';
  const handle=await open(temporary,'w');
  try { await handle.writeFile(json(transaction.entries));await handle.sync(); } finally { await handle.close(); }
  await rename(temporary,transaction.path);
}
async function atomic(path,value){
  await journalPath(path);
  const tmp=`${path}.${randomUUID()}.tmp`;
  try{
    let mode;try{const metadata=await lstat(path);if(metadata.isFile())mode=metadata.mode&0o7777;}catch(e){if(e.code!=='ENOENT')throw e;}
    await writeFile(tmp,value,{flag:'wx',...(mode===undefined?{}:{mode})});
    if(mode!==undefined)await chmod(tmp,mode);
    await rename(tmp,path);
  }
  finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function rollback(root,entries) {
  for(const entry of [...entries].reverse()) {
    const path=local(root,relative(root,entry.path));
    await destination(root,relative(root,path));
    if(entry.directory) await rm(path,{recursive:true,force:true});
    else if(entry.link!==undefined){
      const tmp=`${path}.${randomUUID()}.tmp`;
      try{await symlink(entry.link,tmp);await rename(tmp,path);}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    }
    else if(entry.previous===null) await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
    else {await atomic(path,Buffer.from(entry.previous,'base64'));if(entry.mode!==undefined)await chmod(path,entry.mode);}
  }
}
async function locked(root,fn){
  const path=join(root,'.product-map.lock');let handle;
  try{handle=await open(path,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Product map is locked; use product-recover after its writer exits');throw e;}
  const transaction={path:join(root,'.product-map.journal'),entries:[]};
  let release=true;
  try {
    await handle.writeFile(json({pid:process.pid,host:hostname(),time:new Date().toISOString()}));await handle.sync();
    const result=await transactions.run(transaction,fn);
    await unlink(transaction.path).catch(e=>{if(e.code!=='ENOENT')throw e;});
    return result;
  } catch(e) {
    try { await rollback(root,transaction.entries); } catch(rollbackError) {release=false;throw new Error('Product rollback failed; use product-recover after this writer exits',{cause:rollbackError});}
    await unlink(transaction.path).catch(error=>{if(error.code!=='ENOENT')throw error;});
    throw e;
  } finally {await handle.close();if(release)await unlink(path);}
}
export async function recoverProduct(root) {
  root=resolve(root);
  const mutex=await open(join(root,'.product-map.recover'),'wx');
  try {
    const path=join(root,'.product-map.lock'),raw=await readFile(path,'utf8'),before=await stat(path);
    let owner;try {owner=JSON.parse(raw);} catch {throw Error('Incomplete product lock; inspect manually');}
    if(owner.host!==hostname()||!Number.isInteger(owner.pid)||owner.pid<1) throw Error('Cannot establish local product lock ownership');
    try {process.kill(owner.pid,0);throw Error('Writer is still active; recovery refused');} catch(e) {if(e.code!=='ESRCH')throw e;}
    const journal=join(root,'.product-map.journal');
    let entries=[];try {entries=JSON.parse(await readFile(journal,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
    if(!Array.isArray(entries))throw Error('Invalid product journal');
    // Validate the entire undo log before changing any destination.
    const paths=new Set();
    for(const entry of entries){
      if(!entry||typeof entry.path!=='string'||!isAbsolute(entry.path)||paths.has(entry.path)||typeof entry.directory!=='boolean')throw Error('Invalid product journal entry');
      local(root,relative(root,entry.path));paths.add(entry.path);
      if(entry.previous!==null&&(typeof entry.previous!=='string'||Buffer.from(entry.previous,'base64').toString('base64')!==entry.previous))throw Error('Invalid product journal contents');
      if(entry.mode!==undefined&&(!Number.isInteger(entry.mode)||entry.mode<0||entry.mode>0o7777))throw Error('Invalid product journal permissions');
      if(entry.link!==undefined&&(typeof entry.link!=='string'||!entry.link||entry.previous!==null||entry.directory))throw Error('Invalid product journal symlink');
      if(entry.directory&&entry.previous!==null)throw Error('Invalid product journal directory');
    }
    const backup=join(root,`.product-map.backup.${randomUUID()}.json`);
    await writeFile(backup,json(entries),{flag:'wx'});
    if((await stat(path)).ino!==before.ino||await readFile(path,'utf8')!==raw)throw Error('Lock changed during recovery');
    await rollback(root,entries);
    await unlink(journal).catch(e=>{if(e.code!=='ENOENT')throw e;});await unlink(path);
    return {recovered:true,backup};
  } finally {await mutex.close();await unlink(join(root,'.product-map.recover'));}
}
function acyclic(nodes,dependencies,label){
  const visiting=new Set(),done=new Set();
  const visit=id=>{if(visiting.has(id))throw Error(`${label} dependency cycle at ${id}`);if(done.has(id))return;visiting.add(id);for(const dep of dependencies(id)){if(!nodes.has(dep))throw Error(`Unknown ${label} dependency: ${dep}`);visit(dep);}visiting.delete(id);done.add(id);};
  for(const id of nodes)visit(id);
}
function distinctStrings(values,label){if(!Array.isArray(values)||values.some(v=>!nonempty(v))||new Set(values).size!==values.length)throw Error(`Invalid ${label}`);}
export async function loadProduct(root){
  root=resolve(root);const product=await readJSON(root,'PRODUCT.json');
  if(![1,2].includes(product.schemaVersion)||!nonempty(product.name)||!Array.isArray(product.features))throw Error('Invalid product registry');
  await file(root,product.policies);await file(root,product.architecture);
  if(product.schemaVersion===2){
    if(!product.documents||!product.preparation||!['draft','ready'].includes(product.preparation.status)||!Array.isArray(product.domains))throw Error('Invalid product preparation metadata');
    const domains=new Set();for(const d of product.domains){if(!d||typeof d.id!=='string'||!slug.test(d.id)||domains.has(d.id)||!nonempty(d.description))throw Error('Invalid product domain');domains.add(d.id);}
    for(const key of [...Object.keys(documentTemplates),'features'])if(!nonempty(product.documents[key]))throw Error(`Missing product document: ${key}`);
    for(const path of manualDocuments(product))await file(root,path);
  }
  const features=new Map(),components=new Map();
  for(const entry of product.features){
    if(typeof entry.id!=='string'||!slug.test(entry.id)||features.has(entry.id))throw Error('Invalid or duplicate feature ID');
    const directory=await contained(root,entry.directory);if(!(await stat(directory)).isDirectory())throw Error('Feature directory required');
    const manifestPath=join(entry.directory,'feature.json'),f=await readJSON(root,manifestPath);
    if(f.schemaVersion!==1||f.id!==entry.id||!nonempty(f.title)||!['planned','implementing','implemented','retired'].includes(f.status)||!Array.isArray(f.components)||!Array.isArray(f.tests))throw Error(`Invalid feature manifest: ${entry.id}`);
    distinctStrings(f.dependsOn,'feature dependencies');
    if(product.schemaVersion===2){
      distinctStrings(f.domainIds,'feature domains');
      if(f.domainIds.some(id=>!product.domains.some(d=>d.id===id)))throw Error(`Unknown feature domain: ${f.id}`);
      if(['implementing','implemented'].includes(f.status)&&!f.domainIds.length)throw Error(`Implemented/implementing feature requires a domain: ${f.id}`);
      await file(root,f.documentation);await file(root,f.userFlows);
    }
    for(const doc of [f.scope,f.policies])await file(root,doc);
    const history=await readJSON(root,join(entry.directory,'history.json'));
    if(!Array.isArray(history)||new Set(history.map(v=>v.version)).size!==history.length||history.some(v=>!nonempty(v.version)||!Array.isArray(v.changes)||!v.changes.length||v.changes.some(c=>!nonempty(c))||!v.snapshot||!nonempty(v.time)))throw Error(`Invalid version history: ${f.id}`);
    for(const c of f.components){
      if(!nonempty(c.id)||components.has(c.id))throw Error(`Duplicate or invalid component ID: ${c.id}`);
      distinctStrings(c.dependsOn,'component dependencies');await file(root,c.path);components.set(c.id,{...c,featureId:f.id});
    }
    const testIds=new Set();for(const t of f.tests){
      if(!nonempty(t.id)||testIds.has(t.id)||!['unit','integration','e2e'].includes(t.type)||!nonempty(t.command))throw Error(`Invalid test mapping: ${f.id}`);
      testIds.add(t.id);await file(root,t.path);
    }
    if(f.status==='implemented'&&(!f.components.length||!f.tests.some(t=>t.type==='unit')))throw Error(`Implemented feature requires components and unit tests: ${f.id}`);
    features.set(f.id,{...f,directory:entry.directory,history,manifestPath});
  }
  acyclic(new Set(features.keys()),id=>features.get(id).dependsOn,'feature');
  acyclic(new Set(components.keys()),id=>components.get(id).dependsOn,'component');
  for(const c of components.values())for(const dep of c.dependsOn){const owner=components.get(dep).featureId;if(owner!==c.featureId&&!features.get(c.featureId).dependsOn.includes(owner))throw Error(`Component ${c.id} depends on feature ${owner} without a feature dependency`);}
  return {root,product,features,components};
}
const escapeCell=s=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
const link=p=>'<'+p.split(/[\\/]/).map(encodeURIComponent).join('/')+'>';
function index(model){
  const rows=[`# ${model.product.name}`, '', 'Generated from PRODUCT.json and feature manifests. Edit those files, then run product-sync.', '', `Product [policies](${link(model.product.policies)}) · [architecture](${link(model.product.architecture)})`, ...(model.product.schemaVersion===2?['',...Object.entries(model.product.documents).map(([name,path])=>`- [${name}](${link(path)})`)]:[]), '', '| Feature | Directory | Status | Dependencies | Latest version | Components / tests |', '| --- | --- | --- | --- | --- | --- |'];
  for(const f of model.features.values())rows.push(`| [${escapeCell(f.title)}](${link(f.scope)}) | [${escapeCell(f.directory)}](${link(f.directory)}) | ${f.status} | ${escapeCell(f.dependsOn.join(', ')||'—')} | ${escapeCell(f.history.at(-1)?.version??'unreleased')} | ${f.components.length} / ${f.tests.length} |`);
  return rows.join('\n')+'\n';
}
export async function initProduct(root,name){
  root=resolve(root);if(!nonempty(name))throw Error('Product name required');await mkdir(root,{recursive:true});
  return locked(root,async()=>{
    const product={schemaVersion:2,name,policies:'PRODUCT-POLICIES.md',architecture:'PRODUCT-ARCHITECTURE.md',documents:Object.fromEntries([...Object.entries(documentTemplates).map(([key,value])=>[key,value[0]]),['features','FEATURES.md']]),domains:[],preparation:{status:'draft'},features:[]};
    const files={'PRODUCT.json':json(product),'PRODUCT-POLICIES.md':'# Product policies\n\nRecord product-wide rules, ownership, applicability, and exceptions here. Feature rules inherit these policies.\n','PRODUCT-ARCHITECTURE.md':'# Product architecture\n\nRecord component boundaries, shared interfaces, dependency direction, data ownership, and testing conventions here. Document design decisions with IDs, patterns (or simple modules), reasons, alternatives and tradeoffs. Use existing framework conventions and components where applicable.\n','PRODUCT.md':index({product,features:new Map()})};
    for(const [path,title,instructions] of Object.values(documentTemplates))files[path]=`# ${title}\n\n${instructions}\n`;
    files['FEATURES.md']=featureList({product,features:new Map()});
    // Reject existing targets before recording undo entries, including dangling symlinks.
    for(const path of Object.keys(files)) {
      try{await lstat(join(root,path));throw Object.assign(new Error(`Target already exists: ${path}`),{code:'EEXIST'});}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    for(const [path,contents] of Object.entries(files)){await journalPath(join(root,path));await writeFile(join(root,path),contents,{flag:'wx'});}
    return {root,index:join(root,'PRODUCT.md'),registry:join(root,'PRODUCT.json')};
  });
}
export async function addFeature(root,id,title){
  root=resolve(root);if(typeof id!=='string'||!slug.test(id)||!nonempty(title))throw Error('Feature needs a lowercase kebab-case ID and title');
  return locked(root,async()=>{
    const model=await loadProduct(root);if(model.features.has(id))throw Error('Feature already registered');
    await mkdir(join(root,'features'),{recursive:true});await contained(root,'features');
    const directory=`features/${id}`,dir=local(root,directory);await journalPath(dir,true);await mkdir(dir);
    const f={schemaVersion:1,id,title,status:'planned',...(model.product.schemaVersion===2?{domainIds:[],documentation:`${directory}/README.md`,userFlows:`${directory}/USER-FLOWS.md`}:{}),scope:`${directory}/SCOPE.md`,policies:`${directory}/POLICIES.md`,dependsOn:[],components:[],tests:[]};
    await writeFile(join(dir,'feature.json'),json(f),{flag:'wx'});
    await writeFile(join(dir,'SCOPE.md'),`# ${title}: scope\n\n## Purpose\n\nDescribe the user problem and intended behavior.\n\n## Included and excluded\n\nRecord the approved boundaries and scope decision reference.\n\n## Acceptance criteria\n\nAssign stable criterion IDs and observable checks.\n\n## Interfaces and data\n\nRecord public component contracts, data ownership, and compatibility requirements.\n`,{flag:'wx'});
    await writeFile(join(dir,'POLICIES.md'),`# ${title}: policies\n\nInherit ../../PRODUCT-POLICIES.md. Record feature-specific rules with IDs, applicability, enforcement owner, and exception procedure.\n`,{flag:'wx'});
    await writeFile(join(dir,'history.json'),'[]\n',{flag:'wx'});
    if(model.product.schemaVersion===2){
      await writeFile(join(dir,'README.md'),`# ${title}: user documentation\n\nDescribe actual behavior, usage, setup, examples, errors and limitations. Link acceptance criteria and flow IDs.\n`,{flag:'wx'});
      await writeFile(join(dir,'USER-FLOWS.md'),`# ${title}: user flows\n\nDocument flow IDs, actors, preconditions, steps, success/failure paths and associated unit/integration test IDs. Link the root USER-FLOWS.md.\n`,{flag:'wx'});
    }
    model.product.features.push({id,directory});await atomic(join(root,'PRODUCT.json'),json(model.product));
    await writeIndexes(await loadProduct(root));return f;
  });
}
export async function syncProduct(root){root=resolve(root);return locked(root,async()=>{const model=await loadProduct(root);await writeIndexes(model);return {features:model.features.size,index:join(root,'PRODUCT.md')};});}
function featureList(model){return '# Feature list\n\n'+index(model).slice(index(model).indexOf('| Feature |'));}
async function destination(root,path){const full=local(root,path),base=await realpath(root),parent=await realpath(dirname(full)),rel=relative(base,parent);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error(`Generated file parent escapes project: ${path}`);return full;}
async function writeIndexes(model){await atomic(join(model.root,'PRODUCT.md'),index(model));if(model.product.schemaVersion===2)await atomic(await destination(model.root,model.product.documents.features),featureList(model));}
async function snapshotPaths(root,paths){const snapshot=Object.create(null);for(const path of new Set(paths))snapshot[path]=hash(await file(root,path));return snapshot;}
function featurePaths(m,f){
  const upstream=new Set();const visit=id=>{for(const dep of m.features.get(id).dependsOn)if(!upstream.has(dep)){upstream.add(dep);visit(dep);}};visit(f.id);
  const mapped=[f,...[...upstream].map(id=>m.features.get(id))];
  return [...(m.product.schemaVersion===2?['PRODUCT.json']:[]),m.product.policies,m.product.architecture,...manualDocuments(m.product),...mapped.flatMap(feature=>[feature.manifestPath,feature.scope,feature.policies,...(m.product.schemaVersion===2?[feature.documentation,feature.userFlows]:[]),...feature.components.map(c=>c.path),...feature.tests.map(t=>t.path)])];
}
function testResults(f,results){if(!Array.isArray(results)||f.tests.some(t=>!results.some(r=>r.id===t.id&&r.status==='passed'&&r.command===t.command&&nonempty(r.result))))throw Error('Record passing results for every mapped test');}
export async function checkFeatureSync(root,id,model){
  const m=model??await loadProduct(root),f=m.features.get(id);if(!f)throw Error('Unknown feature');
  if(m.product.schemaVersion!==2)return {valid:true,legacy:true};
  let record;try{record=await readJSON(m.root,join(f.directory,'synchronization.json'));}catch(e){if(e.code==='ENOENT')throw Error(`Feature ${id} is out of sync; run feature-sync with review and test evidence`);throw e;}
  const current=await snapshotPaths(m.root,featurePaths(m,f));
  if(JSON.stringify(current)!==JSON.stringify(record.snapshot))throw Error(`Feature ${id} is out of sync; review documents, flows and tests, then run feature-sync`);
  if(record.featureId!==id||record.schemaVersion!==1||!Array.isArray(record.artifacts)||JSON.stringify(await snapshotPaths(m.root,record.artifacts))!==JSON.stringify(record.artifactSnapshot))throw Error(`Feature ${id} validation evidence changed; run feature-sync again`);
  testResults(f,record.tests);validateAssessments(record.assessments);return {valid:true,featureId:id};
}
function validateAssessments(assessments){for(const key of ['documentation','userFlows','unitTests'])if(!assessments?.[key]||!['updated','unchanged'].includes(assessments[key].status)||!nonempty(assessments[key].reason))throw Error(`Synchronization requires ${key} assessment with status and reason`);}
export async function syncFeature(root,id,record){
  root=resolve(root);return locked(root,async()=>{
    const m=await loadProduct(root),f=m.features.get(id);if(!f)throw Error('Unknown feature');if(m.product.schemaVersion!==2)throw Error('Feature synchronization requires product schema 2');
    if(f.status!=='implemented')throw Error('Synchronize after feature implementation');validateAssessments(record?.assessments);testResults(f,record.tests);
    if(!Array.isArray(record.artifacts)||!record.artifacts.length)throw Error('Synchronization requires test/review artifact paths');
    const artifactSnapshot=await snapshotPaths(root,record.artifacts),snapshot=await snapshotPaths(root,featurePaths(m,f));
    let previous;try{previous=await readJSON(root,join(f.directory,'synchronization.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    const groups={documentation:[f.documentation,f.scope,f.policies,m.product.policies,m.product.architecture,...manualDocuments(m.product).filter(p=>p!==m.product.documents.userFlows)],userFlows:[f.userFlows,m.product.documents.userFlows],unitTests:f.tests.filter(t=>t.type==='unit').map(t=>t.path)};
    if(previous)for(const [name,paths] of Object.entries(groups)){const changed=paths.some(p=>previous.snapshot?.[p]!==snapshot[p]);if(changed&&record.assessments[name].status!=='updated')throw Error(`${name} changed; record updated assessment`);if(!changed&&record.assessments[name].status==='updated')throw Error(`${name} has no content changes; record unchanged assessment with reason`);}
    const result={schemaVersion:1,featureId:id,time:new Date().toISOString(),assessments:record.assessments,tests:record.tests,artifacts:record.artifacts,artifactSnapshot,snapshot};
    await atomic(join(root,f.directory,'synchronization.json'),json(result));return result;
  });
}
export async function prepareProduct(root,record){
  root=resolve(root);return locked(root,async()=>{
    const m=await loadProduct(root);if(m.product.schemaVersion!==2)throw Error('Preparation requires product schema 2');
    if(!m.product.domains.length||!m.features.size)throw Error('Define product domains and feature list before implementation');
    if([...m.features.values()].some(f=>!f.domainIds.length))throw Error('Assign domains to every planned feature');
    if(!record||!nonempty(record.summary)||!Array.isArray(record.artifacts)||!record.artifacts.length)throw Error('Preparation requires summary and planning artifact paths');
    const artifactSnapshot=await snapshotPaths(root,record.artifacts);
    const paths=[m.product.architecture,m.product.policies,...manualDocuments(m.product),...[...m.features.values()].flatMap(f=>[f.scope,f.policies,f.documentation,f.userFlows])];
    m.product.preparation={status:'ready',time:new Date().toISOString(),summary:record.summary,artifacts:record.artifacts,artifactSnapshot,snapshot:await snapshotPaths(root,paths),featurePlans:[...m.features.values()].map(f=>({id:f.id,domainIds:f.domainIds,scope:f.scope,policies:f.policies,documentation:f.documentation,userFlows:f.userFlows})),domains:m.product.domains,features:[...m.features.keys()]};
    await atomic(join(root,'PRODUCT.json'),json(m.product));await writeIndexes(await loadProduct(root));return m.product.preparation;
  });
}
export async function checkProductPrepared(root){
  const m=await loadProduct(root),p=m.product.preparation;
  if(m.product.schemaVersion!==2||p.status!=='ready'||!p.snapshot)throw Error('Prepare product scope, domains, roadmaps, feature list, user flows and documentation before implementation; run product-ready');
  if(JSON.stringify(await snapshotPaths(m.root,p.artifacts))!==JSON.stringify(p.artifactSnapshot)||JSON.stringify(p.featurePlans)!==JSON.stringify([...m.features.values()].map(f=>({id:f.id,domainIds:f.domainIds,scope:f.scope,policies:f.policies,documentation:f.documentation,userFlows:f.userFlows})))||JSON.stringify(await snapshotPaths(m.root,Object.keys(p.snapshot)))!==JSON.stringify(p.snapshot)||JSON.stringify(p.domains)!==JSON.stringify(m.product.domains)||JSON.stringify(p.features)!==JSON.stringify([...m.features.keys()]))throw Error('Product planning documents changed; review and run product-ready again');
  return {ready:true};
}
export async function checkProduct(root,{requireSync=true}={}){
  const m=await loadProduct(root);const current=await readFile(join(m.root,'PRODUCT.md'),'utf8');if(current!==index(m))throw Error('PRODUCT.md is stale; run product-sync');
  if(m.product.schemaVersion===2){if(await file(m.root,m.product.documents.features).then(b=>b.toString())!==featureList(m))throw Error('Feature list is stale; run product-sync');if(requireSync)for(const f of m.features.values())if(f.status==='implemented')await checkFeatureSync(m.root,f.id,m);}
  return {valid:true,features:m.features.size,components:m.components.size,tests:[...m.features.values()].reduce((n,f)=>n+f.tests.length,0)};
}
export async function featureContext(root,id){
  const m=await loadProduct(root);if(!m.features.has(id))throw Error('Unknown feature');
  const dependencies=new Set(),dependents=new Set();
  const upstream=x=>{for(const dep of m.features.get(x).dependsOn)if(!dependencies.has(dep)){dependencies.add(dep);upstream(dep);}};upstream(id);
  const downstream=x=>{for(const f of m.features.values())if(f.dependsOn.includes(x)&&!dependents.has(f.id)){dependents.add(f.id);downstream(f.id);}};downstream(id);
  const affected=[id,...dependents];
  return {feature:m.features.get(id),dependencies:[...dependencies],dependents:[...dependents],readFiles:[m.product.policies,m.product.architecture,...manualDocuments(m.product),...[id,...dependencies].flatMap(x=>{const f=m.features.get(x);return [f.manifestPath,f.scope,f.policies,...(m.product.schemaVersion===2?[f.documentation,f.userFlows]:[])];})],affectedTests:affected.flatMap(x=>m.features.get(x).tests.map(t=>({...t,featureId:x})))};
}
export async function releaseFeature(root,id,record){
  root=resolve(root);return locked(root,async()=>{
    const m=await loadProduct(root),f=m.features.get(id);if(!f)throw Error('Unknown feature');
    if(f.status!=='implemented')throw Error('Only implemented features can record a version');
    if(!record||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.version)||!Array.isArray(record.changes)||!record.changes.length||record.changes.some(c=>!nonempty(c))||!nonempty(record.codeRevision))throw Error('Version requires semantic version, changes, and codeRevision');
    if(f.history.some(v=>v.version===record.version))throw Error('Version already recorded');
    testResults(f,record.tests);
    if(m.product.schemaVersion===2)await checkFeatureSync(root,id);
    if(!Array.isArray(record.artifacts)||!record.artifacts.length)throw Error('Version requires validation artifact paths');
    const paths=[...featurePaths(m,f),...(m.product.schemaVersion===2?[join(f.directory,'synchronization.json')]:[]),...record.artifacts];
    const snapshot=Object.create(null);for(const path of new Set(paths))snapshot[path]=hash(await file(root,path));
    const entry={version:record.version,time:new Date().toISOString(),codeRevision:record.codeRevision,changes:record.changes,tests:record.tests,artifacts:record.artifacts,snapshot};
    f.history.push(entry);await atomic(join(root,f.directory,'history.json'),json(f.history));await writeIndexes(await loadProduct(root));return entry;
  });
}
