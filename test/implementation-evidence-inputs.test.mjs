import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, digestJson } from '../src/common/canonical.mjs';
import { collectImplementationDraftInputs } from '../src/application/implementation-evidence-inputs.mjs';

import { evidenceFixture as fixture } from './implementation-evidence-support.mjs';

test('required draft context follows exact declared ancestry and retains zero completion credit', async()=>{
  const f=fixture(); const inputs=await collectImplementationDraftInputs(f);
  assert.equal(inputs.length,1); assert.equal(inputs[0].completionCredit,false); assert.equal(inputs[0].status,'unaccepted');
  assert.deepEqual(inputs[0].originalResult,f.record.originalResult);
  assert.equal(inputs[0].sourceDelta.observedSnapshot,undefined);
  f.feature.logicalRoot='independent-owner';assert.deepEqual(await collectImplementationDraftInputs(f),[]);
});

test('missing ancestry, wrong project and altered original or Host evidence fail before an Agent dispatch', async()=>{
  for(const mutate of [f=>delete f.nodes.retired, f=>f.nodes.retired.projectId='another-project',
    f=>f.evidence.metadata.dispatchId='another-dispatch',f=>f.evidence.metadata.artifactDigest='other-artifact',
    f=>{f.record.originalResult.summary='changed';f.evidence.bytes=Buffer.from(canonicalize(f.record));},
    f=>{f.record.hostObservationReceipt.receiptDigest='other-host';f.evidence.bytes=Buffer.from(canonicalize(f.record));},
    f=>f.nodes.retired.submissions.push({dispatchId:'dispatch'})]) {
    const f=fixture();mutate(f);await assert.rejects(collectImplementationDraftInputs(f));
  }
});

test('ancestry cycles do not recurse or search adjacent runs',async()=>{
  const f=fixture();f.nodes.plan.metadata.planRevision={parentRunId:'plan'};
  assert.deepEqual(await collectImplementationDraftInputs(f),[]);
});
