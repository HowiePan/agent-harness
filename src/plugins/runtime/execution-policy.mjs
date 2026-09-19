import { assert } from '../../errors.mjs';

export const AGENT_EXECUTION_MODES = Object.freeze(['conversation-visible', 'headless']);

export const resolveAgentExecutionMode = policy => {
  const mode = policy?.agentExecutionMode;
  assert(mode, 'PROJECT_AGENT_EXECUTION_MODE_REQUIRED', 'Project Descriptor must explicitly select an Agent execution mode.');
  assert(AGENT_EXECUTION_MODES.includes(mode), 'PROJECT_AGENT_EXECUTION_MODE_INVALID', `Unsupported Agent execution mode: ${mode}`);
  return mode;
};

export const resolveLifecycleExecutionPolicy = ({ project, action, workflowId = null } = {}) => {
  const policy = project?.policy;
  const scoped = action ? (workflowId ? policy?.actionExecution?.[`${workflowId}.${action}`] : null) ?? policy?.actionExecution?.[action] : null;
  const mode = scoped?.agentExecutionMode ?? resolveAgentExecutionMode(policy);
  assert(AGENT_EXECUTION_MODES.includes(mode), 'PROJECT_AGENT_EXECUTION_MODE_INVALID', `Unsupported Agent execution mode: ${mode}`);
  const runtimePluginId = scoped?.runtimePluginId ?? policy?.defaultRuntimePlugin;
  assert(runtimePluginId, 'DEFAULT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} requires an explicit Runtime for ${action ?? 'the default execution policy'}.`);
  assert((policy?.runtimePlugins ?? []).includes(runtimePluginId), 'PROJECT_RUNTIME_DENIED', `Runtime ${runtimePluginId} is not allowed by Project ${project?.id ?? '<unknown>'}.`);
  assert(!scoped || !Object.hasOwn(scoped, 'authorization'), 'LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN', 'Project Descriptor actionExecution is configuration, not user authority; persisted execution authorization is forbidden.');
  return { action: action ?? null, ...(workflowId ? { workflowId } : {}), mode, runtimePluginId, scoped: Boolean(scoped) };
};

export const assertAgentRuntimeCompatible = ({ project, manifest, action, workflowId = null, runtimePluginId, agentExecutionMode }) => {
  assert(manifest?.kind === 'agent-runtime', 'PLUGIN_KIND_MISMATCH', `Plugin ${manifest?.id ?? '<unknown>'} is not an agent-runtime.`);
  const resolved = action !== undefined || runtimePluginId !== undefined || agentExecutionMode !== undefined
    ? resolveLifecycleExecutionPolicy({ project, action, workflowId })
    : { mode: resolveAgentExecutionMode(project?.policy), runtimePluginId: manifest.id, action: null, scoped: false };
  assert(runtimePluginId === undefined || runtimePluginId === resolved.runtimePluginId, 'LIFECYCLE_RUNTIME_POLICY_MISMATCH', `Runtime ${runtimePluginId} does not match the Project execution policy for ${action ?? 'this Run'}.`);
  assert(agentExecutionMode === undefined || agentExecutionMode === resolved.mode, 'LIFECYCLE_EXECUTION_MODE_MISMATCH', `Execution mode ${agentExecutionMode} does not match the Project execution policy for ${action ?? 'this Run'}.`);
  assert(manifest.id === resolved.runtimePluginId, 'LIFECYCLE_RUNTIME_MANIFEST_MISMATCH', `Runtime manifest ${manifest.id} does not match selected Runtime ${resolved.runtimePluginId}.`);
  const mode = resolved.mode;
  const capabilities = new Set(manifest.capabilities ?? []);
  const permissions = new Set(manifest.permissions ?? []);
  if (mode === 'conversation-visible') {
    assert(capabilities.has('user-visible'), 'USER_VISIBLE_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} requires a user-visible Agent Runtime; ${manifest.id} is not user-visible.`);
    assert(capabilities.has('host-orchestrated'), 'HOST_ORCHESTRATED_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} requires a host-orchestrated Agent Runtime; ${manifest.id} cannot be started automatically.`);
    assert(!permissions.has('process.spawn'), 'OPAQUE_AGENT_PROCESS_DENIED', `Project ${project?.id ?? '<unknown>'} forbids process-backed Agent Runtime ${manifest.id}.`);
  } else {
    assert(capabilities.has('headless'), 'HEADLESS_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} explicitly selects headless execution, but Runtime ${manifest.id} does not declare headless capability.`);
  }
  return { ...resolved, userVisible: capabilities.has('user-visible'), hostOrchestrated: capabilities.has('host-orchestrated') };
};

export const assertRuntimeTransportReceipt = ({ project, manifest, receipt, action, workflowId = null, runtimePluginId, agentExecutionMode }) => {
  const policy = assertAgentRuntimeCompatible({ project, manifest, action, workflowId, runtimePluginId, agentExecutionMode });
  assert(receipt?.runtimePluginId === manifest.id, 'RUNTIME_RECEIPT_PLUGIN_MISMATCH', `Runtime Receipt does not match selected Runtime ${manifest.id}.`);
  if (policy.mode === 'conversation-visible') {
    assert(receipt.visibility?.mode === 'user-visible', 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED', 'A conversation-visible Agent Lease requires a user-visible Runtime Receipt.');
    assert(typeof receipt.visibility.surface === 'string' && receipt.visibility.surface.length > 0, 'USER_VISIBLE_RUNTIME_SURFACE_REQUIRED', 'A user-visible Runtime Receipt requires its visible surface kind.');
    assert(typeof receipt.visibility.inspectRef === 'string' && receipt.visibility.inspectRef.length > 0, 'USER_VISIBLE_RUNTIME_INSPECT_REF_REQUIRED', 'A user-visible Runtime Receipt requires an inspectable task reference.');
    assert(typeof receipt.agentId === 'string' && receipt.agentId.length > 0, 'USER_VISIBLE_RUNTIME_AGENT_ID_REQUIRED', 'A user-visible Runtime Receipt must bind the visible child Agent identity.');
    assert(typeof receipt.dispatchId === 'string' && receipt.dispatchId.length > 0, 'USER_VISIBLE_RUNTIME_DISPATCH_ID_REQUIRED', 'A user-visible Runtime Receipt must bind the Dispatch identity.');
    assert(/^[a-f0-9]{64}$/.test(receipt.packetDigest ?? ''), 'USER_VISIBLE_RUNTIME_PACKET_DIGEST_REQUIRED', 'A user-visible Runtime Receipt must bind the immutable Dispatch packet digest.');
    assert(receipt.prompt && /^[a-f0-9]{64}$/.test(receipt.prompt.promptDigest ?? '') && /^[a-f0-9]{64}$/.test(receipt.prompt.packetDigest ?? ''), 'USER_VISIBLE_RUNTIME_PROMPT_RECEIPT_REQUIRED', 'A user-visible Runtime Receipt must bind the exact generated Agent Prompt and Dispatch packet.');
    assert(receipt.prompt.packetDigest === receipt.packetDigest, 'USER_VISIBLE_RUNTIME_PROMPT_PACKET_MISMATCH', 'A user-visible Runtime Receipt Prompt must bind the same immutable Dispatch packet digest.');
    assert(typeof receipt.prompt.codecPluginId === 'string' && /^\d+\.\d+\.\d+$/.test(receipt.prompt.codecPluginVersion ?? '') && typeof receipt.prompt.contractVersion === 'string', 'USER_VISIBLE_RUNTIME_PROMPT_IDENTITY_REQUIRED', 'A user-visible Runtime Receipt must bind the Prompt Codec and Prompt Contract identities.');
  }
  return policy;
};
