import { assert } from '../../../src/common/errors.mjs';
import { compileWorkflowFeatures } from '../../../src/platform/workflow/definition.mjs';
import { verifySourceManifest } from '../../../src/platform/workflow/source-manifest.mjs';
import { createReferenceFeature } from '../../../src/flow-kit/reference-feature.mjs';
import { workflow } from './graph/definition.mjs';
import { requiredFinalGates } from './policy/index.mjs';

export const createPlan = ({ intent, project, runId }) => {
  assert(intent.workflowInput?.sourceManifest && intent.workflowInput?.outputPaths?.brief, 'WORKFLOW_INPUT_REQUIRED', 'Source brief requires pinned sources and an output path.');
  const manifest = verifySourceManifest(intent.workflowInput.sourceManifest);
  assert(manifest.projectId === project.id && manifest.sources.length, 'WORKFLOW_SOURCE_REQUIRED', 'Source brief requires accessible sources.');
  const gates = requiredFinalGates(project);
  return {
    run: { runId, profileId: 'composable-workflow', profileConfig: { requiredFinalGates: gates },
      features: compileWorkflowFeatures({ definition: workflow, routeId: 'summarize', templates: { 'reference-feature': createReferenceFeature }, context: { intent } }),
      metadata: { workflow: { id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest }, sourceManifest: manifest, instanceKey: intent.target } },
    stopCondition: { type: 'workflow-complete', requiresFeatureCompletion: true, requiredFinalGates: gates },
    protectedOperations: ['publication', 'commit', 'push', 'external-cutover'],
  };
};
