import {open} from 'node:fs/promises';
import {sha256} from '../../../../src/common/canonical.mjs';

// Diagnostic only: bounded tail, no Agent result contents or Host receipt writes.
export const inspectNativeTraceTail = async ({path,after,maxBytes=2*1024*1024}) => {
 const file=await open(path,'r');
 try {
  const size=(await file.stat()).size,start=Math.max(0,size-maxBytes),buffer=Buffer.alloc(Math.min(size,maxBytes));
  const {bytesRead}=await file.read(buffer,0,buffer.length,start);
  const text=buffer.subarray(0,bytesRead).toString('utf8');
  const lines=text.split('\n');if(start)lines.shift();lines.pop();
  const calls=new Set(),events=[];
  for(const line of lines){
   let r;try{r=JSON.parse(line);}catch{continue;}
   if(after && r.timestamp && r.timestamp<after)continue;
   const p=r.payload;
   if(r.type!=='response_item')continue;
   if(p?.type==='function_call' && (p.namespace==='collaboration'||/list_agents|spawn_agent|wait_agent|interrupt_agent/.test(p.name??''))){
    calls.add(p.call_id);events.push({timestamp:r.timestamp,ordinal:r.ordinal,type:p.type,namespace:p.namespace,name:p.name,
      callId:p.call_id,argumentBytes:typeof p.arguments==='string'?Buffer.byteLength(p.arguments):null,
      turnId:p.internal_chat_message_metadata_passthrough?.turn_id??null});
   }
   if(p?.type==='function_call_output'&&calls.has(p.call_id))events.push({timestamp:r.timestamp,ordinal:r.ordinal,type:p.type,callId:p.call_id,
    outputId:p.id,outputBytes:typeof p.output==='string'?Buffer.byteLength(p.output):null,
    turnId:p.internal_chat_message_metadata_passthrough?.turn_id??null,
    executedTools:p.internal_chat_message_metadata_passthrough?.executed_tool_calls?.map(x=>x.name)??null});
  }
  return {rolloutPathDigest:sha256(path),fileBytes:size,tailStart:start,bytesRead,events:events.slice(-32),acceptanceCredit:false};
 }finally{await file.close();}
};
