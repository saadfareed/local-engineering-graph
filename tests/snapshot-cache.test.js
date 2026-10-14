import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,chmod,lstat,readlink,readFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {projectSnapshot,__snapshotCacheStats} from '../src/state.js';

const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');

// Independently recompute the expected snapshot the same way src/state.js projectSnapshot does:
// sorted readdir, identical exclusions, identical object shape and key order for the v2 digest.
async function expected(root,version) {
  const result=Object.create(null);
  const excluded=new Set(['.git','.engineering','node_modules','.product-map.lock','.product-map.recover']);
  const metadataAndDependencies=new Set(['.git','node_modules']);
  const {readdir}=await import('node:fs/promises');
  async function walk(directory) {
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const skip=version===1?excluded.has(entry.name):metadataAndDependencies.has(entry.name)||(directory===root&&excluded.has(entry.name));
      if(skip)continue;
      const full=join(directory,entry.name),path=relative(root,full);
      if(entry.isDirectory()){
        if(version===2)result[path]=digest({type:'directory',mode:(await lstat(full)).mode&0o7777});
        await walk(full);
      } else if(entry.isFile()||entry.isSymbolicLink()){
        const st=await lstat(full),content=digest(await readFile(full));
        result[path]=version===1?content:digest({type:entry.isSymbolicLink()?'symlink':'file',mode:st.mode&0o7777,...(entry.isSymbolicLink()?{target:await readlink(full)}:{}),content});
      }
    }
  }
  await walk(root);return result;
}

async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),'snapshot-cache-'));
  try {
    await mkdir(join(root,'src'),{recursive:true});
    await mkdir(join(root,'src','nested'),{recursive:true});
    await writeFile(join(root,'README.md'),'readme contents');
    await writeFile(join(root,'src','index.js'),'export const a=1;\n');
    await chmod(join(root,'src','index.js'),0o644);
    await writeFile(join(root,'src','run.sh'),'#!/bin/sh\necho hi\n');
    await chmod(join(root,'src','run.sh'),0o755);
    await writeFile(join(root,'src','nested','deep.txt'),'deep file');
    await symlink('index.js',join(root,'src','link.js'));
    // excluded content must be ignored by both versions
    await mkdir(join(root,'node_modules','pkg'),{recursive:true});
    await writeFile(join(root,'node_modules','pkg','ignored.js'),'ignored');
    await fn(root);
  } finally {await rm(root,{recursive:true,force:true});}
}

test('hash equivalence for versions 1 and 2 locks the snapshot format',()=>fixture(async root=>{
  assert.deepEqual(await projectSnapshot(root,1),await expected(root,1));
  assert.deepEqual(await projectSnapshot(root,2),await expected(root,2));
}));

test('unchanged files are served from cache; changed files are re-hashed with correct values',()=>fixture(async root=>{
  await projectSnapshot(root,2); // prime the cache
  __snapshotCacheStats.hashes=0;__snapshotCacheStats.hits=0;
  await projectSnapshot(root,2); // identical tree: regular files hit; the one symlink always re-reads
  assert.equal(__snapshotCacheStats.hashes,1,'only the symlink is re-hashed when regular files are unchanged');
  assert.equal(__snapshotCacheStats.hits,4,'all four unchanged regular files should be served from the cache');

  // (i) content AND size change on index.js
  await writeFile(join(root,'src','index.js'),'export const a=1;export const b=2;\n');
  // (ii) same-size content change with a bumped mtime on deep.txt (both are 9 bytes)
  await writeFile(join(root,'src','nested','deep.txt'),'DEEP file');
  const future=new Date(Date.now()+10000);
  await utimes(join(root,'src','nested','deep.txt'),future,future);

  __snapshotCacheStats.hashes=0;__snapshotCacheStats.hits=0;
  const snap=await projectSnapshot(root,1);
  assert.equal(__snapshotCacheStats.hashes,3,'both modified files plus the always-reread symlink are re-hashed');
  assert.equal(__snapshotCacheStats.hits,2,'the two unchanged regular files are served from the cache');
  assert.equal(snap[join('src','index.js')],digest('export const a=1;export const b=2;\n'));
  assert.equal(snap[join('src','nested','deep.txt')],digest('DEEP file'));
}));

test('a modified file produces a new hash that differs from the old and matches recomputation',()=>fixture(async root=>{
  const before=await projectSnapshot(root,1);
  const path=join('src','index.js');
  const oldHash=before[path];
  await writeFile(join(root,'src','index.js'),'export const changed=true;\n');
  const after=await projectSnapshot(root,1);
  assert.notEqual(after[path],oldHash);
  assert.equal(after[path],digest('export const changed=true;\n'));
  assert.deepEqual(after,await expected(root,1));
}));

test('codeHashes out-param is populated with path->contentHash for every file and symlink',()=>fixture(async root=>{
  const codeHashes=new Map();
  const v1=await projectSnapshot(root,1,codeHashes); // v1 result value IS the content hash
  for(const [path,hash] of codeHashes) assert.equal(hash,v1[path],`codeHashes[${path}] must equal the v1 content hash`);
  // directories appear in v2 but never in codeHashes
  assert.ok(codeHashes.has(join('src','index.js')));
  assert.ok(codeHashes.has(join('src','link.js')));
  assert.ok(!codeHashes.has('src'));
}));
