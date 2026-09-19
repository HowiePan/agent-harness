import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { createReferenceFeature } from '../../flow-kit/reference-feature.mjs';
import { verifySourceManifest } from '../../platform/workflow/source-manifest.mjs';
import { resolveLifecycleExecutionPolicy } from '../../platform/plugins/runtime/execution-policy.mjs';
import { knowledgeQaWorkflow } from './graph/definition.mjs';
import { createAnswerBranches } from './graph/branches.mjs';
import { stopCondition } from './policy/index.mjs';

export const createKnowledgeQaPlan = ({ intent, project, runId }) => {
  const input = intent.workflowInput;
  assert(input?.sourceManifest && input.sessionId && Number.isInteger(input.questionRevision) && input.questionRevision >= 1, 'QA_INPUT_REQUIRED', 'Question workflow requires pinned sources, session ID, and question revision.');
  const manifest = verifySourceManifest(input.sourceManifest);
  assert(manifest.projectId === project.id, 'SOURCE_PROJECT_MISMATCH', 'Source Manifest Project differs from the workflow Project.');
  const receiver = resolveLifecycleExecutionPolicy({ project, action: intent.action, workflowId: intent.workflowId }).runtimePluginId;
  for (const source of manifest.sources) assert(source.accessScope.includes(receiver), 'SOURCE_RECEIVER_DENIED', `Runtime cannot receive source ${source.sourceId}.`);
  const compile = routeId => compileWorkflowFeatures({ definition: knowledgeQaWorkflow, routeId, templates: { 'reference-feature': createReferenceFeature }, context: { intent } });
  const features = compile('ask');
  const branches = createAnswerBranches({ search: compile('search'), answer: compile('answer'), clarify: compile('clarify') });
  const workflow = { id: knowledgeQaWorkflow.id, version: knowledgeQaWorkflow.version, artifactDigest: knowledgeQaWorkflow.artifactDigest };
  return {
    run: { runId, profileId: 'composable-workflow', profileConfig: { branches }, features, metadata: { workflow, sourceManifest: manifest, memorySnapshot: input.memorySnapshot ?? [], sessionId: input.sessionId, questionRevision: input.questionRevision } },
    stopCondition: structuredClone(stopCondition),
    protectedOperations: ['publication', 'commit', 'push', 'external-cutover'],
  };
};
