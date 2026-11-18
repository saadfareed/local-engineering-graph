// Active Process & Swarm Orchestration Bus.
//
// Upgrades the passive Local Engineering Graph runner into an event-driven dispatcher: for every
// independent unit (a DAG node or an API endpoint) it creates an isolated git worktree on its own
// branch, spawns a Claude Code worker subprocess inside it, runs deterministic verifiers (test
// runners, AST/call-graph checkers, Apidog CLI), hashes and Ed25519-signs the evidence, and only
// merges the unit's branch into the integration branch when every verifier passed. Every step is
// appended to .engineering/events.jsonl and emitted on the bus for the generative UI (SSE).
//
// Trust boundary (same as docs/architecture.md): local files are trusted input. Signatures prove
// that a record was produced by a holder of the local evidence key and has not been edited since;
// they do not prove the worker's claims. Verifier exit codes and logs are the symbolic proof.
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,appendFile,access,chmod,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {homedir} from 'node:os';
import {generateKeyPairSync,sign as edSign,verify as edVerify,createPrivateKey,createPublicKey,createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {canonical,sha256,nowIso} from '../kernel/util.js';

const ENV_KEYS=['PATH','HOME','TMPDIR','TEMP','LANG','LC_ALL','TERM','SYSTEMROOT','COMSPEC','PATHEXT','USER','LOGNAME','XDG_CONFIG_HOME','XDG_DATA_HOME'];
const MAX_PREVIEW=64*1024,MAX_LOG_BYTES=100*1024*1024,DEFAULT_TIMEOUT=30*60*1000;
export const DEFAULT_WORKER_ARGV=['claude','--print','--permission-mode','acceptEdits','--output-format','json','{briefText}'];
function killGroup(child){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
async function exists(p){try{await access(p);return true;}catch{return false;}}
async function fileSha(p){return createHash('sha256').update(await readFile(p)).digest('hex');}

/** Spawn argv (no shell) with bounded, hashed logs. Resolves with exit metadata; never rejects on a nonzero exit. */
export async function runProcess(argv,{cwd,env={},timeoutMs=DEFAULT_TIMEOUT,logPrefix=null,stdin=null}={}){
  if(!Array.isArray(argv)||!argv.length||argv.some(a=>typeof a!=='string'||!a.length||a.includes('\0')))throw Error('argv must be a nonempty array of strings');
  const startedAt=nowIso(),t0=process.hrtime.bigint();
  const base=Object.fromEntries(ENV_KEYS.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
  const logs=logPrefix?{stdout:createWriteStream(`${logPrefix}.stdout`,{flags:'w'}),stderr:createWriteStream(`${logPrefix}.stderr`,{flags:'w'})}:null;
  return new Promise((done,fail)=>{
    let child;
    try{child=spawn(argv[0],argv.slice(1),{cwd,env:{...base,...env},shell:false,detached:process.platform!=='win32',stdio:[stdin===null?'ignore':'pipe','pipe','pipe']});}
    catch(e){logs?.stdout.destroy();logs?.stderr.destroy();return fail(e);}
    let stdout='',stderr='',bytes=0,timedOut=false,overflow=false;
    const collect=(kind,chunk)=>{bytes+=chunk.length;if(bytes>MAX_LOG_BYTES&&!overflow){overflow=true;killGroup(child);}
      logs?.[kind].write(chunk);const cur=kind==='stdout'?stdout:stderr;if(cur.length<MAX_PREVIEW){const next=cur+chunk.toString('utf8').slice(0,MAX_PREVIEW-cur.length);if(kind==='stdout')stdout=next;else stderr=next;}};
    child.stdout.on('data',c=>collect('stdout',c));child.stderr.on('data',c=>collect('stderr',c));
    const timer=setTimeout(()=>{timedOut=true;killGroup(child);},timeoutMs);
    child.once('error',e=>{clearTimeout(timer);logs?.stdout.destroy();logs?.stderr.destroy();fail(e);});
    child.once('close',async(code,signal)=>{
      clearTimeout(timer);
      const finish=async()=>{
        const durationMs=Number((process.hrtime.bigint()-t0)/1000000n);
        const result={argv,cwd,exitCode:code,signal,timedOut,outputLimitExceeded:overflow,startedAt,finishedAt:nowIso(),durationMs,stdoutPreview:stdout,stderrPreview:stderr};
        if(logs){result.stdoutPath=`${logPrefix}.stdout`;result.stderrPath=`${logPrefix}.stderr`;result.stdoutSha256=await fileSha(result.stdoutPath);result.stderrSha256=await fileSha(result.stderrPath);}
        done(result);
      };
      if(!logs)return finish();
      let pending=2;const closeOne=()=>{if(--pending===0)finish().catch(fail);};
      logs.stdout.end(closeOne);logs.stderr.end(closeOne);
    });
    if(stdin!==null){child.stdin.end(stdin);}
  });
}

// ---- evidence signing --------------------------------------------------------------------------
export async function ensureKeys(osHome){
  const dir=join(osHome,'keys'),priv=join(dir,'evidence.key'),pub=join(dir,'evidence.pub');
  if(!(await exists(priv))){
    await mkdir(dir,{recursive:true,mode:0o700});
    const pair=generateKeyPairSync('ed25519');
    await writeFile(priv,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    await writeFile(pub,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o644});
    await chmod(priv,0o600);
  }
  const privateKey=createPrivateKey(await readFile(priv,'utf8')),publicKey=createPublicKey(privateKey);
  const publicPem=publicKey.export({type:'spki',format:'pem'});
  return {privateKey,publicKey,publicPem,fingerprint:sha256(publicPem).slice(0,16),paths:{priv,pub}};
}
export function signRecord(record,keys){
  const payload=canonical(record),hash=sha256(payload);
  return {record,sha256:hash,algorithm:'ed25519',publicKeyFingerprint:keys.fingerprint,signature:edSign(null,Buffer.from(payload),keys.privateKey).toString('base64'),signedAt:nowIso()};
}
export function verifySigned(signed,publicPem){
  if(!signed||typeof signed!=='object'||!signed.record)return {ok:false,reason:'malformed'};
  const payload=canonical(signed.record);
  if(sha256(payload)!==signed.sha256)return {ok:false,reason:'hash mismatch'};
  const publicKey=createPublicKey(publicPem);
  if(sha256(publicPem).slice(0,16)!==signed.publicKeyFingerprint)return {ok:false,reason:'key fingerprint mismatch'};
  const ok=edVerify(null,Buffer.from(payload),publicKey,Buffer.from(signed.signature,'base64'));
  return {ok,reason:ok?null:'bad signature'};
}
export async function verifyEvidenceFile(path,publicPem){return verifySigned(JSON.parse(await readFile(path,'utf8')),publicPem);}

// ---- the bus -----------------------------------------------------------------------------------
export class SwarmBus extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.root project root (a git repository)
   * @param {string} o.taskDir .engineering/tasks/<id> directory that owns this swarm
   * @param {string} [o.osHome] global OS home (default ~/.engineering-os)
   */
  constructor({root,taskDir,osHome=join(homedir(),'.engineering-os'),git='git',eventLog=null,contextCompiler=null}){
    super();
    this.root=resolve(root);this.taskDir=resolve(taskDir);this.osHome=osHome;this.gitBin=git;this.contextCompiler=contextCompiler;
    this.taskId=this.taskDir.split(/[\\/]/).at(-1);
    this.eventLog=eventLog??join(this.root,'.engineering','events.jsonl');
    this.worktreeRoot=join(this.root,'.engineering','worktrees',this.taskId);
    this.swarmDir=join(this.taskDir,'swarm');
    this.state={taskId:this.taskId,phase:'idle',units:{},integration:null};
    this.history=[];
  }
  async emitEvent(type,data={}){
    const event={id:randomUUID(),ts:nowIso(),taskId:this.taskId,type,...data};
    this.history.push(event);if(this.history.length>500)this.history.shift();
    await mkdir(dirname(this.eventLog),{recursive:true});await appendFile(this.eventLog,canonical(event)+'\n');
    this.emit('event',event);return event;
  }
  async git(args,{cwd=this.root,allowFail=false}={}){
    const r=await runProcess([this.gitBin,...args],{cwd,timeoutMs:10*60*1000});
    if(r.exitCode!==0&&!allowFail)throw Error(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderrPreview.trim()||r.stdoutPreview.trim()}`);
    return r;
  }
  async revParse(ref,cwd=this.root){return (await this.git(['rev-parse','--verify',`${ref}^{commit}`],{cwd})).stdoutPreview.trim();}
  substitute(argv,vars){return argv.map(a=>a.replace(/\{(\w+)\}/g,(m,k)=>k in vars?String(vars[k]):m));}
  /**
   * Dispatch a swarm plan. Returns the signed swarm report.
   * plan = {base?, units:[{id, brief, endpointId?, worker?:{argv,env,timeoutMs}, verifiers:[{id,argv,cwd?,timeoutMs?}], allowEmpty?}],
   *         worker?:{argv,env,envPassthrough,timeoutMs}, verifiers?:[...] (defaults for every unit), integrationVerifiers?:[...],
   *         concurrency?, stopOnFailure?, cleanup?, integrationBranch?}
   */
  async dispatch(plan){
    if(!plan||!Array.isArray(plan.units)||!plan.units.length)throw Error('A swarm plan needs at least one unit');
    const ids=new Set();for(const u of plan.units){if(!u?.id||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(u.id))throw Error(`Invalid unit id: ${u?.id}`);if(ids.has(u.id))throw Error(`Duplicate unit id: ${u.id}`);ids.add(u.id);if(typeof u.brief!=='string'||!u.brief.trim())throw Error(`Unit ${u.id} needs a brief`);}
    const keys=await ensureKeys(this.osHome);
    await mkdir(this.swarmDir,{recursive:true});await mkdir(this.worktreeRoot,{recursive:true});
    const baseSha=await this.revParse(plan.base??'HEAD');
    const startedAt=nowIso();
    this.state={taskId:this.taskId,phase:'dispatching',baseSha,units:Object.fromEntries(plan.units.map(u=>[u.id,{status:'queued'}])),integration:null};
    await this.emitEvent('swarm.started',{baseSha,units:plan.units.map(u=>u.id),concurrency:plan.concurrency??4});
    const results=new Map();
    const queue=[...plan.units];const workers=Array.from({length:Math.max(1,Math.min(plan.concurrency??4,queue.length))},async()=>{
      while(queue.length){const unit=queue.shift();try{results.set(unit.id,await this.runUnit(unit,{plan,baseSha,keys}));}
        catch(error){const failed={unit:unit.id,passed:false,error:error.message};results.set(unit.id,{signed:signRecord({version:1,taskId:this.taskId,unit:unit.id,passed:false,error:error.message,baseSha},keys),evidence:failed});this.state.units[unit.id]={status:'error',error:error.message};await this.emitEvent('unit.error',{unit:unit.id,error:error.message});}}
    });
    await Promise.all(workers);
    // ---- fan-in: merge passing branches in plan order, then run integration verifiers ----------
    this.state.phase='integrating';
    const integrationBranch=plan.integrationBranch??`swarm/${this.taskId}/integration`;
    const integrationDir=join(this.worktreeRoot,'integration');
    await this.git(['worktree','add','-B',integrationBranch,integrationDir,baseSha]);
    const unitSummaries=[];
    for(const unit of plan.units){
      const r=results.get(unit.id);const summary={unit:unit.id,endpointId:unit.endpointId??null,status:r.evidence.passed?'passed':'failed',evidenceSha256:r.signed.sha256,evidencePath:relative(this.taskDir,join(this.swarmDir,unit.id,'evidence.json')),branch:r.evidence.branch??null,headSha:r.evidence.headSha??null,mergeSha:null};
      if(r.evidence.passed){
        const merge=await this.git(['merge','--no-ff','--no-edit','-m',`swarm(${unit.id}): merge verified unit`,r.evidence.branch],{cwd:integrationDir,allowFail:true});
        if(merge.exitCode===0){summary.status='merged';summary.mergeSha=await this.revParse('HEAD',integrationDir);await this.emitEvent('unit.merged',{unit:unit.id,mergeSha:summary.mergeSha});}
        else{await this.git(['merge','--abort'],{cwd:integrationDir,allowFail:true});summary.status='conflict';summary.conflict=merge.stdoutPreview.trim().slice(0,2000);await this.emitEvent('unit.conflict',{unit:unit.id});}
      }
      this.state.units[unit.id].status=summary.status;unitSummaries.push(summary);
    }
    const integrationVerifiers=[];
    for(const v of plan.integrationVerifiers??[]){const res=await this.runVerifier(v,{cwd:integrationDir,logDir:join(this.swarmDir,'integration'),vars:{worktree:integrationDir,unit:'integration',taskDir:this.taskDir,root:this.root}});integrationVerifiers.push(res);await this.emitEvent('integration.verifier',{verifier:v.id,passed:res.passed});if(!res.passed&&plan.stopOnFailure)break;}
    const integrationSha=await this.revParse('HEAD',integrationDir);
    const allUnitsMerged=unitSummaries.every(u=>u.status==='merged');
    const passed=allUnitsMerged&&integrationVerifiers.every(v=>v.passed);
    const report={version:1,taskId:this.taskId,baseSha,integrationBranch,integrationSha,integrationWorktree:relative(this.root,integrationDir),units:unitSummaries,integrationVerifiers,passed,startedAt,finishedAt:nowIso()};
    const signed=signRecord(report,keys);
    await writeFile(join(this.swarmDir,'swarm-report.json'),JSON.stringify(signed,null,2)+'\n');
    this.state.phase=passed?'passed':'failed';this.state.integration={branch:integrationBranch,sha:integrationSha,passed};
    await this.emitEvent('swarm.finished',{passed,integrationSha,reportSha256:signed.sha256});
    if(plan.cleanup!==false)for(const u of unitSummaries)if(u.status==='merged')await this.git(['worktree','remove','--force',join(this.worktreeRoot,u.unit)],{allowFail:true});
    return {report,signed,reportPath:join(this.swarmDir,'swarm-report.json'),integrationDir};
  }
  async runUnit(unit,{plan,baseSha,keys}){
    const unitDir=join(this.swarmDir,unit.id),worktree=join(this.worktreeRoot,unit.id),branch=`swarm/${this.taskId}/${unit.id}`;
    await mkdir(unitDir,{recursive:true});
    if(await exists(worktree))await this.git(['worktree','remove','--force',worktree],{allowFail:true});
    await this.git(['branch','-D',branch],{allowFail:true});
    await this.git(['worktree','add','-b',branch,worktree,baseSha]);
    this.state.units[unit.id]={status:'running',branch,worktree:relative(this.root,worktree)};
    await this.emitEvent('unit.started',{unit:unit.id,branch,endpointId:unit.endpointId??null});
    const briefPath=join(unitDir,'brief.md');await writeFile(briefPath,unit.brief);
    let contextPath=null,contextSha=null;
    if(this.contextCompiler){const ctx=await this.contextCompiler(unit);if(ctx?.markdown){contextPath=join(unitDir,'context.md');await writeFile(contextPath,ctx.markdown);contextSha=sha256(ctx.markdown);}}
    const briefText=contextPath?`${await readFile(contextPath,'utf8')}\n\n---\n\n${unit.brief}`:unit.brief;
    const workerSpec={...(plan.worker??{}),...(unit.worker??{})};
    const vars={brief:briefPath,briefText,context:contextPath??'',worktree,unit:unit.id,taskDir:this.taskDir,root:this.root,endpointId:unit.endpointId??''};
    const argv=this.substitute(workerSpec.argv??DEFAULT_WORKER_ARGV,vars);
    const env={...Object.fromEntries((workerSpec.envPassthrough??[]).filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),...(workerSpec.env??{}),ENGINEERING_OS_UNIT:unit.id,ENGINEERING_OS_WORKTREE:worktree,ENGINEERING_OS_BRIEF:briefPath,ENGINEERING_OS_CONTEXT:contextPath??'',ENGINEERING_OS_TASK_DIR:this.taskDir};
    const worker=await runProcess(argv,{cwd:worktree,env,timeoutMs:workerSpec.timeoutMs??DEFAULT_TIMEOUT,logPrefix:join(unitDir,'worker')});
    await this.emitEvent('unit.worker_exited',{unit:unit.id,exitCode:worker.exitCode,timedOut:worker.timedOut,durationMs:worker.durationMs});
    // Make the worker's output a commit so the evidence binds to an immutable tree.
    const dirty=(await this.git(['status','--porcelain'],{cwd:worktree})).stdoutPreview.trim().length>0;
    if(dirty){await this.git(['add','-A'],{cwd:worktree});await this.git(['-c','user.name=engineering-os','-c','user.email=engineering-os@localhost','commit','-q','-m',`swarm(${unit.id}): worker output`],{cwd:worktree});}
    const headSha=await this.revParse('HEAD',worktree);
    const changedFiles=(await this.git(['diff','--name-only',`${baseSha}..${headSha}`],{cwd:worktree})).stdoutPreview.split('\n').map(s=>s.trim()).filter(Boolean).sort();
    const verifiers=[];let verifiersPassed=true;
    for(const v of [...(plan.verifiers??[]),...(unit.verifiers??[])]){
      const res=await this.runVerifier(v,{cwd:worktree,logDir:unitDir,vars});verifiers.push(res);
      await this.emitEvent('unit.verifier',{unit:unit.id,verifier:v.id,passed:res.passed,exitCode:res.exitCode});
      if(!res.passed){verifiersPassed=false;if(plan.stopOnFailure)break;}
    }
    const workerOk=worker.exitCode===0&&!worker.timedOut;
    const noChanges=!changedFiles.length&&!unit.allowEmpty;
    const passed=workerOk&&verifiersPassed&&!noChanges;
    const evidence={version:1,taskId:this.taskId,unit:unit.id,endpointId:unit.endpointId??null,branch,baseSha,headSha,worktree:relative(this.root,worktree),briefSha256:sha256(unit.brief),contextSha256:contextSha,
      worker:{argv,exitCode:worker.exitCode,signal:worker.signal,timedOut:worker.timedOut,durationMs:worker.durationMs,stdoutSha256:worker.stdoutSha256,stderrSha256:worker.stderrSha256},
      changedFiles,verifiers,passed,failureReasons:[...(!workerOk?['worker failed']:[]),...(!verifiersPassed?['verifier failed']:[]),...(noChanges?['no changes produced']:[])],startedAt:worker.startedAt,finishedAt:nowIso()};
    const signed=signRecord(evidence,keys);
    await writeFile(join(unitDir,'evidence.json'),JSON.stringify(signed,null,2)+'\n');
    this.state.units[unit.id]={...this.state.units[unit.id],status:passed?'passed':'failed',headSha,evidenceSha256:signed.sha256};
    await this.emitEvent(passed?'unit.passed':'unit.failed',{unit:unit.id,headSha,evidenceSha256:signed.sha256,reasons:evidence.failureReasons});
    return {signed,evidence};
  }
  async runVerifier(v,{cwd,logDir,vars={}}){
    if(!v?.id||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.id))throw Error(`Invalid verifier id: ${v?.id}`);
    if(v.cwd!==undefined&&(typeof v.cwd!=='string'||isAbsolute(v.cwd)||v.cwd.split(/[\\/]/).includes('..')))throw Error(`Verifier ${v.id}: cwd must be a relative path inside the worktree`);
    await mkdir(logDir,{recursive:true});
    const argv=this.substitute(v.argv,vars);
    const r=await runProcess(argv,{cwd:resolve(cwd,v.cwd??'.'),env:v.env??{},timeoutMs:v.timeoutMs??DEFAULT_TIMEOUT,logPrefix:join(logDir,`verify-${v.id}`)});
    return {id:v.id,kind:v.kind??'command',command:argv.join(' '),cwd:v.cwd??'.',exitCode:r.exitCode,signal:r.signal,timedOut:r.timedOut,durationMs:r.durationMs,stdoutSha256:r.stdoutSha256,stderrSha256:r.stderrSha256,stdoutPath:relative(this.taskDir,r.stdoutPath),stderrPath:relative(this.taskDir,r.stderrPath),passed:r.exitCode===0&&!r.timedOut};
  }
  /** Declarative UI layout for the current phase (subsystem 7 contract; see docs/meta-os/schemas/ui-layout.schema.json). */
  layout(){
    const units=Object.entries(this.state.units).map(([id,u])=>({id,...u}));
    if(this.state.phase==='idle')return {version:1,title:'Swarm idle',regions:[{id:'main',component:'empty',props:{message:'No swarm dispatched'}}]};
    return {version:1,title:`Swarm ${this.taskId.slice(0,8)} — ${this.state.phase}`,regions:[
      {id:'main',component:'dag',props:{nodes:units.map(u=>({id:u.id,status:u.status,branch:u.branch??null})),edges:units.map(u=>({from:u.id,to:'integration'})).concat([{from:'base',to:'*'}])}},
      {id:'side',component:'evidence-matrix',props:{rows:units.map(u=>({unit:u.id,status:u.status,evidence:u.evidenceSha256??null}))}},
      ...(this.state.integration?[{id:'footer',component:'status-banner',props:{level:this.state.integration.passed?'success':'error',text:`Integration ${this.state.integration.branch} @ ${this.state.integration.sha.slice(0,7)} ${this.state.integration.passed?'passed':'failed'}`}}]:[])
    ],actions:this.state.phase==='failed'?[{id:'inspect',label:'Open failed worktrees',kind:'navigate',target:'worktrees'}]:[]};
  }
  /** Minimal SSE/JSON server for the workspace shell: GET /events (SSE), /state, /layout, /history. */
  serve({host='127.0.0.1',port=0}={}){
    const server=createServer((req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/events'){
        res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
        for(const e of this.history.slice(-50))res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        const listener=e=>res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        this.on('event',listener);const ping=setInterval(()=>res.write(': ping\n\n'),15000);
        req.on('close',()=>{this.off('event',listener);clearInterval(ping);});return;
      }
      const json=body=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));};
      if(url.pathname==='/state')return json(this.state);
      if(url.pathname==='/layout')return json(this.layout());
      if(url.pathname==='/history')return json(this.history);
      res.writeHead(404);res.end();
    });
    return new Promise(done=>server.listen(port,host,()=>done({server,port:server.address().port,host})));
  }
}
