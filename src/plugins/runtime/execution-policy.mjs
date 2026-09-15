import { assert } from '../../errors.mjs';

export const AGENT_EXECUTION_MODES = Object.freeze(['conversation-visible', 'headless']);

export const resolveAgentExecutionMode = policy => {
  const mode = policy?.agentExecutionMode;
  assert(mode, 'PROJECT_AGENT_EXECUTION_MODE_REQUIRED', 'Project Descriptor must explicitly select an Agent execution mode.');
  assert(AGENT_EXECUTION_MODES.includes(mode), 'PROJECT_AGENT_EXECUTION_MODE_INVALID', `Unsupported Agent execution mode: ${mode}`);
  return mode;
};

export const assertAgentRuntimeCompatible = ({ project, manifest }) => {
  assert(manifest?.kind === 'agent-runtime', 'PLUGIN_KIND_MISMATCH', `Plugin ${manifest?.id ?? '<unknown>'} is not an agent-runtime.`);
  const mode = resolveAgentExecutionMode(project?.policy);
  const capabilities = new Set(manifest.capabilities ?? []);
  const permissions = new Set(manifest.permissions ?? []);
  if (mode === 'conversation-visible') {
    assert(capabilities.has('user-visible'), 'USER_VISIBLE_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} requires a user-visible Agent Runtime; ${manifest.id} is not user-visible.`);
    assert(capabilities.has('host-orchestrated'), 'HOST_ORCHESTRATED_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} requires a host-orchestrated Agent Runtime; ${manifest.id} cannot be started automatically.`);
    assert(!permissions.has('process.spawn'), 'OPAQUE_AGENT_PROCESS_DENIED', `Project ${project?.id ?? '<unknown>'} forbids process-backed Agent Runtime ${manifest.id}.`);
  } else {
    assert(capabilities.has('headless'), 'HEADLESS_AGENT_RUNTIME_REQUIRED', `Project ${project?.id ?? '<unknown>'} explicitly selects headless execution, but Runtime ${manifest.id} does not declare headless capability.`);
  }
  return { mode, userVisible: capabilities.has('user-visible'), hostOrchestrated: capabilities.has('host-orchestrated') };
};

export const assertRuntimeTransportReceipt = ({ project, manifest, receipt }) => {
  const policy = assertAgentRuntimeCompatible({ project, manifest });
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
