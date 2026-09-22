import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { checkFlowStructure, validateFlowImport } from '../../scripts/check-flow-structure.mjs';

const root = resolve(import.meta.dirname, '..', '..');
test('all Flow packages satisfy the standard skeleton and dependency direction', async () => {
  assert.deepEqual(await checkFlowStructure(root), []);
});
test('private cross-Flow imports are rejected', () => {
  const file = resolve(root, 'src/flows/knowledge-qa/planner.mjs');
  assert.match(validateFlowImport({ root, flowId: 'knowledge-qa', file, specifier: '../requirements-design/nodes/intake/index.mjs' }), /private/);
  assert.equal(validateFlowImport({ root, flowId: 'knowledge-qa', file, specifier: '../requirements-design/index.mjs' }), null);
});
test('neutral Flow packages cannot depend on legacy consumer implementations', () => {
  const file = resolve(root, 'src/flows/delivery-lifecycle/planner.mjs');
  assert.match(validateFlowImport({ root, flowId: 'delivery-lifecycle', file, specifier: '../../../integrations/legacy-consumers/cardworld/index.mjs' }), /legacy consumer/);
});
