import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from './canonical.mjs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';
import { safeSegment } from './paths.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/lifecycle-command-plan.schema.json', import.meta.url), 'utf8'));

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'target';

export const lifecyclePlanDigest = plan => digestJson(withoutKeys(plan, ['planDigest']));

export const validateLifecycleCommandPlan = input => {
  assertJsonSchema(input, schema, { code: 'LIFECYCLE_PLAN_INVALID', label: 'Lifecycle Command Plan' });
  assert(input.planDigest === lifecyclePlanDigest(input), 'LIFECYCLE_PLAN_DIGEST_MISMATCH', 'Lifecycle Command Plan digest does not match its contents.');
  assert(typeof input.run.profileId === 'string' && input.run.profileId.length > 0, 'LIFECYCLE_PLAN_PROFILE_INVALID', 'Lifecycle Command Plan profile is invalid.');
  assert(input.protectedOperations.every(operation => typeof operation === 'string' && operation.length > 0), 'LIFECYCLE_PLAN_PROTECTED_OPERATION_INVALID', 'Lifecycle Command Plan protected operations are invalid.');
  return structuredClone(input);
};

export const deriveLifecycleRunId = ({ projectId, intent, sourceDigest, artifactDigest }) => {
  const stable = digestJson({ projectId, intent, sourceDigest, artifactDigest });
  return safeSegment(`${slug(intent.target)}-${slug(intent.action)}-${stable.slice(0, 16)}`, 'runId');
};

/**
 * Build a plan from an Extension-owned compiler result. The compiler is pure from
 * the Authority's perspective: it may return Intent, but it cannot write state.
 */
export const createLifecycleCommandPlan = ({ intent, project, extension, releaseIdentity, sourceDigest, executionWorkspaceRoot, authorityRevision = 0, existingRunId = null, activeRunConflicts = [], compiler }) => {
  assert(intent?.action && intent?.target, 'COMMAND_INTENT_REQUIRED', 'Lifecycle planning requires a resolved Command Intent.');
  assert(project?.id && project.revision && project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_INVALID', 'Lifecycle planning requires a persisted Project Descriptor identity.');
  assert(extension?.id && extension.version && extension.digest && extension.commandManifest, 'LIFECYCLE_PLAN_EXTENSION_INVALID', 'Lifecycle planning requires a verified Extension Pack.');
  assert(releaseIdentity?.verified && releaseIdentity.version && releaseIdentity.artifactDigest, 'LIFECYCLE_PLAN_RELEASE_INVALID', 'Lifecycle planning requires a verified Harness release identity.');
  assert(/^[a-f0-9]{64}$/.test(sourceDigest ?? ''), 'LIFECYCLE_PLAN_SOURCE_DIGEST_REQUIRED', 'Lifecycle planning requires a source snapshot digest.');
  assert(typeof compiler === 'function', 'COMMAND_PLAN_COMPILER_MISSING', `Extension ${extension.id} does not provide a lifecycle plan compiler.`);
  const runId = deriveLifecycleRunId({ projectId: project.id, intent, sourceDigest, artifactDigest: releaseIdentity.artifactDigest });
  const compilerExtension = { id: extension.id, version: extension.version, digest: extension.digest, commandManifest: structuredClone(extension.commandManifest) };
  const compiled = compiler({ intent: structuredClone(intent), project: structuredClone(project), extension: compilerExtension, runId, sourceDigest, executionWorkspaceRoot });
  assert(compiled?.run?.profileId === intent.profileId, 'LIFECYCLE_PLAN_PROFILE_MISMATCH', 'Plan compiler returned a Profile different from the Command Manifest.');
  assert(Array.isArray(compiled.run.features) && compiled.run.features.length > 0, 'LIFECYCLE_PLAN_FEATURES_REQUIRED', 'Plan compiler must return at least one Feature.');
  const body = {
    protocolVersion: '1.0',
    kind: 'lifecycle-command-plan',
    intent: structuredClone(intent),
    project: { id: project.id, revision: project.revision, descriptorDigest: project.descriptorDigest },
    extension: { id: extension.id, version: extension.version, digest: extension.digest, manifestId: extension.commandManifest.id },
    harness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
    authority: { expectedRevision: Number(authorityRevision), existingRunId, activeRunConflicts: structuredClone(activeRunConflicts) },
    run: {
      runId,
      profileId: compiled.run.profileId,
      profileConfig: structuredClone(compiled.run.profileConfig ?? {}),
      features: structuredClone(compiled.run.features),
      sourceDigest,
      artifactDigest: releaseIdentity.artifactDigest,
      executionWorkspaceRoot,
      runtimePluginId: compiled.run.runtimePluginId ?? project.policy?.defaultRuntimePlugin ?? null,
      ...(compiled.run.metadata ? { metadata: structuredClone(compiled.run.metadata) } : {}),
    },
    stopCondition: structuredClone(compiled.stopCondition ?? { type: 'run-ready-to-close' }),
    protectedOperations: [...new Set(compiled.protectedOperations ?? [])].sort(),
  };
  const plan = { ...body, planDigest: lifecyclePlanDigest(body) };
  return validateLifecycleCommandPlan(plan);
};
