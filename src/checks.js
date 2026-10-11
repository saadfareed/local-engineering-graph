import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {finished} from 'node:stream/promises';
import {mkdir,readFile,writeFile,rename,unlink,realpath,lstat} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const MAX_OUTPUT=1024*1024;
const MAX_LOG_BYTES=100*1024*1024;
const MAX_TIMEOUT=1800000;
const ENV_KEYS=['PATH','HOME','TMPDIR','TEMP','LANG','LC_ALL','TERM','SYSTEMROOT','COMSPEC','PATHEXT','USER','LOGNAME'];
const environment=()=>Object.fromEntries(ENV_KEYS.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
const snapshot=async root=>(await import('./state.js')).projectSnapshot(root);
async function fileHash(path){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
function killGroup(child){try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}

function command(spec){
  if(!spec||!Array.isArray(spec.argv)||!spec.argv.length||spec.argv.some(v=>typeof v!=='string'||!v.trim()||v.includes('\0')))throw Error('Check requires a nonempty argv array');
  if(spec.timeoutMs!==undefined&&(!Number.isSafeInteger(spec.timeoutMs)||spec.timeoutMs<1||spec.timeoutMs>MAX_TIMEOUT))throw Error('Invalid check timeout');
  if(spec.cwd!==undefined&&(typeof spec.cwd!=='string'||!spec.cwd||isAbsolute(spec.cwd)))throw Error('Check cwd must be project-relative');
  return spec.argv;
}

export async function runCheck(taskFile,task,spec){
  const argv=command(spec),root=await realpath(task.root),cwd=resolve(root,spec.cwd??'.'),actual=await realpath(cwd);
  const rel=relative(root,actual);
  if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('Check cwd escapes project');
  const taskDir=await realpath(dirname(taskFile)),checks=join(taskDir,'checks');await mkdir(checks,{recursive:true});
  if(!(await lstat(checks)).isDirectory()||await realpath(checks)!==checks)throw Error('Check directory must be a real task directory');
  const projectSnapshot=await snapshot(root);
  const id=randomUUID(),startedAt=new Date().toISOString();
  const stdoutPath=join(checks,`${id}.stdout`),stderrPath=join(checks,`${id}.stderr`);
  const stdoutLog=createWriteStream(stdoutPath,{flags:'wx'}),stderrLog=createWriteStream(stderrPath,{flags:'wx'});
  const result=await new Promise((resolveResult,reject)=>{
    const child=spawn(argv[0],argv.slice(1),{cwd:actual,env:environment(),shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    const fail=error=>{try{killGroup(child);}catch{}stdoutLog.destroy();stderrLog.destroy();reject(error);};
    stdoutLog.once('error',fail);stderrLog.once('error',fail);
    let stdout='',stderr='',truncated=false,timedOut=false,outputLimitExceeded=false,outputBytes=0;
    const collect=(kind,chunk)=>{
      outputBytes+=chunk.length;
      if(outputBytes>MAX_LOG_BYTES&&!outputLimitExceeded){outputLimitExceeded=true;killGroup(child);}
      const value=kind==='stdout'?stdout:stderr,space=MAX_OUTPUT-value.length;
      if(space<=0){truncated=true;return;}
      const next=value+chunk.toString('utf8').slice(0,space);
      if(kind==='stdout')stdout=next;else stderr=next;
      if(chunk.length>space)truncated=true;
    };
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    child.stdout.pipe(stdoutLog);child.stderr.pipe(stderrLog);
    const timer=setTimeout(()=>{timedOut=true;try{killGroup(child);}catch(error){reject(error);}},spec.timeoutMs??30000);
    child.once('error',error=>{clearTimeout(timer);fail(error);});
    child.once('close',async(exitCode,signal)=>{clearTimeout(timer);try{await Promise.all([finished(stdoutLog),finished(stderrLog)]);resolveResult({exitCode,signal,stdout,stderr,truncated,timedOut,outputLimitExceeded,outputBytes});}catch(error){reject(error);}});
  });
  const afterSnapshot=await snapshot(root),projectHash=hash(JSON.stringify(projectSnapshot));
  const projectChangedDuringRun=projectHash!==hash(JSON.stringify(afterSnapshot));
  const report={schemaVersion:4,id,taskId:task.id,taskRevision:task.revision,root,argv,cwd:rel||'.',startedAt,finishedAt:new Date().toISOString(),projectHash,projectChangedDuringRun,stdoutLog:{path:`checks/${id}.stdout`,sha256:await fileHash(stdoutPath)},stderrLog:{path:`checks/${id}.stderr`,sha256:await fileHash(stderrPath)},...result};
  const path=join(checks,`${id}.json`),tmp=`${path}.tmp`;
  try{await writeFile(tmp,JSON.stringify(report,null,2),{flag:'wx'});await rename(tmp,path);}finally{await unlink(tmp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return {path:relative(dirname(taskFile),path),sha256:hash(await readFile(path)),...report};
}

export async function verifyCheckIntegrity(taskFile,task,ref,revision){
  if(!ref||typeof ref.path!=='string'||!/^checks\/[0-9a-f-]{36}\.json$/.test(ref.path)||typeof ref.sha256!=='string'||!/^[0-9a-f]{64}$/.test(ref.sha256))throw Error('Invalid check reference');
  const taskDir=await realpath(dirname(taskFile)),checks=join(taskDir,'checks');
  if(!(await lstat(checks)).isDirectory()||await realpath(checks)!==checks)throw Error('Check directory escaped task');
  const path=join(taskDir,ref.path);
  if(!(await lstat(path)).isFile()||await realpath(path)!==path)throw Error('Check report must be a regular file');
  const bytes=await readFile(path);
  if(hash(bytes)!==ref.sha256)throw Error('Check report changed');
  const report=JSON.parse(bytes);
  if(![2,3,4].includes(report.schemaVersion)||report.id!==ref.path.slice(7,-5)||report.taskId!==task.id||report.root!==await realpath(task.root)||report.taskRevision!==revision||report.exitCode!==0||report.signal!==null||report.timedOut||report.outputLimitExceeded||report.projectChangedDuringRun)throw Error('Check did not pass for this task revision');
  for(const [name,expected] of [['stdout',report.stdoutLog],['stderr',report.stderrLog]]){
    const logPath=join(checks,`${report.id}.${name}`);
    if(expected?.path!==`checks/${report.id}.${name}`||typeof expected.sha256!=='string'||!(await lstat(logPath)).isFile()||await realpath(logPath)!==logPath||await fileHash(logPath)!==expected.sha256)throw Error('Check output log changed');
  }
  return report;
}

export async function verifyCheck(taskFile,task,ref,currentSnapshot){
  const report=await verifyCheckIntegrity(taskFile,task,ref,task.revision);
  if(![3,4].includes(report.schemaVersion))throw Error('Check must be rerun to bind pre-run project state');
  const expected=report.schemaVersion===4?report.projectHash:hash(JSON.stringify(report.projectSnapshot));
  if(hash(JSON.stringify(currentSnapshot??await snapshot(task.root)))!==expected)throw Error('Project changed since check ran');
  return report;
}
