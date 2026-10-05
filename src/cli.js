import {readFile} from 'node:fs/promises';
import {validateGraph} from './graph.js';
import {createTask,status,advance,recover,cancel} from './state.js';
import {initProduct,addFeature,syncProduct,checkProduct,featureContext,releaseFeature,prepareProduct,syncFeature,recoverProduct} from './product.js';
const [command,...args]=process.argv.slice(2);
try {
 let result;
 const arities={'product-init':[2,2],'product-ready':[2,2],'feature-sync':[3,3],'feature-add':[3,3],'product-sync':[1,1],'product-check':[1,1],'feature-context':[2,2],'feature-release':[3,3],'product-recover':[1,1],validate:[1,1],start:[3,4],status:[1,1],advance:[4,4],recover:[1,1],cancel:[3,3]};
 const usage={
  'product-init':'ROOT NAME','product-ready':'ROOT RECORD_JSON','feature-sync':'ROOT ID RECORD_JSON','feature-add':'ROOT ID TITLE',
  'product-sync':'ROOT','product-check':'ROOT','feature-context':'ROOT ID','feature-release':'ROOT ID RECORD_JSON','product-recover':'ROOT',
  validate:'GRAPH',start:'ROOT GRAPH OBJECTIVE [SUPERSEDED_TASK_FILE]',status:'TASK_FILE',advance:'TASK_FILE OUTCOME REVISION EVIDENCE_OR_@JSON_FILE',recover:'TASK_FILE',cancel:'TASK_FILE REVISION REASON'
 };
 if(args.includes('--help')&&usage[command]) {
   console.log(`${command} ${usage[command]}`);process.exit(0);
 }
 if(command==='help'||command==='--help'||command==='-h') {
   console.log(Object.entries(usage).map(([name,args])=>`${name} ${args}`).join('\n')+'\nSee docs/workflow.md and docs/product-map.md for evidence examples.');
   process.exit(0);
 }
 if(arities[command]&&(args.length<arities[command][0]||args.length>arities[command][1])) throw Error(`Invalid arguments for ${command}; use --help`);
 if(['advance','cancel'].includes(command)) {
   const revision=args[command==='advance'?2:1];
   if(!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision))) throw Error('Revision must be a nonnegative safe integer');
 }
 if(command==='product-recover') result=await recoverProduct(args[0]);
 else if(command==='product-init') result=await initProduct(args[0],args[1]);
 else if(command==='product-ready') result=await prepareProduct(args[0],JSON.parse(await readFile(args[1],'utf8')));
 else if(command==='feature-sync') result=await syncFeature(args[0],args[1],JSON.parse(await readFile(args[2],'utf8')));
 else if(command==='feature-add') result=await addFeature(args[0],args[1],args[2]);
 else if(command==='product-sync') result=await syncProduct(args[0]);
 else if(command==='product-check') result=await checkProduct(args[0]);
 else if(command==='feature-context') result=await featureContext(args[0],args[1]);
 else if(command==='feature-release') result=await releaseFeature(args[0],args[1],JSON.parse(await readFile(args[2],'utf8')));
 else if(command==='validate') result=validateGraph(JSON.parse(await readFile(args[0],'utf8')));
 else if(command==='start') result=await createTask(args[0],JSON.parse(await readFile(args[1],'utf8')),args[2],{supersedes:args[3]});
 else if(command==='status') result=await status(args[0]);
 else if(command==='advance') result=await advance(args[0],{outcome:args[1],expectedRevision:Number(args[2]),evidence:args[3]?.startsWith('@')?JSON.parse(await readFile(args[3].slice(1),'utf8')):args[3]});
 else if(command==='recover') result=await recover(args[0]);
 else if(command==='cancel') result=await cancel(args[0],{expectedRevision:Number(args[1]),reason:args[2]});
 else throw Error('Usage: product-init ROOT NAME | product-ready ROOT RECORD_JSON | feature-sync ROOT ID RECORD_JSON | feature-add ROOT ID TITLE | product-sync ROOT | product-check ROOT | feature-context ROOT ID | feature-release ROOT ID RECORD_JSON | validate GRAPH | start ROOT GRAPH OBJECTIVE [SUPERSEDED_TASK_FILE] | status TASK_FILE | advance TASK_FILE OUTCOME REVISION EVIDENCE_OR_@JSON_FILE | recover TASK_FILE | cancel TASK_FILE REVISION REASON');
 console.log(JSON.stringify(result,null,2));
} catch(e){console.error(e.message);process.exitCode=1;}
