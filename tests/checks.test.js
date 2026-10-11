import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createTask,readTask} from '../src/state.js';
import {runCheck,verifyCheck} from '../src/checks.js';

test('runner captures actual pass/fail and binds checks to task revision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'engineering-checks-'));
  try{
    const graph=JSON.parse(await readFile(new URL('../graphs/product-build.v2.json',import.meta.url)));
    const task=await createTask(root,graph,'Check fixture'),file=join(root,'.engineering/tasks',task.id,'task.json');
    await writeFile(join(root,'code.js'),'original');
    const modifying=await runCheck(file,task,{argv:[process.execPath,'-e',"require('fs').writeFileSync('code.js','modified')"]});
    await assert.rejects(verifyCheck(file,task,modifying),/did not pass/);
    await writeFile(join(root,'code.js'),'original');
    const pass=await runCheck(file,task,{argv:[process.execPath,'-e','process.exit(0)']});
    assert.equal((await verifyCheck(file,task,pass)).exitCode,0);
    await writeFile(join(root,'code.js'),'changed');
    await assert.rejects(verifyCheck(file,task,pass),/Project changed/);
    await writeFile(join(root,'code.js'),'original');
    const fail=await runCheck(file,task,{argv:[process.execPath,'-e','process.exit(7)']});
    await assert.rejects(verifyCheck(file,task,fail),/did not pass/);
    await assert.rejects(verifyCheck(file,{...task,revision:1},pass),/revision/);
    await writeFile(join(root,'.engineering/tasks',task.id,pass.path),'{}');
    await assert.rejects(verifyCheck(file,await readTask(file),pass),/changed/);
  }finally{await rm(root,{recursive:true,force:true});}
});
