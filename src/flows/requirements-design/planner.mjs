import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { createReferenceFeature } from '../../flow-kit/reference-feature.mjs';
import { verifySourceManifest } from '../../platform/workflow/source-manifest.mjs';
import { resolveLifecycleExecutionPolicy } from '../../platform/plugins/runtime/execution-policy.mjs';
import { requirementsDesignWorkflow } from './graph/definition.mjs';
import { requiredFinalGates } from './policy/index.mjs';

export const createRequirementsDesignPlan = ({ intent, project, runId }) => {
  const input = intent.workflowInput;
  assert(input?.sourceManifest && input.outputPaths, 'WORKFLOW_INPUT_REQUIRED', 'Requirements workflow requires sources and document output paths.');
  const manifest = verifySourceManifest(input.sourceManifest);
  assert(manifest.projectId === project.id, 'SOURCE_PROJECT_MISMATCH', 'Source Manifest Project differs from the workflow Project.');
  const documents = manifest.sources.filter(source => source.type === 'document');
  const repositories = manifest.sources.filter(source => source.type === 'repository');
  assert(documents.length && repositories.length, 'WORKFLOW_SOURCE_KIND_REQUIRED', 'Requirements workflow requires at least one document and one repository.');
  const receiver = resolveLifecycleExecutionPolicy({ project, action: intent.action, workflowId: intent.workflowId }).runtimePluginId;
  for (const source of manifest.sources) assert(source.accessScope.includes(receiver), 'SOURCE_RECEIVER_DENIED', `Runtime cannot receive source ${source.sourceId}.`);
  assert(input.outputPaths.requirements !== input.outputPaths.design, 'WORKFLOW_OUTPUT_CONFLICT', 'Requirements and design outputs must differ.');
  const features = compileWorkflowFeatures({ definition: requirementsDesignWorkflow, routeId: 'analyze', templates: { 'reference-feature': createReferenceFeature }, context: { intent }, items: { documents, repositories } });
  const workflow = { id: requirementsDesignWorkflow.id, version: requirementsDesignWorkflow.version, artifactDigest: requirementsDesignWorkflow.artifactDigest };
  const requiredFinalGatesForRun = requiredFinalGates(project);
  return {
    run: { runId, profileId: 'composable-workflow', profileConfig: { requiredFinalGates: requiredFinalGatesForRun }, features, metadata: { workflow, sourceManifest: manifest, memorySnapshot: input.memorySnapshot ?? [], instanceKey: intent.target } },
    stopCondition: { type: 'workflow-complete', requiresFeatureCompletion: true, requiredFinalGates: requiredFinalGatesForRun },
    protectedOperations: ['publication', 'commit', 'push', 'external-cutover'],
  };
};
