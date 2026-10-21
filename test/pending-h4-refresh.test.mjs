import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentPatchReceiptDigest } from '../src/application/development-patch.mjs';
import { pendingCarryoverRefreshOriginValid } from '../src/application/development-run-recovery.mjs';

test('pending H4 refresh requires the exact explicit migration Receipt and remains idle', () => {
  const body = { kind: 'development-patch-receipt', level: 'H4', migrationRunId: 'original',
    affectedRuns: [{ projectId: 'project', runId: 'original' }] };
  const receipt = { ...body, receiptDigest: developmentPatchReceiptDigest(body) };
  const prior = { projectId: 'project', runId: 'original', leases: [], dispatches: [],
    metadata: { supersededReason: `development-h4-recovery:${receipt.receiptDigest}`,
      completionCarryover: { plan: { patchReceiptDigest: receipt.receiptDigest } } } };
  assert.equal(pendingCarryoverRefreshOriginValid(prior, receipt), true);
  assert.equal(pendingCarryoverRefreshOriginValid(prior), false);
  for (const mutate of [s => { s.runId = 'other'; }, s => { s.metadata.completionCarryover.plan.patchReceiptDigest = 'wrong'; },
    s => { s.leases.push({ status: 'active' }); }, s => { s.dispatches.push({ status: 'assigned' }); }]) {
    const next = structuredClone(prior); mutate(next);
    assert.equal(pendingCarryoverRefreshOriginValid(next, receipt), false);
  }
  assert.equal(pendingCarryoverRefreshOriginValid(prior, { ...receipt, level: 'H3' }), false);
  assert.equal(pendingCarryoverRefreshOriginValid(prior, { ...receipt, migrationRunId: 'other' }), false);
});
