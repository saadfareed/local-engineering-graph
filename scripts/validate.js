import { readdir, readFile } from 'node:fs/promises';
import { validateGraph } from '../src/graph.js';
for (const name of (await readdir(new URL('../graphs/', import.meta.url))).filter(name => name.endsWith('.json')).sort()) {
  validateGraph(JSON.parse(await readFile(new URL(`../graphs/${name}`, import.meta.url), 'utf8')));
  console.log(`Validated ${name}`);
}
