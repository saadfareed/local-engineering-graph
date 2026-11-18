import {mkdtemp,mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

export const PACKAGE_ROOT=new URL('../',import.meta.url).pathname;
export const TEMPLATES=join(PACKAGE_ROOT,'docs','meta-os','templates');
/** Temp project with the orders.create example bundle under docs/api. */
export async function scaffoldProject({git=false,extraEndpoints=0}={}){
  const root=await mkdtemp(join(tmpdir(),'meta-os-'));
  const bundle=join(root,'docs','api','orders','create');await mkdir(bundle,{recursive:true});
  for(const f of ['spec.md','policies.md','tests.md'])await cp(join(TEMPLATES,f),join(bundle,f));
  for(let i=0;i<extraEndpoints;i++){
    const dir=join(root,'docs','api','catalog',`item${i}`);await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'spec.md'),`# catalog.item${i} — GET /v1/items/{itemId}\n\n| Field | Value |\n|---|---|\n| id | catalog.item${i} |\n| domain | catalog |\n| method | GET |\n| path | /v1/items/{itemId}/v${i} |\n| summary | Fetch item ${i} |\n| adapter | nestjs |\n\n## Auth & Headers\n\n| Header | Required | Description |\n|---|---|---|\n| Authorization | yes | Bearer |\n\n## Responses\n\n### 200 OK\n\n\`\`\`json schema\n{"type":"object","properties":{"id":{"type":"string"}}}\n\`\`\`\n\n## Scenario Call Graph\n\n| Scenario | Trigger | Calls | Mutations | Status | Response |\n|---|---|---|---|---|---|\n| S1 found | item exists | ItemService.get -> ItemRepository.get | none | 200 | Item |\n`);
    await writeFile(join(dir,'tests.md'),`# Tests — catalog.item${i}\n\n## T1 returns the item (S1)\n\n- Given: item exists\n- When: GET\n- Then: 200\n\n\`\`\`json assert\n{"request":{"path":{"itemId":"i-1"}},"status":200}\n\`\`\`\n`);
  }
  if(git){
    const run=args=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});if(r.status!==0)throw Error(`git ${args.join(' ')}: ${r.stderr}`);return r.stdout;};
    run(['init','-q','-b','main']);run(['-c','user.name=test','-c','user.email=test@example.com','add','-A']);
    run(['-c','user.name=test','-c','user.email=test@example.com','commit','-q','-m','init']);
  }
  return root;
}
export async function cleanup(root){await rm(root,{recursive:true,force:true});}
/** A worker script that writes <unit>.txt, or fails for unit "bad". */
export async function fakeWorker(dir){
  const path=join(dir,'fake-worker.mjs');
  await writeFile(path,`import {writeFileSync} from 'node:fs';\nconst unit=process.env.ENGINEERING_OS_UNIT;\nif(unit==='bad')process.exit(3);\nif(unit==='idle')process.exit(0);\nwriteFileSync(unit+'.txt','built '+unit+'\\n');\nconsole.log('done',unit);\n`);
  return path;
}
