import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { intakeNodes } from '../nodes/intake/index.mjs';
import { discoveryNodes, codeDiscoveryNodes } from '../nodes/discovery/index.mjs';
import { documentNodes } from '../nodes/documents/index.mjs';
import { reviewNodes } from '../nodes/review/index.mjs';

export const requirementsDesignWorkflow = defineWorkflowDefinition({
  id: 'requirements-design', version: '1.0.0', profileId: 'composable-workflow',
  routes: {
    analyze: [...intakeNodes, ...discoveryNodes, ...documentNodes, ...reviewNodes],
    'analyze-code': [...codeDiscoveryNodes, ...documentNodes, ...reviewNodes],
  },
});
