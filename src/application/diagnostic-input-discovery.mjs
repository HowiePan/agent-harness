import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { sha256 } from '../common/canonical.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { safeProjectFile } from '../common/project-file-policy.mjs';

const file = {type:'object',additionalProperties:false,required:['path','sha256'],properties:{
  path:{type:'string',minLength:1},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}}};
export const resolutionActionSchema = {type:'object',additionalProperties:false,required:['id','kind','summary','paths'],properties:{
  id:{type:'string',minLength:1},kind:{enum:['dependency-repair','input-discovery','input-admission','blocked']},summary:{type:'string',minLength:1},
  paths:{type:'array',maxItems:64,uniqueItems:true,items:{type:'string',minLength:1}},
  ownerFeatureId:{type:'string',minLength:1},ownerContractDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},
  admission:{type:'object',additionalProperties:false,required:['candidates','work','verification'],properties:{
    candidates:{type:'array',minItems:1,maxItems:32,items:file},work:{type:'string',minLength:1},verification:{type:'string',minLength:1}}},
  discovery:{type:'object',additionalProperties:false,required:['status','catalogs','inputs'],properties:{
    status:{enum:['pending','found','unavailable']},catalogs:{type:'array',maxItems:16,items:file},inputs:{type:'array',maxItems:32,items:file}}}
}};
const within=(root,path)=>root==='.'||path===root||path.startsWith(root+'/');
export const projectInputPathPermitted=(path,policy)=>safeProjectFile(path)&&policy?.mode==='project-owned'
  &&[...policy.roots,...(policy.artifactRoots??[])].some(root=>within(root,path))
  &&!['.git','.agent-harness-data',...policy.protectedPaths].some(root=>within(root,path));

/** Discovery supplies inputs, never completion credit or permission to change acceptance. */
export const assessInputDiscovery=async({action,snapshot,workspaceRoot,projectFilePolicy})=>{
  const issue=(code,instruction)=>({issue:{code,actionId:action.id,instruction}});
  const d=action.discovery;
  if(d?.status==='pending')return {discovery:{actionId:action.id,status:'pending',catalogs:d.catalogs,inputs:[],completionCredit:false}};
  if(!d)return issue('INPUT_DISCOVERY_REQUIRED',
    'Perform bounded read-only discovery using exact project-owned catalogs. Return found with catalog-bound inputs, or unavailable with inspected catalogs; do not fabricate inputs or scan external/control roots.');
  if(!d.catalogs.length||new Set(d.catalogs.map(c=>c.path)).size!==d.catalogs.length)
    return issue('INPUT_DISCOVERY_CATALOG_REQUIRED','Identify the exact inspected source-bound catalog files.');
  let inputBytes=0;
  const read=async(item,catalog=false)=>{
    if(!projectInputPathPermitted(item.path,projectFilePolicy))throw Error('outside project');
    const path=assertNoLinkPath(workspaceRoot,resolve(workspaceRoot,item.path));
    const info=await stat(path);if(!info.isFile()||info.size>(catalog?1024*1024:32*1024*1024))throw Error('oversize input');
    if(catalog){const bytes=await readFile(path);if(bytes.length>1024*1024||sha256(bytes)!==item.sha256)throw Error('catalog drift');return bytes;}
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(path,{highWaterMark:65536})){
      inputBytes+=chunk.length;if(inputBytes>32*1024*1024)throw Error('input shard exceeded');hash.update(chunk);
    }
    if(hash.digest('hex')!==item.sha256)throw Error('input drift');
  };
  try{
    const catalogs=[];
    for(const c of d.catalogs){
      if(!snapshot.files.some(f=>f.path===c.path&&f.sha256===c.sha256))throw Error('unbound catalog');
      catalogs.push({file:c,bytes:await read(c,true)});
    }
    if(d.status==='unavailable'){
      if(d.inputs.length)throw Error('unavailable input claim');
      return {discovery:{actionId:action.id,status:'unavailable',catalogs:d.catalogs,inputs:[],completionCredit:false}};
    }
    if(!d.inputs.length||new Set(d.inputs.map(i=>i.path)).size!==d.inputs.length)throw Error('missing inputs');
    const entries=catalogs.flatMap(({bytes})=>{
      const catalog=JSON.parse(bytes.toString('utf8'));
      if(catalog.version!=='verification-input-catalog/1'||!Array.isArray(catalog.inputs)||catalog.inputs.length>128)throw Error('catalog format');
      return catalog.inputs;
    });
    for(const input of d.inputs){
      const matches=entries.filter(e=>e.path===input.path&&e.sha256===input.sha256&&typeof e.version==='string'&&e.version&&typeof e.purpose==='string'&&e.purpose);
      if(matches.length!==1)throw Error('ambiguous or uncertified entry');await read(input);
    }
    return {discovery:{actionId:action.id,status:'found',catalogs:d.catalogs,inputs:d.inputs,
      catalogEntries:entries.filter(e=>d.inputs.some(i=>i.path===e.path&&i.sha256===e.sha256))
        .map(({path,sha256,version,purpose})=>({path,sha256,version,purpose})),completionCredit:false}};
  }catch{return issue('INPUT_DISCOVERY_INVALID','Use exact source-bound catalogs and versioned, purpose-labelled hash-bound input entries within project roots; retain provenance and original verification. Unknown catalog formats or inaccessible inputs stay blocked.');}
};
