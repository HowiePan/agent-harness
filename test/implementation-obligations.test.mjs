import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { buildImplementationContinuation } from '../src/application/implementation-continuation.mjs';
import { mergeImplementationObligations } from '../src/application/implementation-obligations.mjs';
import { validateDeliveryBatches } from '../src/flows/delivery-lifecycle/delivery-batches.mjs';
import { makeFixture } from './test-support.mjs';
import { proposal, compile, receiverId, finalId, obligationId } from './delivery-batch-support.mjs';

test('bounded pinned duplicate contracts and verification share one owner while every declaration and old plan remain intact', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'src'), { recursive: true });
  const p = proposal(); const originalContracts = [...p.contracts, ...p.contracts];
  const originalVerification = [...p.verification, ...p.verification];
  const bytes = JSON.stringify({ proposedFeatures: [{ contracts: originalContracts, verification: originalVerification }] });
  await writeFile(resolve(f.workspace, 'expanded.json'), bytes);
  p.contracts = ['expanded.json#/proposedFeatures/0/contracts'];
  p.verification = originalVerification.map((_, index) => ({ specificationRef: `expanded.json#/proposedFeatures/0/verification/${index}` }));
  const pinned = { expandedPlan: { path: 'expanded.json', sha256: sha256(bytes) } };
  const features = compile(p, pinned); const state = { features, submissions: [], attempts: {} };
  const before = digestJson({ p, state });
  for (const feature of features) {
    const context = await buildImplementationContinuation(state, feature, f.workspace);
    assert.equal(context.obligations.length, 1);
    assert.equal(context.obligations[0].sourceOccurrences.length, 2);
    assert.deepEqual(context.obligations[0].sourceOccurrences.map(item => item.resolvedIndex), [0, 1]);
    assert.equal(context.obligations[0].sourceOccurrences[0].proposalId, p.id);
    if (context.obligations[0].id === receiverId) assert.deepEqual(context.obligations[0].sourceOccurrences[0].declarationRefs, p.contracts);
    assert.equal(context.obligations[0].id, feature.metadata.deliveryBatch.phase === 'convergence' ? finalId : receiverId);
  }
  const original = { ...p }; delete original.deliveryPolicy; delete original.deliveryBatches;
  const legacy = await buildImplementationContinuation({ submissions: [], attempts: {} }, {
    id: 'legacy', logicalRoot: 'legacy', allowedPaths: p.allowedPaths,
    metadata: { stage: 'implementation', approvedProposal: original, approvedDeliveryPlan: pinned },
  }, f.workspace);
  assert.equal(legacy.obligations.length, 4);
  assert(legacy.obligations.every(item => !Object.hasOwn(item, 'sourceOccurrences')));
  assert.equal(digestJson({ p, state }), before);
  const missing = structuredClone(p); missing.deliveryBatches[0].obligationIds = [obligationId('contract', 'wrong')];
  missing.deliveryBatches[0].checks[0].covers = [...missing.deliveryBatches[0].obligationIds];
  assert.throws(() => validateDeliveryBatches(missing, { obligations: [{ id: receiverId }, { id: finalId }] }),
    { code: 'DELIVERY_BATCH_OBLIGATION_COVERAGE' });
  const duplicate = structuredClone(p); duplicate.deliveryBatches[1].obligationIds.push(receiverId);
  duplicate.deliveryBatches[1].checks[0].covers.push(receiverId);
  assert.throws(() => validateDeliveryBatches(duplicate), { code: 'DELIVERY_BATCH_DUPLICATE_OWNER' });
});

test('coalescing rejects conflicting certificate/source-exit payloads instead of hiding requirements behind the same ID', () => {
  for (const kind of ['aggregate-certificate', 'source-exit']) {
    const item = { id: obligationId(kind, 'same-source'), kind, key: 'same-source', finalPaths: ['src/receiver.mjs'],
      sourceOccurrences: [{ proposalId: 'owner', collection: kind, resolvedIndex: 0 }] };
    const duplicate = { ...item, sourceOccurrences: [{ proposalId: 'child', collection: kind, resolvedIndex: 1 }] };
    const merged = mergeImplementationObligations([item, duplicate]);
    assert.equal(merged.length, 1); assert.equal(merged[0].sourceOccurrences.length, 2);
    merged[0].finalPaths.push('src/local-only.mjs'); assert.equal(item.finalPaths.length, 1);
    assert.throws(() => mergeImplementationObligations([item, { ...duplicate, finalPaths: ['src/different.mjs'] }]),
      { code: 'IMPLEMENTATION_OBLIGATION_ID_CONFLICT' });
  }
});
