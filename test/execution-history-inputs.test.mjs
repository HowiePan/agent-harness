import test from 'node:test';
import assert from 'node:assert/strict';
import {readExecutionLineageHistory,readActiveLeaseHistory} from '../src/application/execution-history-inputs.mjs';
import {resolveRunLineage} from '../src/application/lineage.mjs';
import {leaseHealth} from '../src/kernel/kernel.mjs';

const plan={project:{id:'project'},logicalTaskKey:'a'.repeat(64),planDigest:'b'.repeat(64),
  intent:{action:'implement',target:'V1',workflowId:'delivery',preset:'default'},
  run:{runId:'planned',profileId:'delivery',sourceDigest:'c'.repeat(64),agentExecutionMode:'conversation-visible'}};
const now='2026-11-06T00:00:00.000Z';
const state=(extra={})=>({projectId:'project',runId:'planned',revision:1,status:'ready',authorityDigest:'d'.repeat(64),
  sourceDigest:plan.run.sourceDigest,updatedAt:now,profile:{id:'delivery'},features:[],submissions:[],leases:[],dispatches:[],
  metadata:{logicalTaskKey:plan.logicalTaskKey,lifecyclePlanDigest:plan.planDigest,commandIntent:plan.intent},...extra});

test('compact execution history yields identical lineage, lease health and identity barriers',async()=>{
  for(const status of ['ready','running','failed','closed','superseded'])for(const age of [0,30,300]) {
    const rows=[state({status,leases:age?[{leaseId:'lease',dispatchId:'dispatch',status:'active',lastHeartbeatAt:new Date(Date.parse(now)-age*1000).toISOString()}]:[],
      dispatches:age?[{dispatchId:'dispatch',status:'assigned',execution:{runtime:{mode:'conversation-visible'}}}]:[]})];
    const projected=await readExecutionLineageHistory({list:async()=>structuredClone(rows)},plan);
    assert.deepEqual(resolveRunLineage({plan,states:projected,now:()=>now}),resolveRunLineage({plan,states:rows,now:()=>now}));
    assert.deepEqual(leaseHealth(projected[0],Date.parse(now)),leaseHealth(rows[0],Date.parse(now)));
  }
});

test('sealed replacement carry-over is loaded exactly and drift is rejected',async()=>{
  const prior=state({runId:'old',status:'superseded',metadata:{commandIntent:plan.intent,completionCarryover:{plan:{replacementRunId:plan.run.runId,
    replacementPlanDigest:plan.planDigest},replacementPlan:{planDigest:plan.planDigest}}}});
  const store={list:async()=>structuredClone([prior]),read:async()=>structuredClone(prior)};
  assert.deepEqual((await readExecutionLineageHistory(store,plan))[0],prior);
  store.read=async()=>({...prior,authorityDigest:'changed'});
  await assert.rejects(readExecutionLineageHistory(store,plan),{code:'AUTHORITY_HISTORY_CHANGED'});
});

test('active lease scan preserves all live ownership and excludes terminal payloads',async()=>{
  const rows=[state(),state({runId:'live',leases:[{status:'active',leaseId:'l'}]})];
  assert.deepEqual(await readActiveLeaseHistory({listAll:async()=>rows}),[rows[1]]);
});

test('execution indexes never retain embedded command revision plans',async()=>{
  const original=state();original.metadata.commandIntent={...plan.intent,planRevision:{parentPlan:{large:'payload'}}};
  const [projected]=await readExecutionLineageHistory({list:async()=>[original]},plan);
  assert.equal(projected.metadata.commandIntent.planRevision,undefined);
  assert.deepEqual(resolveRunLineage({plan,states:[projected],now:()=>now}),resolveRunLineage({plan,states:[original],now:()=>now}));
});
