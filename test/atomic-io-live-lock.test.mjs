import test from 'node:test';
import assert from 'node:assert/strict';
import {utimes,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture} from './test-support.mjs';
import {withDirectoryLock} from '../src/kernel/atomic-io.mjs';

test('elapsed lock age never evicts an observed live owner',async t=>{
 const f=await makeFixture();t.after(f.cleanup);const path=resolve(f.dataRoot,'live-operation.lock');
 await withDirectoryLock(path,async()=>{
   await utimes(path,new Date(0),new Date(0));
   await assert.rejects(withDirectoryLock(path,()=>assert.fail('live lock was stolen'),{root:f.dataRoot,staleMs:1,timeoutMs:10,pollMs:2}),{code:'AUTHORITY_LOCK_TIMEOUT'});
   assert.equal(JSON.parse(await readFile(resolve(path,'owner.json'),'utf8')).pid,process.pid);
 },{root:f.dataRoot});
});
