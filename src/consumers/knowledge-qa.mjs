import { assert } from '../errors.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { defineCommandManifest } from '../extensions/command-contract.mjs';
import { compileWorkflowFeatures, defineWorkflowDefinition } from '../workflows/definition.mjs';
import { createReferenceFeature } from '../workflows/reference-feature.mjs';
import { verifySourceManifest } from '../workflows/source-manifest.mjs';
import { resolveLifecycleExecutionPolicy } from '../plugins/runtime/execution-policy.mjs';

const node = (id, dependsOn = [], options = {}) => ({ id, template: 'reference-feature', dependsOn, ...options });
export const knowledgeQaWorkflow = defineWorkflowDefinition({
  id: 'knowledge-qa', version: '1.0.0', profileId: 'composable-workflow',
  routes: {
    ask: [
      node('parse', [], { outputPorts: { question: 'question-v1' }, acceptance: ['Parse the exact question revision and identify answer scope.'] }),
      node('lookup', ['parse'], { outputPorts: { match: 'memory-match-v1' }, acceptance: ['Compare the pinned, valid memory snapshot to the question; report the exact match result.'] }),
    ],
    search: [node('search', [], { sourceType: 'repository', outputPorts: { candidate: 'qa-candidate-v1' }, acceptance: ['Search pinned code and documents; cite exact source paths and digests for the answer candidate.'] })],
    answer: [node('answer', [], { outputPorts: { answer: 'qa-answer-v1' }, outputChecks: [{ portId: 'answer', path: 'claim', operator: 'non-empty' }, { portId: 'answer', path: 'evidence', operator: 'non-empty' }], acceptance: ['Return an evidence backed answer; do not repeat rejected claims.'] })],
    clarify: [node('clarify', [], { outputPorts: { clarification: 'qa-clarification-v1' }, outputChecks: [{ portId: 'clarification', path: 'question', operator: 'non-empty' }], acceptance: ['State what evidence is missing and ask the user one precise clarification question.'] })],
  },
});

export const knowledgeQaCommands = defineCommandManifest({
  protocolVersion: '1.0', id: 'knowledge-qa-commands', profileId: 'composable-workflow', workflowId: knowledgeQaWorkflow.id,
  actions: { ask: { targetKind: 'question', presets: { default: { scope: 'answer-with-evidence', stateChanging: true } } } },
});

export const createKnowledgeQaPlan = ({ intent, project, runId }) => {
  const input = intent.workflowInput;
  assert(input?.sourceManifest && input.sessionId && Number.isInteger(input.questionRevision) && input.questionRevision >= 1, 'QA_INPUT_REQUIRED', 'Question workflow requires pinned sources, session ID, and question revision.');
  const manifest = verifySourceManifest(input.sourceManifest);
  assert(manifest.projectId === project.id, 'SOURCE_PROJECT_MISMATCH', 'Source Manifest Project differs from the workflow Project.');
  const receiver = resolveLifecycleExecutionPolicy({ project, action: intent.action, workflowId: intent.workflowId }).runtimePluginId;
  for (const source of manifest.sources) assert(source.accessScope.includes(receiver), 'SOURCE_RECEIVER_DENIED', `Runtime cannot receive source ${source.sourceId}.`);
  const compile = routeId => compileWorkflowFeatures({ definition: knowledgeQaWorkflow, routeId, templates: { 'reference-feature': createReferenceFeature }, context: { intent } });
  const features = compile('ask');
  const search = compile('search');
  const answer = compile('answer');
  const clarify = compile('clarify');
  const workflow = { id: knowledgeQaWorkflow.id, version: knowledgeQaWorkflow.version, artifactDigest: knowledgeQaWorkflow.artifactDigest };
  const branches = [
    { nodeId: 'lookup', portId: 'match', schemaId: 'memory-match-v1', path: 'hit', equals: true, features: answer },
    { nodeId: 'lookup', portId: 'match', schemaId: 'memory-match-v1', path: 'hit', equals: false, features: search },
    { nodeId: 'search', portId: 'candidate', schemaId: 'qa-candidate-v1', path: 'ready', equals: true, features: answer },
    { nodeId: 'search', portId: 'candidate', schemaId: 'qa-candidate-v1', path: 'ready', equals: false, features: clarify },
  ];
  return {
    run: { runId, profileId: 'composable-workflow', profileConfig: { branches }, features, metadata: { workflow, sourceManifest: manifest, memorySnapshot: input.memorySnapshot ?? [], sessionId: input.sessionId, questionRevision: input.questionRevision } },
    stopCondition: { type: 'qa-response-complete', requiresFeatureCompletion: true, requiredFinalGates: [] },
    protectedOperations: ['publication', 'commit', 'push', 'external-cutover'],
  };
};

export const extensionPack = defineExtensionPack({
  id: 'knowledge-qa-workflow', version: '1.0.0', workflows: [knowledgeQaWorkflow], commandManifest: knowledgeQaCommands,
  operationManifest: { createLifecyclePlan: { executionClass: 'pure-planner' } }, operations: { createLifecyclePlan: createKnowledgeQaPlan },
});
export default extensionPack;
