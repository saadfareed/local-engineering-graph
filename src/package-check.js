// Packaging consistency for the two supported hosts (Claude Code and Codex). Run by
// scripts/validate.js and tests/packaging.test.js. Checks shape and agreement only; the hosts'
// own validators (for example `claude plugin validate .`) remain the authority on load behaviour.
import {readFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';

const json=async (root,path)=>JSON.parse(await readFile(join(root,path),'utf8'));
async function exists(path){try{await stat(path);return true;}catch{return false;}}
/** Minimal frontmatter reader for `key: value` lines; a value is a JSON string or plain text without ": ". */
export function frontmatter(text,file){
  const m=/^---\n([\s\S]*?)\n---\n/.exec(text);
  if(!m)throw Error(`${file}: missing frontmatter`);
  const out={};
  for(const line of m[1].split('\n')){
    if(!line.trim())continue;
    const kv=/^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if(!kv)throw Error(`${file}: unsupported frontmatter line: ${line}`);
    let value=kv[2];
    if(value.startsWith('"')){try{value=JSON.parse(value);}catch{throw Error(`${file}: invalid quoted value for ${kv[1]}`);}}
    else if(/:\s/.test(value))throw Error(`${file}: value of ${kv[1]} contains ": "; quote it`);
    out[kv[1]]=value;
  }
  return out;
}
export async function checkPackage(root){
  const pkg=await json(root,'package.json'),claude=await json(root,'.claude-plugin/plugin.json'),codex=await json(root,'.codex-plugin/plugin.json'),market=await json(root,'.claude-plugin/marketplace.json');
  const errors=[];
  for(const [label,m] of [['Claude manifest',claude],['Codex manifest',codex]]){
    if(m.name!==pkg.name)errors.push(`${label} name ${m.name} differs from package.json ${pkg.name}`);
    if(m.version!==pkg.version)errors.push(`${label} version ${m.version} differs from package.json ${pkg.version}`);
    if(typeof m.description!=='string'||!m.description)errors.push(`${label} needs a description`);
  }
  if(claude.description!==codex.description)errors.push('Claude and Codex manifest descriptions differ');
  for(const key of ['agents','commands','skills'])if(key in claude)errors.push(`Claude manifest must not set "${key}"; the default directories are the shared layout`);
  if(!/^\.\/./.test(codex.skills??'')||!(await exists(join(root,codex.skills))))errors.push('Codex manifest skills path must be ./-prefixed and exist');
  const entry=(market.plugins??[]).find(p=>p.name===pkg.name);
  if(!entry)errors.push('marketplace.json has no entry for the package');
  else{if(entry.source!=='./')errors.push('marketplace entry source must be "./"');if('version' in entry)errors.push('marketplace entry must not set version; plugin.json owns it');}
  if(await exists(join(root,'CLAUDE.md')))errors.push('CLAUDE.md at the plugin root is not loaded by Claude Code; put instructions in the skill');
  const skills=[];
  for(const dir of (await readdir(join(root,'skills'),{withFileTypes:true})).filter(d=>d.isDirectory())){
    const file=join('skills',dir.name,'SKILL.md');
    try{const fm=frontmatter(await readFile(join(root,file),'utf8'),file);if(fm.name!==dir.name)errors.push(`${file}: name must equal directory ${dir.name}`);if(!fm.description)errors.push(`${file}: missing description`);skills.push(fm.name);}
    catch(e){errors.push(e.message);}
  }
  const agents=[];
  for(const name of (await readdir(join(root,'agents'))).filter(f=>f.endsWith('.md')).sort()){
    const file=join('agents',name);
    try{const fm=frontmatter(await readFile(join(root,file),'utf8'),file);if(fm.name!==name.slice(0,-3))errors.push(`${file}: name must equal the file name`);if(!fm.description)errors.push(`${file}: missing description`);agents.push(fm.name);}
    catch(e){errors.push(e.message);}
  }
  const roles=new Set();
  for(const g of (await readdir(join(root,'graphs'))).filter(f=>f.endsWith('.json')))for(const n of Object.values((await json(root,join('graphs',g))).nodes))if(n.role&&n.role!=='user')roles.add(n.role);
  for(const role of [...roles].sort())if(!agents.includes(role))errors.push(`graph role ${role} has no agents/${role}.md`);
  if(errors.length)throw Error(`Package check failed:\n  ${errors.join('\n  ')}`);
  return {name:pkg.name,version:pkg.version,skills,agents,roles:[...roles].sort()};
}
