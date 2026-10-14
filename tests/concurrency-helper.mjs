// Child-process helper for cross-process concurrency tests.
// Usage: node concurrency-helper.mjs <mode> <root> <signalFile> <releaseFile> [arg]
// Modes:
//   hold-reader  : register a reader (checkProduct) and keep it active until releaseFile appears
//   hold-writer  : start a writer (addFeature) that pauses mid-mutation until releaseFile appears
//   read         : run a single checkProduct and exit 0 on success
//   add-feature  : run a single addFeature(arg) and exit 0 on success
// Coordination is via filesystem signals: the child creates signalFile once it has
// acquired its lock/registration, and waits (polling, bounded) for releaseFile before
// finishing. Deterministic: no fixed sleeps standing in for synchronization.
import {writeFile,access,mkdir,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {checkProduct,addFeature,loadProduct} from '../src/product.js';
const [mode,root,signalFile,releaseFile,arg]=process.argv.slice(2);
const DEADLINE_MS=20000,POLL_MS=15;
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
async function waitFor(path){const start=Date.now();while(!await exists(path)){if(Date.now()-start>DEADLINE_MS)throw Error('child barrier timeout: '+path);await new Promise(r=>setTimeout(r,POLL_MS));}}
async function signal(path){await writeFile(path,'1');}
try{
  if(mode==='read'){await checkProduct(root);process.exit(0);}
  if(mode==='add-feature'){await addFeature(root,arg,arg);process.exit(0);}
  if(mode==='hold-reader'){
    // Register a reader by holding checkProduct open across a barrier. We implement the
    // reader protocol inline so we can pause while a reader file exists on disk: briefly
    // take the write lock, create our own reader file, release the lock, signal, wait, unlink.
    const lock=join(root,'.product-map.lock'),dir=join(root,'.product-map.readers');
    await mkdir(dir,{recursive:true});
    const {open}=await import('node:fs/promises');
    const {randomUUID}=await import('node:crypto');
    const {hostname}=await import('node:os');
    const file=join(dir,randomUUID());
    let handle;for(let i=0;;i++){try{handle=await open(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;if(i>500)throw Error('reader could not take lock');await new Promise(r=>setTimeout(r,POLL_MS));}}
    try{const own=await open(file,'wx');try{await own.writeFile(JSON.stringify({pid:process.pid,host:hostname(),acquiredAt:new Date().toISOString()}));await own.sync();}finally{await own.close();}}
    finally{await handle.close();await unlink(lock).catch(()=>{});}
    await signal(signalFile);
    await waitFor(releaseFile);
    await unlink(file).catch(()=>{});
    process.exit(0);
  }
  if(mode==='hold-writer'){
    // A writer that holds the exclusive lock across a barrier. We call addFeature but the
    // feature title triggers nothing special; to pause mid-write we instead take the lock
    // directly, signal, wait for release, then complete a real mutation and drop the lock.
    const lock=join(root,'.product-map.lock');
    const {open}=await import('node:fs/promises');
    const {hostname}=await import('node:os');
    const handle=await open(lock,'wx');
    try{
      await handle.writeFile(JSON.stringify({pid:process.pid,host:hostname(),time:new Date().toISOString()}));await handle.sync();
      await signal(signalFile);
      await waitFor(releaseFile);
    }finally{await handle.close();await unlink(lock).catch(()=>{});}
    // After releasing, perform a genuine mutation so the map ends consistent. The test's
    // reader may still be contending for the lock at this moment (it retries), so this
    // mutation must retry on lock contention too — mirroring a real caller — rather than
    // failing fast and exiting non-zero.
    const start=Date.now();
    for(;;){
      try{await addFeature(root,arg,arg);break;}
      catch(e){if(!/is locked|active readers/.test(e.message)||Date.now()-start>DEADLINE_MS)throw e;await new Promise(r=>setTimeout(r,POLL_MS));}
    }
    process.exit(0);
  }
  throw Error('unknown mode: '+mode);
}catch(e){console.error(e&&e.message||e);process.exit(1);}
