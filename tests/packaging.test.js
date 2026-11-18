import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkPackage,frontmatter} from '../src/package-check.js';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
async function copyPackage(){
  const dir=await mkdtemp(join(tmpdir(),'pkg-'));
  for(const p of ['package.json','.claude-plugin','.codex-plugin','skills','agents','graphs'])await cp(join(ROOT,p),join(dir,p),{recursive:true});
  return dir;
}
test('the package is consistent for both Claude Code and Codex',async()=>{
  const r=await checkPackage(ROOT);
  assert.deepEqual(r.skills,['engineering-workflow']);
  for(const role of r.roles)assert.ok(r.agents.includes(role),role);
  const claude=JSON.parse(await readFile(join(ROOT,'.claude-plugin','plugin.json'),'utf8'));
  const codex=JSON.parse(await readFile(join(ROOT,'.codex-plugin','plugin.json'),'utf8'));
  assert.equal(claude.version,codex.version);
});
test('frontmatter reader rejects unquoted colons and missing blocks',()=>{
  assert.deepEqual(frontmatter('---\nname: a\ndescription: "x: y"\n---\nbody','f'),{name:'a',description:'x: y'});
  assert.throws(()=>frontmatter('---\nname: a\ndescription: x: y\n---\n','f'),/quote it/);
  assert.throws(()=>frontmatter('# no frontmatter\n','f'),/missing frontmatter/);
});
test('drift between the manifests is reported',async()=>{
  const dir=await copyPackage();
  try{
    const path=join(dir,'.codex-plugin','plugin.json');
    await writeFile(path,JSON.stringify({...JSON.parse(await readFile(path,'utf8')),version:'0.0.1'}));
    await writeFile(join(dir,'agents','worker.md'),'# worker\n');
    await writeFile(join(dir,'CLAUDE.md'),'x');
    await assert.rejects(checkPackage(dir),e=>/Codex manifest version 0\.0\.1/.test(e.message)&&/agents\/worker\.md: missing frontmatter/.test(e.message)&&/graph role worker has no/.test(e.message)&&/CLAUDE\.md/.test(e.message));
  }finally{await rm(dir,{recursive:true,force:true});}
});
