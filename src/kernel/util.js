// Shared kernel helpers: canonical JSON, hashing, token estimation and tokenization. Kept free of
// node:sqlite so modules that never touch memory (the bus, the exporter) do not load it.
import {createHash} from 'node:crypto';
export const STOP_WORDS=new Set('a an and are as at be by for from has have if in into is it its of on or that the this to was were will with when then given should must not'.split(' '));
/** Canonical JSON (sorted keys, no whitespace) so hashes and signatures are reproducible. */
export function canonical(value){
  if(value===undefined)return 'null';
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const sha256=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonical(value)).digest('hex');
export const estimateTokens=text=>Math.ceil(Buffer.byteLength(String(text),'utf8')/4);
export function tokenize(text){
  const counts=new Map();
  for(const raw of String(text).toLowerCase().split(/[^a-z0-9_./-]+/)){
    const term=raw.replace(/^[./-]+|[./-]+$/g,'');
    if(term.length<2||STOP_WORDS.has(term))continue;
    counts.set(term,(counts.get(term)??0)+1);
    for(const part of term.split(/[._/-]/))if(part.length>=3&&part!==term&&!STOP_WORDS.has(part))counts.set(part,(counts.get(part)??0)+1);
  }
  return counts;
}
export const nowIso=()=>new Date().toISOString();
