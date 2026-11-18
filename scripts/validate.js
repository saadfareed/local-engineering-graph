import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateGraph } from '../src/graph.js';
import { checkPackage } from '../src/package-check.js';
for (const name of (await readdir(new URL('../graphs/', import.meta.url))).filter(name => name.endsWith('.json')).sort()) {
  validateGraph(JSON.parse(await readFile(new URL(`../graphs/${name}`, import.meta.url), 'utf8')));
  console.log(`Validated ${name}`);
}
const result = await checkPackage(fileURLToPath(new URL('../', import.meta.url)));
console.log(`Validated packaging for Claude Code and Codex: ${result.name}@${result.version}, ${result.skills.length} skill(s), ${result.agents.length} agent(s)`);
