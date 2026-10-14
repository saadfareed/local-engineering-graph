import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,access,readdir} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {initProduct,addFeature,syncProduct,checkProduct,loadProduct,recoverProduct} from '../src/product.js';

const helper=new URL('./concurrency-helper.mjs',import.meta.url).pathname;

// Build an RW-enabled product map (concurrency:"rw") with one registered feature.
async function rwFixture(fn){
  const root=await mkdtemp(join(tmpdir(),'concurrency-rw-'));
  try{
    await initProduct(root,'Concurrency fixture');
    await enableRW(root);
    await addFeature(root,'alpha','Alpha');
    await syncProduct(root);
    await fn(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
async function legacyFixture(fn){
  const root=await mkdtemp(join(tmpdir(),'concurrency-legacy-'));
  try{
    await initProduct(root,'Legacy fixture');
    await addFeature(root,'alpha','Alpha');
    await syncProduct(root);
    await fn(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
async function enableRW(root){const p=JSON.parse(await readFile(join(root,'PRODUCT.json')));p.concurrency='rw';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(p,null,2)+'\n');await syncProduct(root);}
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
async function waitFor(path,deadline=20000){const start=Date.now();while(!await exists(path)){if(Date.now()-start>deadline)throw Error('barrier timeout: '+path);await new Promise(r=>setTimeout(r,15));}}
// Negative sentinel: assert `promise` is STILL pending after `ms`. Races the promise
// against a bounded timer and asserts the timer wins. Sound as a happens-before probe
// only inside a window a filesystem barrier guarantees the contended lock is held — it
// proves non-completion without comparing two independently-captured wall-clock stamps.
const PENDING=Symbol('pending');
async function assertStillPending(promise,ms,message){
  const result=await Promise.race([promise.then(()=>'resolved',()=>'rejected'),new Promise(r=>setTimeout(()=>r(PENDING),ms))]);
  assert.equal(result,PENDING,message);
}
// Writers fail fast with "Product map is locked" / "active readers" when another writer
// holds the exclusive lock. In the real system a caller retries; mirror that here so the
// test exercises genuine contention and asserts the map stays consistent (no corruption).
async function writeWithRetry(fn,deadline=20000){
  const start=Date.now();
  for(;;){
    try{return await fn();}
    catch(e){if(!/is locked|active readers/.test(e.message)||Date.now()-start>deadline)throw e;await new Promise(r=>setTimeout(r,20));}
  }
}
function run(mode,root,signalFile,releaseFile,arg){
  const child=spawn(process.execPath,[helper,mode,root,signalFile||'',releaseFile||'',arg||'']);
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  const done=once(child,'exit').then(([code])=>({code,stderr}));
  return {child,done};
}

// Scenario 1 — reader/reader: two concurrent reads succeed, no EEXIST, registry non-empty mid-read.
test('rw reader/reader concurrency: both reads succeed and a reader file exists mid-read',()=>rwFixture(async root=>{
  const signalFile=join(root,'sig-'+randomUUID()),releaseFile=join(root,'rel-'+randomUUID());
  const held=run('hold-reader',root,signalFile,releaseFile);
  await waitFor(signalFile);
  // A reader file must be present while the child holds its registration.
  const dir=join(root,'.product-map.readers');
  assert.ok((await readdir(dir)).length>=1,'reader registry should contain the held reader');
  // Concurrent in-process reads succeed with no EEXIST while the child reader is active.
  const [a,b]=await Promise.all([checkProduct(root),loadProduct(root)]);
  assert.equal(a.valid,true);assert.equal(b.product.name,'Concurrency fixture');
  await writeFile(releaseFile,'1');
  const {code,stderr}=await held.done;assert.equal(code,0,stderr);
}));

// Scenario 6 — flag OFF: legacy map never creates .product-map.readers/.
test('legacy map never creates a reader registry and reads/writes behave as before',()=>legacyFixture(async root=>{
  await checkProduct(root);await loadProduct(root);
  await addFeature(root,'beta','Beta');await syncProduct(root);await checkProduct(root);
  await assert.rejects(access(join(root,'.product-map.readers')),/ENOENT/);
}));

// Scenario 6b — invalid concurrency value is rejected by loadProduct.
test('loadProduct rejects an invalid concurrency mode and accepts rw',()=>legacyFixture(async root=>{
  const p=JSON.parse(await readFile(join(root,'PRODUCT.json')));p.concurrency='parallel';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(p,null,2)+'\n');
  await assert.rejects(loadProduct(root),/Invalid product concurrency mode/);
  p.concurrency='rw';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(p,null,2)+'\n');
  await loadProduct(root);
}));

// Scenario 2a — in-flight reader makes a concurrent writer wait, then the writer succeeds.
test('rw in-flight reader blocks a writer until the reader releases',()=>rwFixture(async root=>{
  const signalFile=join(root,'sig-'+randomUUID()),releaseFile=join(root,'rel-'+randomUUID());
  const held=run('hold-reader',root,signalFile,releaseFile);
  await waitFor(signalFile);
  // The writer must not COMPLETE while a live reader is registered. The child holds its
  // reader file until we write releaseFile, so for the whole window before release the
  // writer provably cannot acquire the exclusive lock — hence cannot complete. Prove that
  // directly with a negative sentinel rather than comparing two wall-clock stamps.
  const writer=writeWithRetry(()=>addFeature(root,'gamma','Gamma'));
  await assertStillPending(writer,200,'writer must stay blocked while a live reader is registered');
  await writeFile(releaseFile,'1');
  const {code,stderr}=await held.done;assert.equal(code,0,stderr);
  await writer;
  const model=await loadProduct(root);
  assert.ok(model.features.has('gamma'));
  await checkProduct(root);
}));

// Scenario 2b — in-flight writer blocks a new reader until the writer finishes.
test('rw in-flight writer blocks a new reader until the writer finishes',()=>rwFixture(async root=>{
  const signalFile=join(root,'sig-'+randomUUID()),releaseFile=join(root,'rel-'+randomUUID());
  const held=run('hold-writer',root,signalFile,releaseFile,'delta');
  await waitFor(signalFile);
  // The writer child holds .product-map.lock until we write releaseFile, so a new reader
  // cannot register (its brief lock acquire gets EEXIST and retries) until after release.
  // Observe pending-ness STRICTLY BEFORE writing releaseFile: during this window the lock
  // is provably held, so the reader provably cannot complete — and the helper's post-release
  // addFeature has not started, so the reader is contending only with the held lock. A
  // negative sentinel proves blocking without comparing two independently-captured stamps.
  const read=writeWithRetry(()=>checkProduct(root));
  await assertStillPending(read,200,'reader must stay blocked while the writer holds the exclusive lock');
  await writeFile(releaseFile,'1');
  const {code,stderr}=await held.done;assert.equal(code,0,stderr);
  await read;
  const model=await loadProduct(root);assert.ok(model.features.has('delta'));
}));

// Scenario 3 — writer/writer: disjoint and same-feature mutations serialize with no corruption.
test('rw concurrent writers on disjoint features serialize and keep the map consistent',()=>rwFixture(async root=>{
  await Promise.all([writeWithRetry(()=>addFeature(root,'one','One')),writeWithRetry(()=>addFeature(root,'two','Two'))]);
  await syncProduct(root);
  const model=await loadProduct(root);
  assert.ok(model.features.has('one')&&model.features.has('two'));
  await checkProduct(root);
}));
test('rw concurrent writers on the same feature serialize: one wins, one is rejected',()=>rwFixture(async root=>{
  // Both retry past lock contention; exactly one registers the feature, the other sees
  // "already registered" once it finally acquires the lock.
  const results=await Promise.allSettled([writeWithRetry(()=>addFeature(root,'dup','Dup')),writeWithRetry(()=>addFeature(root,'dup','Dup'))]);
  const ok=results.filter(r=>r.status==='fulfilled').length;
  const dupe=results.filter(r=>r.status==='rejected'&&/already registered/.test(r.reason.message)).length;
  assert.equal(ok,1);assert.equal(dupe,1);
  await syncProduct(root);await checkProduct(root);
}));

// Scenario 4 — journal rollback under RW leaves the map consistent.
test('rw induced mutation failure rolls back registry and indexes and releases the lock',()=>rwFixture(async root=>{
  const product=JSON.parse(await readFile(join(root,'PRODUCT.json')));product.documents.features='missing/FEATURES.md';await writeFile(join(root,'PRODUCT.json'),JSON.stringify(product));
  const before=await readFile(join(root,'PRODUCT.json')),index=await readFile(join(root,'PRODUCT.md'));
  await assert.rejects(addFeature(root,'booking','Booking'),/ENOENT/);
  assert.deepEqual(await readFile(join(root,'PRODUCT.json')),before);
  assert.deepEqual(await readFile(join(root,'PRODUCT.md')),index);
  await assert.rejects(access(join(root,'features/booking')),/ENOENT/);
  await assert.rejects(access(join(root,'.product-map.lock')),/ENOENT/);
}));

// Scenario 5 — recovery under concurrency.
test('rw recovery reaps a dead reader file',()=>rwFixture(async root=>{
  const dir=join(root,'.product-map.readers');await mkdir(dir,{recursive:true});
  const child=spawn(process.execPath,['-e','']);await once(child,'exit');
  const file=join(dir,randomUUID());
  await writeFile(file,JSON.stringify({pid:child.pid,host:hostname(),acquiredAt:new Date().toISOString()}));
  const result=await recoverProduct(root);
  assert.deepEqual(result.refusedReaders,[]);
  await assert.rejects(access(file),/ENOENT/);
}));
test('rw recovery refuses a live reader and a foreign-host reader',()=>rwFixture(async root=>{
  const dir=join(root,'.product-map.readers');await mkdir(dir,{recursive:true});
  const live=join(dir,randomUUID()),foreign=join(dir,randomUUID());
  await writeFile(live,JSON.stringify({pid:process.pid,host:hostname(),acquiredAt:new Date().toISOString()}));
  await writeFile(foreign,JSON.stringify({pid:999999,host:hostname()+'-other',acquiredAt:new Date().toISOString()}));
  await assert.rejects(recoverProduct(root),/Cannot establish local reader ownership/);
  // Neither live nor foreign reader files are removed.
  await access(live);await access(foreign);
}));
test('rw recovery restores a dead writer journal while a live reader is present',()=>rwFixture(async root=>{
  const path=join(root,'PRODUCT.json'),original=await readFile(path);
  const dir=join(root,'.product-map.readers');await mkdir(dir,{recursive:true});
  const liveReader=join(dir,randomUUID());
  await writeFile(liveReader,JSON.stringify({pid:process.pid,host:hostname(),acquiredAt:new Date().toISOString()}));
  const child=spawn(process.execPath,['-e','']);await once(child,'exit');
  await writeFile(join(root,'.product-map.lock'),JSON.stringify({pid:child.pid,host:hostname()}));
  await writeFile(join(root,'.product-map.journal'),JSON.stringify([{path,previous:original.toString('base64'),directory:false}]));
  await writeFile(path,'interrupted');
  const recovered=await recoverProduct(root);
  assert.equal(recovered.recovered,true);await access(recovered.backup);
  assert.deepEqual(await readFile(path),original);
  await assert.rejects(access(join(root,'.product-map.lock')),/ENOENT/);
  // The live reader file is left intact (reported, not reaped).
  await access(liveReader);
  assert.deepEqual(recovered.reapedReaders,[]);
}));

// Scenario 7 — TOCTOU / stress: interleaved readers and writers, no spurious staleness.
test('rw stress: interleaved readers and writers never observe a spurious stale map',()=>rwFixture(async root=>{
  const errors=[];
  const tasks=[];
  for(let i=0;i<8;i++){
    const id='feat'+i;
    tasks.push(writeWithRetry(()=>addFeature(root,id,id)).then(()=>writeWithRetry(()=>syncProduct(root))).catch(e=>errors.push('writer '+id+': '+e.message)));
    // Interleave reads against the stream of writers; a reader may legitimately retry on
    // lock contention but must never observe a spurious stale map.
    tasks.push(writeWithRetry(()=>checkProduct(root)).catch(e=>{if(/stale/.test(e.message))errors.push('reader stale: '+e.message);}));
  }
  await Promise.all(tasks);
  assert.deepEqual(errors,[]);
  await syncProduct(root);
  const model=await loadProduct(root);
  assert.equal(model.features.size,9);
  await checkProduct(root);
}));
