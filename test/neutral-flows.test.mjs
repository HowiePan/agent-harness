import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeliveryProjectDescriptor,
  deliveryLifecycleProfile,
  deliveryLifecycleWorkflowDefinition,
  extensionPack as deliveryExtension,
} from '../src/flows/delivery-lifecycle/index.mjs';
import {
  createBatchProductionProjectDescriptor,
  batchProductionProfile,
  batchProductionWorkflowDefinition,
  extensionPack as batchExtension,
} from '../src/flows/batch-production/index.mjs';
import { extensionPack as cardWorldExtension } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { extensionPack as collectionExtension } from '../integrations/legacy-consumers/collection/index.mjs';

test('generic Flow exports use neutral identities', () => {
  const deliveryLifecycleProjectDescriptor = createDeliveryProjectDescriptor({ workspaceRoot: process.cwd() });
  const batchProductionProjectDescriptor = createBatchProductionProjectDescriptor({ workspaceRoot: process.cwd() });
  assert.equal(deliveryLifecycleProjectDescriptor.profiles[0], 'delivery-lifecycle');
  assert.equal(deliveryLifecycleProfile.id, 'delivery-lifecycle');
  assert.equal(deliveryLifecycleWorkflowDefinition.id, 'delivery-lifecycle');
  assert.equal(deliveryLifecycleWorkflowDefinition.profileId, 'delivery-lifecycle');
  assert.equal(deliveryExtension.id, 'delivery-lifecycle-profile');
  assert.deepEqual(deliveryExtension.planningCapabilities, ['quality-target']);

  assert.equal(batchProductionProjectDescriptor.profiles[0], 'batch-production');
  assert.equal(batchProductionProfile.id, 'batch-production');
  assert.equal(batchProductionWorkflowDefinition.id, 'batch-production');
  assert.equal(batchProductionWorkflowDefinition.profileId, 'batch-production');
  assert.equal(batchExtension.id, 'batch-production-profile');
});

test('legacy consumer shims retain their existing identities without changing neutral Flow exports', () => {
  assert.equal(cardWorldExtension.id, 'cardworld-engine-profile');
  assert.equal(cardWorldExtension.workflows[0].id, 'engine-delivery');
  assert.equal(cardWorldExtension.profiles[0].id, 'engine-delivery');
  assert.equal(collectionExtension.id, 'tabletop-collection-profile');
  assert.equal(collectionExtension.workflows[0].id, 'collection-batch-production');
  assert.equal(collectionExtension.profiles[0].id, 'collection-batch');
});
