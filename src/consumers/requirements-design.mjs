import { assert } from '../errors.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { defineCommandManifest } from '../extensions/command-contract.mjs';
import { compileWorkflowFeatures, defineWorkflowDefinition } from '../workflows/definition.mjs';
import { createReferenceFeature } from '../workflows/reference-feature.mjs';
import { verifySourceManifest } from '../workflows/source-manifest.mjs';
import { resolveLifecycleExecutionPolicy } from '../plugins/runtime/execution-policy.mjs';

const node = (id, dependsOn = [], options = {}) => ({ id, template: 'reference-feature', dependsOn, ...options });

export const requirementsDesignWorkflow = defineWorkflowDefinition({
  id: 'requirements-design', version: '1.0.0', profileId: 'composable-workflow',
  routes: { analyze: [
    node('ingest', [], { forEach: 'documents', sourceType: 'document', outputPorts: { facts: 'source-facts-v1' }, acceptance: ['Extract requirements and ambiguities from the pinned document with exact source locations.'] }),
    node('normalize', ['ingest'], { outputPorts: { requirements: 'requirements-v1' }, acceptance: ['Merge document facts into a complete requirement list and identify conflicts.'] }),
    node('search', ['normalize'], { forEach: 'repositories', sourceType: 'repository', outputPorts: { code: 'code-evidence-v1' }, acceptance: ['Search the pinned repository and cite exact files, symbols, and source digests.'] }),
    node('map', ['search'], { outputPorts: { impact: 'impact-map-v1' }, acceptance: ['Map every requirement to code evidence, missing behavior, and cross repository effects.'] }),
    node('requirements-doc', ['map'], { outputKey: 'requirements', outputPorts: { document: 'document-ref-v1' }, outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }], acceptance: ['Write a complete requirements and functional details document with evidence links.'] }),
    node('design-doc', ['map'], { outputKey: 'design', outputPorts: { document: 'document-ref-v1' }, outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }], acceptance: ['Write an implementation design document covering interfaces, data flow, and risks.'] }),
    node('review', ['requirements-doc', 'design-doc'], { readAllSources: true, outputPorts: { review: 'document-review-v1', knowledge: 'memory-candidates-v1' }, outputChecks: [{ portId: 'review', path: 'passed', operator: 'equals', value: true }, { portId: 'review', path: 'documents', operator: 'non-empty' }], acceptance: ['Independently verify both documents against every pinned source, report all P0-P3 findings, and propose evidence backed reusable knowledge candidates.'] }),
  ] },
});

export const requirementsDesignCommands = defineCommandManifest({
  protocolVersion: '1.0', id: 'requirements-design-commands', profileId: 'composable-workflow', workflowId: requirementsDesignWorkflow.id,
  actions: { analyze: { targetKind: 'feature-key', presets: { default: { scope: 'requirements-and-design', stateChanging: true } } } },
});

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
  const requiredFinalGates = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  return {
    run: { runId, profileId: 'composable-workflow', profileConfig: { requiredFinalGates }, features, metadata: { workflow, sourceManifest: manifest, memorySnapshot: input.memorySnapshot ?? [], instanceKey: intent.target } },
    stopCondition: { type: 'workflow-complete', requiresFeatureCompletion: true, requiredFinalGates },
    protectedOperations: ['publication', 'commit', 'push', 'external-cutover'],
  };
};

export const extensionPack = defineExtensionPack({
  id: 'requirements-design-workflow', version: '1.0.0', workflows: [requirementsDesignWorkflow], commandManifest: requirementsDesignCommands,
  operationManifest: { createLifecyclePlan: { executionClass: 'pure-planner' } }, operations: { createLifecyclePlan: createRequirementsDesignPlan },
});
export default extensionPack;
