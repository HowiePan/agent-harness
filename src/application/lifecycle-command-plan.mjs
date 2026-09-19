import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertJsonSchema } from '../common/json-schema.mjs';
import { safeSegment } from '../common/paths.mjs';
import { resolveLifecycleExecutionPolicy } from '../platform/plugins/runtime/execution-policy.mjs';
import { validateLifecycleExecutionGrant } from '../platform/execution/authorization.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/lifecycle-command-plan.schema.json', import.meta.url), 'utf8'));
const featureSchema = JSON.parse(readFileSync(new URL('../../schemas/feature.schema.json', import.meta.url), 'utf8'));
const schemas = new Map([['feature.schema.json', featureSchema]]);

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'target';

export const lifecyclePlanDigest = plan => digestJson(withoutKeys(plan, ['planDigest']));

export const deriveLogicalTaskKey = ({ projectId, intent, executionWorkspaceRoot, workspaceIdentity = null, workspaceRef = null }) => digestJson({
  projectId,
  workspaceIdentity: workspaceIdentity ?? { type: 'execution-root', root: executionWorkspaceRoot },
  ...(workspaceRef ? { workspaceId: workspaceRef.workspaceId, workflowId: workspaceRef.workflowId, projectIds: workspaceRef.projectIds, executionTargetId: workspaceRef.executionTargetId } : {}),
  profileId: intent.profileId,
  workflowId: intent.workflowId ?? null,
  action: intent.action,
  target: intent.target,
  preset: intent.preset,
  arguments: structuredClone(intent.arguments ?? []),
  selector: intent.selector ?? null,
});

export const validateLifecycleCommandPlan = input => {
  assertJsonSchema(input, schema, { schemas, code: 'LIFECYCLE_PLAN_INVALID', label: 'Lifecycle Command Plan' });
  assert(input.planDigest === lifecyclePlanDigest(input), 'LIFECYCLE_PLAN_DIGEST_MISMATCH', 'Lifecycle Command Plan digest does not match its contents.');
  if (input.workflow) assert(input.intent.workflowId === input.workflow.id && input.run.metadata?.workflow?.artifactDigest === input.workflow.artifactDigest, 'LIFECYCLE_PLAN_WORKFLOW_MISMATCH', 'Lifecycle Plan workflow identity is inconsistent.');
  if (input.workspaceRef) {
    assert(input.project.id === `ws.${input.workspaceRef.workspaceId}.${input.workspaceRef.executionTargetId}` && input.workflow?.id === input.workspaceRef.workflowId, 'LIFECYCLE_PLAN_WORKSPACE_MISMATCH', 'Lifecycle Plan Workspace identity is inconsistent.');
    assert(digestJson(input.run.metadata?.workspaceRef) === digestJson(input.workspaceRef), 'LIFECYCLE_PLAN_WORKSPACE_MISMATCH', 'Run metadata does not pin the Workspace identity.');
  }
  assert(typeof input.run.profileId === 'string' && input.run.profileId.length > 0, 'LIFECYCLE_PLAN_PROFILE_INVALID', 'Lifecycle Command Plan profile is invalid.');
  validateWorkGraph(input.run.features);
  assert(input.protectedOperations.every(operation => typeof operation === 'string' && operation.length > 0), 'LIFECYCLE_PLAN_PROTECTED_OPERATION_INVALID', 'Lifecycle Command Plan protected operations are invalid.');
  if (input.run.executionGrant !== null) validateLifecycleExecutionGrant(input.run.executionGrant);
  assert(input.run.agentExecutionMode === 'headless' || input.run.executionGrant === null, 'VISIBLE_EXECUTION_GRANT_FORBIDDEN', 'Conversation-visible execution must not carry a headless execution grant.');
  return structuredClone(input);
};

export const deriveLifecycleRunId = ({ projectId, intent, sourceDigest, artifactDigest, semanticDigest = null }) => {
  const stable = digestJson({ projectId, intent, sourceDigest, artifactDigest, semanticDigest });
  return safeSegment(`${slug(intent.target)}-${slug(intent.action)}-${stable.slice(0, 16)}`, 'runId');
};

/**
 * Build a plan from an Extension-owned compiler result. The compiler is pure from
 * the Authority's perspective: it may return Intent, but it cannot write state.
 */
export const createLifecycleCommandPlan = ({ intent, project, extension, releaseIdentity, sourceDigest, executionWorkspaceRoot, workspaceIdentity = null, workspaceRef = null, executionConstraintDigest, executionGrant = null, sourceToolBinding = null, compiler }) => {
  assert(intent?.action && intent?.target, 'COMMAND_INTENT_REQUIRED', 'Lifecycle planning requires a resolved Command Intent.');
  assert(project?.id && project.revision && project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_INVALID', 'Lifecycle planning requires a persisted Project Descriptor identity.');
  assert(extension?.id && extension.version && extension.digest && extension.commandManifest, 'LIFECYCLE_PLAN_EXTENSION_INVALID', 'Lifecycle planning requires a verified Extension Pack.');
  assert(releaseIdentity?.verified && releaseIdentity.version && releaseIdentity.artifactDigest, 'LIFECYCLE_PLAN_RELEASE_INVALID', 'Lifecycle planning requires a verified Harness release identity.');
  assert(/^[a-f0-9]{64}$/.test(sourceDigest ?? ''), 'LIFECYCLE_PLAN_SOURCE_DIGEST_REQUIRED', 'Lifecycle planning requires a source snapshot digest.');
  assert(/^[a-f0-9]{64}$/.test(executionConstraintDigest ?? ''), 'EXECUTION_CONSTRAINT_DIGEST_REQUIRED', 'Lifecycle planning requires the trusted execution constraint digest.');
  assert(typeof compiler === 'function', 'COMMAND_PLAN_COMPILER_MISSING', `Extension ${extension.id} does not provide a lifecycle plan compiler.`);
  const provisionalRunId = deriveLifecycleRunId({ projectId: project.id, intent, sourceDigest, artifactDigest: releaseIdentity.artifactDigest });
  const compilerExtension = { id: extension.id, version: extension.version, digest: extension.digest, commandManifest: structuredClone(extension.commandManifest) };
  const compiled = compiler({ intent: structuredClone(intent), project: structuredClone(project), extension: compilerExtension, runId: provisionalRunId, sourceDigest, executionWorkspaceRoot });
  const workflow = extension.workflows?.find(item => item.id === intent.workflowId);
  if (intent.workflowId) assert(workflow && compiled.run.metadata?.workflow?.artifactDigest === workflow.artifactDigest, 'LIFECYCLE_PLAN_WORKFLOW_MISMATCH', 'Compiler output does not bind the selected Workflow Definition.');
  assert(compiled?.run?.profileId === intent.profileId, 'LIFECYCLE_PLAN_PROFILE_MISMATCH', 'Plan compiler returned a Profile different from the Command Manifest.');
  assert(Array.isArray(compiled.run.features) && compiled.run.features.length > 0, 'LIFECYCLE_PLAN_FEATURES_REQUIRED', 'Plan compiler must return at least one Feature.');
  const features = validateWorkGraph(compiled.run.features);
  const executionPolicy = resolveLifecycleExecutionPolicy({ project, action: intent.action, workflowId: intent.workflowId });
  assert(compiled.run.runtimePluginId === undefined || compiled.run.runtimePluginId === executionPolicy.runtimePluginId, 'LIFECYCLE_COMPILER_RUNTIME_OVERRIDE_DENIED', 'Plan compiler cannot override the Runtime selected by the Project action execution policy.');
  assert(compiled.run.agentExecutionMode === undefined || compiled.run.agentExecutionMode === executionPolicy.mode, 'LIFECYCLE_COMPILER_EXECUTION_MODE_OVERRIDE_DENIED', 'Plan compiler cannot override the Agent execution mode selected by the Project action execution policy.');
  const semanticDigest = digestJson({
    intent,
    project: { id: project.id, revision: project.revision, descriptorDigest: project.descriptorDigest },
    workspaceRef,
    extension: { id: extension.id, version: extension.version, digest: extension.digest },
    workflow: workflow ? { id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest } : null,
    harness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
    sourceDigest,
    executionWorkspaceRoot,
    executionPolicy,
    run: { ...withoutKeys(compiled.run, ['runId', 'features']), features, sourceToolBinding },
    stopCondition: compiled.stopCondition ?? { type: 'run-ready-to-close' },
    protectedOperations: [...new Set(compiled.protectedOperations ?? [])].sort(),
  });
  const runId = deriveLifecycleRunId({ projectId: project.id, intent, sourceDigest, artifactDigest: releaseIdentity.artifactDigest, semanticDigest });
  const logicalTaskKey = deriveLogicalTaskKey({ projectId: project.id, intent, executionWorkspaceRoot, workspaceIdentity, workspaceRef });
  const body = {
    protocolVersion: '1.0',
    kind: 'lifecycle-command-plan',
    logicalTaskKey,
    intent: structuredClone(intent),
    project: { id: project.id, revision: project.revision, descriptorDigest: project.descriptorDigest },
    ...(workspaceRef ? { workspaceRef: structuredClone(workspaceRef) } : {}),
    extension: { id: extension.id, version: extension.version, digest: extension.digest, manifestId: extension.commandManifest.id },
    ...(workflow ? { workflow: { id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest } } : {}),
    harness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
    run: {
      runId,
      profileId: compiled.run.profileId,
      profileConfig: structuredClone(compiled.run.profileConfig ?? {}),
      features,
      sourceDigest,
      artifactDigest: releaseIdentity.artifactDigest,
      executionWorkspaceRoot,
      runtimePluginId: executionPolicy.runtimePluginId,
      agentExecutionMode: executionPolicy.mode,
      executionConstraintDigest,
      executionGrant: executionGrant ? validateLifecycleExecutionGrant(executionGrant) : null,
      ...(compiled.run.metadata || sourceToolBinding || workspaceRef ? { metadata: { ...structuredClone(compiled.run.metadata ?? {}), ...(sourceToolBinding ? { sourceToolBinding: structuredClone(sourceToolBinding) } : {}), ...(workspaceRef ? { workspaceRef: structuredClone(workspaceRef) } : {}) } } : {}),
    },
    stopCondition: structuredClone(compiled.stopCondition ?? { type: 'run-ready-to-close' }),
    protectedOperations: [...new Set(compiled.protectedOperations ?? [])].sort(),
  };
  const plan = { ...body, planDigest: lifecyclePlanDigest(body) };
  return validateLifecycleCommandPlan(plan);
};
