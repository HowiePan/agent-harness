import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthorityStore } from '../src/kernel/authority-store.mjs';
import { atomicWriteJson } from '../src/kernel/atomic-io.mjs';
import { harnessProjectRoot } from '../src/common/write-boundary.mjs';
import { readImplementationPlanningHistory,readQualityPlanningHistory } from '../src/application/planning-history-inputs.mjs';
import { deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';

const intent={action:'implement',workflowId:'delivery',target:'V1',preset:'default'};
const run=(id,extra={})=>({projectId:'sample',runId:id,status:'closed',revision:1,sourceDigest:'a'.repeat(64),
  authorityDigest:id,createdAt:'2026-11-01',updatedAt:'2026-11-01',features:[],findings:[],submissions:[],metadata:{commandIntent:intent},...extra});

test('implementation planning loads only pending carry-over while retaining replacement identity and finished frontiers',async()=>{
  const pending=run('pending',{status:'superseded',metadata:{commandIntent:intent,supersededByRunId:'future',
    completionCarryover:{replacementPlan:{logicalTaskKey:'task',fullPayload:'must remain exact'}}}});
  const consumed=run('consumed',{status:'superseded',metadata:{commandIntent:intent,supersededByRunId:'replacement',supersedePlanDigest:'plan',
    completionCarryover:{replacementPlan:{logicalTaskKey:'task',largePayload:'discard after verification'}}}});
  const replacement=run('replacement',{metadata:{commandIntent:intent,lifecyclePlanDigest:'plan',logicalTaskKey:'task'}});
  const finished=run('finished',{features:[{state:'completed',metadata:{stage:'implementation'}}]});
  const data=[consumed,replacement,pending,finished],reads=[];
  const store={list:async()=>structuredClone(data),read:async(_,id)=>{reads.push(id);return structuredClone(data.find(r=>r.runId===id));}};
  const rows=await readImplementationPlanningHistory(store,'sample',intent);
  assert.deepEqual(reads,['pending']);assert.deepEqual(rows.find(r=>r.runId==='pending'),pending);
  assert.equal(rows.find(r=>r.runId==='consumed').metadata.completionCarryover.replacementPlan.largePayload,undefined);
  assert.equal(rows.find(r=>r.runId==='replacement').metadata.lifecyclePlanDigest,'plan');
  assert.equal(rows.find(r=>r.runId==='finished').features[0].state,'completed');
});

test('projected quality inputs preserve exact target digests, scoped findings, prerequisites and review histories',async()=>{
  const history=[run('first',{metadata:{commandIntent:{...intent,action:'quality',preset:'release-exhaustive'},workflow:{id:'delivery'},
      approvedPlan:{irrelevantPayload:'omit me'},qualityRepairInventories:{scope:{scopeRoot:'src',findings:[{id:'resolved'}]}}},
    features:[{id:'review',state:'completed',metadata:{qualityReview:true,qualityRoot:'src'}}],
    findings:[{id:'open',featureId:'review',severity:'P2',status:'open',summary:'Observed',affectedPaths:['src/a'],evidenceRefs:['finding']}],
    submissions:[{featureId:'review',outputSourceDigest:'b'.repeat(64),evidenceRefs:['review-proof'],submittedAt:'2026-11-01',result:{status:'completed',
      knownFindingDispositions:[{id:'resolved',disposition:'not-reproduced',evidence:['fresh check']}],
      deliveryPrerequisites:[{id:'external',summary:'Dependency',affectedPaths:['external'],evidence:['exact reference'],reason:'outside-scope'}]}}]}),
    run('active',{status:'running',features:[{id:'unfinished',state:'blocked',metadata:{qualityRoot:'src'}}]})];
  const projected=await readQualityPlanningHistory({list:async()=>structuredClone(history)},'sample');
  assert.equal(projected[0].metadata.approvedPlan,undefined);
  for(const includeNonterminal of [false,true])for(const scopeRoot of [null,'src','other']) {
    const args={projectId:'sample',workflowId:'delivery',target:'V1',sourceDigest:'c'.repeat(64),includeNonterminal,scopeRoot};
    assert.deepEqual(deriveQualityTargetSnapshot({...args,runs:projected}),deriveQualityTargetSnapshot({...args,runs:history}));
  }
});

test('even discarded unrelated history is verified and a changed pending carry-over is rejected',async t=>{
  const controlRoot=harnessProjectRoot(),root=resolve(controlRoot,'.tmp',`planning-index-${process.pid}-${Date.now()}`);
  await mkdir(root,{recursive:true});t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new AuthorityStore({root,controlRoot});
  await store.create(run('unrelated',{metadata:{commandIntent:{action:'plan',target:'other'}}}),{commandId:'create'});
  const saved=await store.read('sample','unrelated');
  await atomicWriteJson(store.runFile('sample','unrelated'),{...saved,status:'altered'},{root});
  await assert.rejects(readImplementationPlanningHistory(store,'sample',intent),{code:'AUTHORITY_DIGEST_MISMATCH'});
  await assert.rejects(readQualityPlanningHistory(store,'sample'),{code:'AUTHORITY_DIGEST_MISMATCH'});
  const pending=run('pending',{status:'superseded',metadata:{commandIntent:intent,supersededByRunId:'future',completionCarryover:{replacementPlan:{logicalTaskKey:'task'}}}});
  await assert.rejects(readImplementationPlanningHistory({list:async()=>[pending],read:async()=>({...pending,authorityDigest:'changed'})},'sample',intent),{code:'AUTHORITY_HISTORY_CHANGED'});
});
