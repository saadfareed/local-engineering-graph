import {readFile} from 'node:fs/promises';
import {validateGraph} from './graph.js';
import {createTask,status,advance,recover,cancel} from './state.js';
const [command,...args]=process.argv.slice(2);
try {
 let result;
 if(command==='validate') result=validateGraph(JSON.parse(await readFile(args[0],'utf8')));
 else if(command==='start') result=await createTask(args[0],JSON.parse(await readFile(args[1],'utf8')),args[2],{supersedes:args[3]});
 else if(command==='status') result=await status(args[0]);
 else if(command==='advance') result=await advance(args[0],{outcome:args[1],expectedRevision:Number(args[2]),evidence:args[3]?.startsWith('@')?JSON.parse(await readFile(args[3].slice(1),'utf8')):args[3]});
 else if(command==='recover') result=await recover(args[0]);
 else if(command==='cancel') result=await cancel(args[0],{expectedRevision:Number(args[1]),reason:args[2]});
 else throw Error('Usage: validate GRAPH | start ROOT GRAPH OBJECTIVE [SUPERSEDED_TASK_FILE] | status TASK_FILE | advance TASK_FILE OUTCOME REVISION EVIDENCE_OR_@JSON_FILE | recover TASK_FILE | cancel TASK_FILE REVISION REASON');
 console.log(JSON.stringify(result,null,2));
} catch(e){console.error(e.message);process.exitCode=1;}
