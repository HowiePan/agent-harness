import {featureContractDigest} from '../common/interruption-contract.mjs';

const inside=(root,path)=>path===root||path.startsWith(root+'/');
export const hasMixedPrerequisiteDiagnosis=result=>Boolean(result?.outputs?.diagnosis?.value?.conclusion==='external-prerequisite'
  &&!result.outputs.diagnosis.value.resolutionActions&&result.deliveryPrerequisites?.length);
/** Explicit dependency identity is ownership; path references only select legacy owners. */
export const diagnosticRepairActions=(state,source,submission,result)=>{
  const d=result?.outputs?.diagnosis?.value;if(!d)return [];
  if(d.resolutionActions)return d.resolutionActions.filter(a=>a.kind==='dependency-repair').map(a=>({...a,explicit:true}));
  if(submission.result.failureClass==='scope-blocker'&&submission.result.blocker?.kind==='scope'&&d.repairPaths?.length)
    return [{id:'legacy-scope-return',paths:d.repairPaths,legacyScope:true}];
  return []; // Mixed legacy prose requires an accounted structured clarification.
};
export const actionOwns=(feature,action)=>action.explicit
  ? action.ownerFeatureId===feature.id&&action.ownerContractDigest===featureContractDigest(feature)
  : action.paths.every(path=>feature.allowedPaths.some(root=>inside(root,path))&&!feature.forbiddenPaths.some(root=>inside(root,path)));
export const remainingPrerequisites=(diagnosis,result,action)=>{
  if(action.legacyScope)return [];
  if(action.legacyPrerequisite)return (result.deliveryPrerequisites??[]).filter(p=>p.id!==action.id).map(p=>({id:p.id,summary:p.summary}));
  const unresolved=(diagnosis.resolutionActions??[]).filter(a=>a.id!==action.id&&
    (a.kind!=='input-discovery'||a.discovery?.status!=='found')).map(a=>({id:a.id,summary:a.summary}));
  for(const work of diagnosis.remainingWork??[])for(const q of work.unknowns??[])
    if(typeof q==='object'&&!['in-scope-work','verification-pending'].includes(q.classification)&&q.actionId!==action.id
      &&!(q.classification==='external-prerequisite'&&diagnosis.resolutionActions?.some(a=>a.id===q.actionId&&a.kind==='input-discovery'&&a.discovery?.status==='found')))
      if(!unresolved.some(a=>a.id===q.actionId))unresolved.push({id:q.actionId??'unresolved-input',summary:q.question});
  return unresolved;
};
