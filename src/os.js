#!/usr/bin/env node
// engineering-os kernel CLI (additive to src/cli.js, which stays the graph/task runner).
//   node src/os.js api-index ROOT                              regenerate docs/api/INDEX.md
//   node src/os.js api-export ROOT [--title T --version V]     OpenAPI 3.1 + collection into .engineering/apidog
//   node src/os.js api-push ROOT PROJECT_ID                    push openapi.json to Apidog (APIDOG_ACCESS_TOKEN)
//   node src/os.js api-verify ROOT OUT_DIR -t SCENARIO [-e ENV] run Apidog CLI and map results onto spec scenarios
//   node src/os.js memory-sync ROOT                            rebuild structural memory from docs/api + invalidate stale memories
//   node src/os.js context ROOT ENDPOINT_ID "objective" [--task TASK_DIR] [--budget 4000]
//   node src/os.js select-stack ROOT TASK_ID INTENT_JSON       emit an AWAITING_HUMAN decision card
//   node src/os.js delta ROOT DELTA_JSON                        append a HITL delta
//   node src/os.js swarm ROOT TASK_DIR PLAN_JSON [--serve PORT] dispatch a swarm plan
//   node src/os.js consolidate ROOT [--swarm REPORT_JSON]       run the sleep cycle
//   node src/os.js memory-stats ROOT
import {readFile} from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {MemoryStore} from './memory/store.js';
import {compileContext} from './memory/compiler.js';
import {appendDelta,consolidate} from './memory/consolidate.js';
import {SwarmBus} from './daemon/bus.js';
import {exportAll,pushOpenApi,runApidogCli,verifyAgainstSpec,writeIndex} from './exporters/apidog-sync.js';
import {loadAllBundles,structuralEdges} from './contracts/spec.js';
import {selectStack} from './intent/selector.js';

const osHome=process.env.ENGINEERING_OS_HOME??join(homedir(),'.engineering-os');
const flag=(args,name,fallback)=>{const i=args.indexOf(name);if(i===-1)return fallback;const v=args[i+1];args.splice(i,2);return v;};
const headSha=root=>{const r=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});return r.status===0?r.stdout.trim():null;};
const openStore=root=>{const dir=join(resolve(root),'.engineering','memory');mkdirSync(dir,{recursive:true});return new MemoryStore(join(dir,'memory.sqlite'));};
const [command,...args]=process.argv.slice(2);
try{
  let result;
  if(command==='api-index'){const root=resolve(args[0]);result=await writeIndex({root});}
  else if(command==='api-export'){const title=flag(args,'--title','API'),version=flag(args,'--version','1.0.0');const root=resolve(args[0]);const r=await exportAll({root,info:{title,version}});result={files:r.files,endpoints:r.manifest.endpoints.length,openapiSha256:r.manifest.openapiSha256};}
  else if(command==='api-push'){const root=resolve(args[0]);const doc=JSON.parse(await readFile(join(root,'.engineering','apidog','openapi.json'),'utf8'));result=await pushOpenApi({projectId:args[1],document:doc});if(result.ok){const ids=Object.values(doc.paths).flatMap(p=>Object.values(p).map(o=>o.operationId));await writeIndex({root,apidog:Object.fromEntries(ids.map(id=>[id,`synced ${result.syncedAt}`]))});}}
  else if(command==='api-verify'){const scenarioId=flag(args,'-t',null),folderId=flag(args,'-f',null),environmentId=flag(args,'-e',null);const root=resolve(args[0]),outDir=resolve(root,args[1]);const run=await runApidogCli({cwd:root,outDir,scenarioId,folderId,environmentId});const bundles=await loadAllBundles(root);const v=verifyAgainstSpec({summary:run.summary,bundles});await writeIndex({root,statuses:Object.fromEntries(Object.entries(v.endpoints).filter(([,s])=>s==='verified')),apidog:Object.fromEntries(Object.keys(v.endpoints).map(id=>[id,`${v.endpoints[id]==='verified'?'synced':'failed'} ${run.ranAt}`]))});result={run,verification:v};process.exitCode=v.passed&&run.passed?0:1;}
  else if(command==='memory-sync'){const root=resolve(args[0]),store=openStore(root);const bundles=await loadAllBundles(root);const sha=headSha(root);let edges=0;for(const b of bundles){store.node({id:`endpoint:${b.spec.id}`,kind:'endpoint',repo:root,path:`${b.dir}/spec.md`,sha256:b.spec.sha256,anchorSha:sha,data:{method:b.spec.method,path:b.spec.path,adapter:b.spec.adapter}});for(const e of structuralEdges(b,{anchorSha:sha})){store.link(e);edges++;}}
    const hashes=new Map(bundles.flatMap(b=>[[`${b.dir}/spec.md`,b.spec.sha256],...(b.policies?[[`${b.dir}/policies.md`,b.policies.sha256]]:[]),...(b.tests?[[`${b.dir}/tests.md`,b.tests.sha256]]:[])]));
    const stale=store.invalidateStale(p=>hashes.has(p)?hashes.get(p):undefined,{repo:root});result={endpoints:bundles.length,edges,stale,stats:store.stats()};store.close();}
  else if(command==='context'){const taskDir=flag(args,'--task',null),budget=Number(flag(args,'--budget','4000'));const root=resolve(args[0]),store=openStore(root);const r=await compileContext({root,store,endpointId:args[1]==='-'?null:args[1],objective:args[2],budgetTokens:budget,repo:root,anchorSha:headSha(root),taskDir:taskDir?resolve(taskDir):null,taskId:taskDir?resolve(taskDir).split(/[\\/]/).at(-1):null});store.close();if(taskDir)result={paths:r.paths,usedTokens:r.manifest.usedTokens,sections:r.manifest.sections.map(s=>`${s.id}:${s.tokens}`)};else{process.stdout.write(r.markdown);process.exit(0);}}
  else if(command==='select-stack'){const root=resolve(args[0]),store=openStore(root);const intent=JSON.parse(await readFile(args[2],'utf8'));const preferences=store.recall({tiers:['alignment'],query:'framework adapter stack preference',limit:10});result=await selectStack({taskId:args[1],intent,adapterDirs:[join(new URL('../docs/meta-os/adapters/',import.meta.url).pathname),join(osHome,'adapters')],preferences});store.close();}
  else if(command==='delta'){const root=resolve(args[0]),store=openStore(root);result=await appendDelta({root,store,delta:JSON.parse(await readFile(args[1],'utf8'))});store.close();}
  else if(command==='swarm'){const port=flag(args,'--serve',null);const root=resolve(args[0]),taskDir=resolve(args[1]),plan=JSON.parse(await readFile(args[2],'utf8'));const store=openStore(root);
    const bus=new SwarmBus({root,taskDir,osHome,contextCompiler:async u=>u.endpointId?compileContext({root,store,endpointId:u.endpointId,objective:u.brief,repo:root,anchorSha:headSha(root),taskDir,taskId:taskDir.split(/[\\/]/).at(-1)}):null});
    bus.on('event',e=>console.error(`[${e.ts}] ${e.type}${e.unit?` ${e.unit}`:''}${e.passed!==undefined?` passed=${e.passed}`:''}`));
    let server=null;if(port!==null){server=(await bus.serve({port:Number(port)})).server;console.error(`events: http://127.0.0.1:${port}/events`);}
    const r=await bus.dispatch(plan);store.close();server?.close();result={reportPath:r.reportPath,passed:r.report.passed,integrationBranch:r.report.integrationBranch,integrationSha:r.report.integrationSha,units:r.report.units.map(u=>({unit:u.unit,status:u.status}))};process.exitCode=r.report.passed?0:1;}
  else if(command==='consolidate'){const swarm=flag(args,'--swarm',null);const root=resolve(args[0]),store=openStore(root);result=await consolidate({root,store,osHome,repo:root,anchorSha:headSha(root),swarmReportPath:swarm?resolve(swarm):null});store.close();}
  else if(command==='memory-stats'){const store=openStore(resolve(args[0]));result=store.stats();store.close();}
  else{console.log((await readFile(new URL(import.meta.url),'utf8')).split('\n').filter(l=>l.startsWith('//   ')).map(l=>l.slice(5)).join('\n'));process.exit(command?1:0);}
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
