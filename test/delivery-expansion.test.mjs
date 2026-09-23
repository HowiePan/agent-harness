import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDeliveryCommandManifest,
  createDeliveryLifecyclePlan,
  createDeliveryProjectDescriptor,
  deliveryLifecycleProfile,
  deliveryLifecycleWorkflowDefinition,
  deliveryPorts,
  deliveryValueSchemas,
  DELIVERY_STAGES,
} from '../src/flows/delivery-lifecycle/index.mjs';
import { resolveCommandIntent } from '../src/platform/extensions/command-contract.mjs';
import { sealKnownFindingInventory } from '../src/platform/execution/known-finding-inventory.mjs';
import { deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';
import { validateJsonSchema } from '../src/common/json-schema.mjs';

const qualityTarget = deriveQualityTargetSnapshot({ projectId: 'delivery-project', workflowId: 'delivery-lifecycle', target: 'V-next', sourceDigest: 'a'.repeat(64) });
const knownFindingInventory = sealKnownFindingInventory({ projectId: 'delivery-project', target: 'V-next', declaration: { version: '1.0', sources: [{ path: 'docs/version.md', sha256: 'b'.repeat(64) }], findings: [] }, snapshot: { digest: 'a'.repeat(64), files: [{ path: 'docs/version.md', sha256: 'b'.repeat(64) }] } });

const planStages = (action, scope) => createDeliveryLifecyclePlan({
  intent: { action, target: 'V-next', scope, qualityTarget, ...(['quality', 'full', 'deliver'].includes(action) ? { knownFindingInventory } : {}) },
  project: createDeliveryProjectDescriptor({ workspaceRoot: process.cwd() }),
  runId: `${action}:${scope}`,
  sourceDigest: 'a'.repeat(64),
}).run.features.map(feature => feature.metadata.stage);

test('requirements expansion sits between intake and canonical with a typed port', () => {
  const route = deliveryLifecycleWorkflowDefinition.routes.requirements;
  assert.deepEqual(route.map(node => node.id), ['intake', 'expansion', 'canonical']);
  const expansion = route.find(node => node.id === 'expansion');
  assert.deepEqual(expansion.outputPorts, { expansion: deliveryPorts.expansion });
  assert.deepEqual(expansion.outputValueSchemas.expansion, deliveryValueSchemas[deliveryPorts.expansion]);
  assert.ok(expansion.task.taskDigest);
  assert.deepEqual(expansion.dependsOn, ['intake']);
  assert.deepEqual(route.find(node => node.id === 'canonical').dependsOn, ['expansion']);
  assert.equal(validateJsonSchema({ expandedRequirements: ['a'], assumptions: [] }, deliveryValueSchemas['delivery-expansion-v1']).valid, true);
  assert.equal(validateJsonSchema({ derivedFrom: ['docs/requirements.md'] }, deliveryValueSchemas['delivery-expansion-v1']).valid, false);
});

test('requirements presets map to four distinct routes', () => {
  const manifest = createDeliveryCommandManifest();
  const scopeOf = preset => resolveCommandIntent(manifest, { action: 'requirements', target: 'V-next', arguments: [preset] }).scope;
  assert.deepEqual(planStages('requirements', scopeOf('full')), ['requirement-intake', 'requirement-expansion', 'canonical-requirement']);
  assert.deepEqual(planStages('requirements', scopeOf('expand-to-plan')), ['requirement-intake', 'requirement-expansion', 'canonical-requirement', 'version-planning']);
  assert.deepEqual(planStages('requirements', scopeOf('direct')), ['requirement-intake', 'canonical-requirement', 'version-planning']);
  assert.deepEqual(planStages('requirements', scopeOf('plan-only')), ['version-planning']);
  assert.equal(new Set(['full', 'expand-to-plan', 'direct', 'plan-only'].map(scopeOf)).size, 4);
});

test('full action route includes the expansion stage', () => {
  assert.deepEqual(planStages('full', 'requirement-intake..delivery-receipt'), [
    'requirement-intake', 'requirement-expansion', 'canonical-requirement', 'version-planning', 'implementation', 'scope-resolution', 'docs-closeout', 'quality', 'user-code-review', 'delivery-receipt',
  ]);
});

test('expansion dispatches before the canonical decision while plan requires it', () => {
  assert.ok(DELIVERY_STAGES.indexOf('requirement-expansion') < DELIVERY_STAGES.indexOf('canonical-requirement'));
  const state = {
    profile: { config: { requireCanonicalDecision: true } },
    decisions: [],
    features: [
      { id: 'intake', state: 'completed', metadata: { stage: 'requirement-intake' } },
      { id: 'expansion', state: 'pending', metadata: { stage: 'requirement-expansion' } },
      { id: 'canonical', state: 'pending', metadata: { stage: 'canonical-requirement' } },
      { id: 'plan', state: 'pending', metadata: { stage: 'version-planning' } },
    ],
  };
  assert.deepEqual(deliveryLifecycleProfile.canDispatch({ metadata: { stage: 'requirement-expansion' } }, state), { ok: true });
  assert.deepEqual(deliveryLifecycleProfile.canDispatch({ metadata: { stage: 'version-planning' } }, state), { ok: false, reason: 'canonical-requirement-decision-required' });
});
