import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectNativeTraceTail} from '../integrations/codex/agent-harness-codex/lib/codex-host-trace-diagnostic.mjs';
test('Host trace diagnosis records timing and identities without exposing arguments, results or granting acceptance',async t=>{
 const parent=resolve('.tmp/trace-diagnostic-tests');await mkdir(parent,{recursive:true});
 const root=await mkdtemp(resolve(parent,'case-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=resolve(root,'trace.jsonl'),meta={turn_id:'turn'};
 const rows=[{timestamp:'2026-11-06T18:37:20.000Z',type:'response_item',payload:{type:'function_call',namespace:'collaboration',name:'list_agents',call_id:'call',arguments:'{"secret":"hidden"}',internal_chat_message_metadata_passthrough:meta}},
 {timestamp:'2026-11-06T18:39:20.000Z',type:'response_item',ordinal:2,payload:{type:'function_call_output',call_id:'call',id:'output',output:'{"private":"hidden"}',internal_chat_message_metadata_passthrough:meta}}];
 await writeFile(path,rows.map(JSON.stringify).join('\n')+'\n');
 const result=await inspectNativeTraceTail({path,after:'2026-11-06T18:37:16.394Z'});
 assert.equal(result.events.length,2);assert.equal(result.events[1].timestamp,rows[1].timestamp);assert.equal(result.acceptanceCredit,false);
 assert.doesNotMatch(JSON.stringify(result),/secret|private|hidden/);
 const tail=await inspectNativeTraceTail({path,after:'2026-11-07T00:00:00.000Z'});assert.equal(tail.events.length,0);
});
