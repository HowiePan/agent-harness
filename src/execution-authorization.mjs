import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from './canonical.mjs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/lifecycle-execution-grant.schema.json', import.meta.url), 'utf8'));
const constraintSchema = JSON.parse(readFileSync(new URL('../schemas/user-execution-constraints.schema.json', import.meta.url), 'utf8'));
const trustedAdapters = new WeakSet();
const launchCapabilities = new WeakSet();

export const DEFAULT_EXECUTION_CONSTRAINTS = Object.freeze({
  protocolVersion: '1.0',
  kind: 'user-execution-constraints',
  source: 'core-default',
  revision: 1,
  processBackedAgent: 'deny',
  unattended: 'deny',
  decisionLineage: 'core-default-deny',
});

const normalizeConstraints = (input, provider = 'core-default') => {
  const body = {
    protocolVersion: '1.0',
    kind: 'user-execution-constraints',
    source: input?.source ?? provider,
    revision: input?.revision ?? 1,
    processBackedAgent: input?.processBackedAgent ?? 'deny',
    unattended: input?.unattended ?? 'deny',
    decisionLineage: input?.decisionLineage ?? (provider === 'core-default' ? 'core-default-deny' : null),
  };
  const constraints = { ...body, constraintDigest: digestJson(body) };
  assertJsonSchema(constraints, constraintSchema, { code: 'EXECUTION_CONSTRAINT_INVALID', label: 'User Execution Constraints' });
  return Object.freeze(constraints);
};

export const createExecutionAuthorizationAdapter = ({ provider, constraints, authorizeExecution = null, verifyExecutionGrant }) => {
  assert(typeof provider === 'string' && provider.length > 0, 'EXECUTION_AUTHORIZATION_PROVIDER_REQUIRED', 'Execution authorization adapter requires a provider ID.');
  assert(typeof verifyExecutionGrant === 'function', 'EXECUTION_GRANT_VERIFIER_REQUIRED', 'Execution authorization adapter requires a trusted grant verifier.');
  assert(authorizeExecution === null || typeof authorizeExecution === 'function', 'EXECUTION_GRANT_ISSUER_INVALID', 'Execution grant issuer must be a function when provided.');
  const normalized = normalizeConstraints(constraints, provider);
  const adapter = Object.freeze({ provider, adapterVersion: '1.0.0', constraints: normalized, authorizeExecution, verifyExecutionGrant });
  trustedAdapters.add(adapter);
  return adapter;
};

export const isExecutionAuthorizationAdapter = value => Boolean(value && trustedAdapters.has(value));

export const resolveExecutionConstraints = adapter => isExecutionAuthorizationAdapter(adapter)
  ? adapter.constraints
  : normalizeConstraints(DEFAULT_EXECUTION_CONSTRAINTS);

export const executionGrantDigest = grant => digestJson(withoutKeys(grant, ['grantDigest']));

export const sealLifecycleExecutionGrant = input => {
  const body = structuredClone(withoutKeys(input, ['grantDigest']));
  const grant = { ...body, grantDigest: executionGrantDigest(body) };
  assertJsonSchema(grant, schema, { code: 'LIFECYCLE_EXECUTION_GRANT_INVALID', label: 'Lifecycle Execution Grant' });
  return grant;
};

export const validateLifecycleExecutionGrant = input => {
  assertJsonSchema(input, schema, { code: 'LIFECYCLE_EXECUTION_GRANT_INVALID', label: 'Lifecycle Execution Grant' });
  assert(input.grantDigest === executionGrantDigest(input), 'LIFECYCLE_EXECUTION_GRANT_INVALID', 'Lifecycle Execution Grant digest does not match its contents.');
  return structuredClone(input);
};

export const buildExecutionGrantContext = ({ project, intent = null, runId, runtimePluginId, runtimeVersion, executionWorkspaceRoot, sourceDigest, harnessArtifactDigest = null, extensionDigest = null, constraintDigest }) => ({
  projectId: project.id,
  projectRevision: project.revision,
  projectDescriptorDigest: project.descriptorDigest,
  intentDigest: digestJson(intent),
  action: intent?.action ?? null,
  target: intent?.target ?? null,
  scope: intent?.scope ?? null,
  runId,
  runtimePluginId,
  runtimeVersion,
  agentExecutionMode: 'headless',
  executionWorkspaceRoot,
  sourceDigest,
  harnessArtifactDigest,
  extensionDigest,
  constraintDigest,
});

export const issueHeadlessExecutionGrant = async ({ adapter, context, evidence = null }) => {
  assert(isExecutionAuthorizationAdapter(adapter), 'LIFECYCLE_EXECUTION_GRANT_REQUIRED', 'Headless execution requires a trusted host authorization adapter.');
  assert(adapter.constraints.unattended === 'allow-explicit', 'HEADLESS_USER_INTENT_REQUIRED', 'The trusted user constraints deny unattended Agent execution.');
  assert(typeof adapter.authorizeExecution === 'function', 'LIFECYCLE_EXECUTION_GRANT_REQUIRED', 'The trusted host cannot issue a headless execution grant.');
  const grant = await adapter.authorizeExecution({ context: structuredClone(context), evidence: structuredClone(evidence) });
  return validateLifecycleExecutionGrant(grant);
};

export const verifyHeadlessExecutionGrant = async ({ adapter, grant, context, manifest, now = () => new Date().toISOString() }) => {
  const constraints = resolveExecutionConstraints(adapter);
  if ((manifest?.permissions ?? []).includes('process.spawn')) {
    assert(constraints.processBackedAgent === 'allow-explicit', 'PROCESS_BACKED_AGENT_USER_DENIED', 'Trusted user constraints deny process-backed Agent execution.');
  }
  assert(constraints.unattended === 'allow-explicit', 'HEADLESS_USER_INTENT_REQUIRED', 'Trusted user constraints deny unattended Agent execution.');
  assert(isExecutionAuthorizationAdapter(adapter), 'LIFECYCLE_EXECUTION_GRANT_REQUIRED', 'Headless execution requires a trusted host authorization adapter.');
  assert(grant && typeof grant === 'object', 'LIFECYCLE_EXECUTION_GRANT_REQUIRED', 'Headless execution requires a command-scoped Lifecycle Execution Grant.');
  assert(context?.constraintDigest === constraints.constraintDigest, 'EXECUTION_CONSTRAINT_STALE', 'Lifecycle execution context does not match the current trusted user constraints.');
  assert(context?.runtimePluginId === manifest?.id && context?.runtimeVersion === manifest?.version, 'LIFECYCLE_EXECUTION_GRANT_SCOPE_MISMATCH', 'Lifecycle execution context does not match the selected Runtime identity.');
  const validated = validateLifecycleExecutionGrant(grant);
  assert(digestJson(validated.context) === digestJson(context), 'LIFECYCLE_EXECUTION_GRANT_SCOPE_MISMATCH', 'Lifecycle Execution Grant does not match the exact Project, command, Run, Runtime, workspace, and constraint context.');
  assert(Date.parse(validated.expiresAt) > Date.parse(typeof now === 'function' ? now() : now), 'LIFECYCLE_EXECUTION_GRANT_EXPIRED', 'Lifecycle Execution Grant has expired.');
  const verification = await adapter.verifyExecutionGrant({ grant: structuredClone(validated), context: structuredClone(context) });
  assert(verification?.verified === true, 'LIFECYCLE_EXECUTION_GRANT_INVALID', 'The trusted host rejected the Lifecycle Execution Grant.');
  assert(verification.provider === adapter.provider && typeof verification.assertionId === 'string' && verification.assertionId.length > 0, 'LIFECYCLE_EXECUTION_GRANT_INVALID', 'Execution Grant verification requires the trusted provider and an assertion ID.');
  assert(typeof verification.observedAt === 'string' && !Number.isNaN(Date.parse(verification.observedAt)), 'LIFECYCLE_EXECUTION_GRANT_INVALID', 'Execution Grant verification requires a valid observation timestamp.');
  return { grant: validated, verification: structuredClone(verification), constraints };
};

export const createAgentRuntimeLaunchCapability = ({ grantDigest, runtimePluginId, dispatchId, packetDigest }) => {
  const capability = Object.freeze({ grantDigest, runtimePluginId, dispatchId, packetDigest });
  launchCapabilities.add(capability);
  return capability;
};

export const assertAgentRuntimeLaunchCapability = (capability, { grantDigest, runtimePluginId, dispatchId, packetDigest }) => {
  assert(capability && launchCapabilities.has(capability), 'AGENT_RUNTIME_LAUNCH_CAPABILITY_REQUIRED', 'Process-backed Agent Runtime launch requires a Core-issued capability.');
  assert(capability.grantDigest === grantDigest && capability.runtimePluginId === runtimePluginId && capability.dispatchId === dispatchId && capability.packetDigest === packetDigest, 'AGENT_RUNTIME_LAUNCH_CAPABILITY_MISMATCH', 'Agent Runtime launch capability does not match the Grant, Runtime, Dispatch, and packet.');
  return capability;
};
