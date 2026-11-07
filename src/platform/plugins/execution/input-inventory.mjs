import {createReadStream} from 'node:fs';
import {assert} from '../../../common/errors.mjs';

// Sorted JSON-string lines avoid an unbounded duplicate Set or whole-file parse.
export async function* readInputInventory(path) {
 let pending='',previous='';
 for await(const chunk of createReadStream(path,{encoding:'utf8',highWaterMark:16384})) {
  pending+=chunk;
  for(;;) {
   const end=pending.indexOf('\n');
   if(end<0)break;
   const line=pending.slice(0,end).trim();pending=pending.slice(end+1);
   assert(line.length<=4096,'SCRIPT_INVENTORY_INVALID','Inventory lines must be bounded.');
   if(!line)continue;
   const file=JSON.parse(line),key=typeof file==='string'?file.toLowerCase():'';
   assert(key && key>previous,'SCRIPT_INVENTORY_INVALID','Use strictly sorted unique JSON-string file paths.');
   previous=key;yield file;
  }
  assert(pending.length<=4096,'SCRIPT_INVENTORY_INVALID','Inventory line exceeds its limit.');
 }
 if(pending.trim())throw Object.assign(Error('Inventory requires a final newline.'),{code:'SCRIPT_INVENTORY_INVALID'});
}
