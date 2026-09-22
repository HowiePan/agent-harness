import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementsDesignWorkflow } from '../src/flows/requirements-design/graph/definition.mjs';
import { requirementsValueSchemas } from '../src/flows/requirements-design/contracts/index.mjs';
import { validateJsonSchema } from '../src/common/json-schema.mjs';

test('code-only requirements analysis returns an architecture contract without inventing a requirement', () => {
  const map = requirementsDesignWorkflow.routes['analyze-code'].find(node => node.id === 'map');
  assert.deepEqual(map.outputPorts, { architecture: 'code-architecture-v1' });
  assert.equal(Object.hasOwn(map.outputPorts, 'impact'), false);

  const valid = {
    modules: ['src/platform'],
    capabilities: ['workspace-registry'],
    mappings: [{ capability: 'workspace-registry', paths: ['src/platform/workspace'] }],
  };
  assert.equal(validateJsonSchema(valid, requirementsValueSchemas['code-architecture-v1']).valid, true);
  assert.equal(validateJsonSchema({ code: ['src/index.mjs'], requirement: 'invented' }, requirementsValueSchemas['code-architecture-v1']).valid, false);
});
