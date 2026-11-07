import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readInputInventory} from '../src/platform/plugins/execution/input-inventory.mjs';
test('large exact inventories stream and reject duplicate, unsorted and oversized lines',async t=>{
 const parent=resolve('.tmp/inventory-tests');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(resolve(parent,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=resolve(root,'inputs.ndjson');
 const paths=Array.from({length:4096},(_,i)=>`F:/owned/${String(i).padStart(6,'0')}.json`);
 await writeFile(file,paths.map(JSON.stringify).join('\n')+'\n');
 let count=0;for await(const path of readInputInventory(file)){assert.equal(path,paths[count]);count++;}assert.equal(count,4096);
 for(const data of ['"F:/a"\n"F:/A"\n','"F:/z"\n"F:/a"\n','x'.repeat(5000)+'\n','"F:/a"']){
  await writeFile(file,data);await assert.rejects(async()=>{for await(const _ of readInputInventory(file)){}},{code:'SCRIPT_INVENTORY_INVALID'});
 }
});
