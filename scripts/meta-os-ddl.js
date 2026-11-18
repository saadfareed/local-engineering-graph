import {writeFile} from 'node:fs/promises';
import {DDL} from '../src/memory/store.js';
const target=new URL('../docs/meta-os/schemas/memory.sql',import.meta.url);
await writeFile(target,'-- Generated from src/memory/store.js (DDL constant). Regenerate with: node scripts/meta-os-ddl.js\n'+DDL.trim()+'\n');
console.log('wrote docs/meta-os/schemas/memory.sql');
