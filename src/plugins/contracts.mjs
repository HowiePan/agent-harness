import { assert } from '../errors.mjs';
import { validateOutputDeclarations } from './execution/managed-output.mjs';

export const PLUGIN_KINDS = Object.freeze(['scheduler', 'agent-runtime', 'model-router', 'tool-broker', 'codec', 'gate-executor', 'artifact-provider', 'storage-provider', 'os-sandbox']);

const requiredMethods = Object.freeze({
  scheduler: ['select'],
  'agent-runtime': ['spawn', 'wait', 'send', 'heartbeat', 'interrupt'],
  'model-router': ['route'],
  'tool-broker': ['invoke'],
  codec: ['encode', 'decode'],
  'gate-executor': ['execute'],
  'artifact-provider': ['resolve'],
  'storage-provider': ['read', 'create', 'transact'],
  'os-sandbox': ['prepare'],
});

export const validatePluginManifest = manifest => {
  assert(manifest?.id && /^[a-z0-9][a-z0-9.-]+$/.test(manifest.id), 'PLUGIN_ID_INVALID', 'Plugin manifest requires a stable lowercase ID.');
  assert(PLUGIN_KINDS.includes(manifest.kind), 'PLUGIN_KIND_INVALID', `Unsupported plugin kind: ${manifest.kind}`);
  assert(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ''), 'PLUGIN_VERSION_INVALID', `Plugin ${manifest.id} requires a semantic version.`);
  assert(Array.isArray(manifest.capabilities), 'PLUGIN_CAPABILITIES_REQUIRED', `Plugin ${manifest.id} requires a capability list.`);
  assert(Array.isArray(manifest.permissions), 'PLUGIN_PERMISSIONS_REQUIRED', `Plugin ${manifest.id} requires a permission list.`);
  const launchesProcess = (manifest.kind === 'agent-runtime' && manifest.permissions.includes('process.spawn')) || (manifest.kind === 'gate-executor' && manifest.capabilities.includes('process'));
  if (manifest.kind === 'agent-runtime' && manifest.permissions.includes('process.spawn')) {
    assert(manifest.capabilities.includes('headless'), 'PROCESS_AGENT_RUNTIME_MUST_BE_HEADLESS', `Process-backed Agent Runtime ${manifest.id} must declare headless capability.`);
    assert(!manifest.capabilities.includes('user-visible'), 'PROCESS_AGENT_RUNTIME_CANNOT_BE_USER_VISIBLE', `Process-backed Agent Runtime ${manifest.id} cannot claim user-visible capability.`);
  }
  if (manifest.kind === 'agent-runtime' && manifest.capabilities.includes('user-visible')) {
    assert(manifest.permissions.includes('agent.conversation'), 'USER_VISIBLE_RUNTIME_CONVERSATION_PERMISSION_REQUIRED', `User-visible Agent Runtime ${manifest.id} requires agent.conversation permission.`);
    assert(!manifest.permissions.includes('process.spawn'), 'USER_VISIBLE_RUNTIME_PROCESS_PERMISSION_DENIED', `User-visible Agent Runtime ${manifest.id} cannot request process.spawn.`);
    assert(manifest.capabilities.includes('host-orchestrated'), 'USER_VISIBLE_RUNTIME_MUST_BE_HOST_ORCHESTRATED', `User-visible Agent Runtime ${manifest.id} must be driven by the interactive host.`);
  }
  if (manifest.kind === 'agent-runtime' && manifest.capabilities.includes('host-orchestrated')) assert(manifest.capabilities.includes('user-visible'), 'HOST_ORCHESTRATED_RUNTIME_MUST_BE_VISIBLE', `Host-orchestrated Runtime ${manifest.id} must be user-visible.`);
  if (launchesProcess) assert(manifest.capabilities.includes('managed-outputs'), 'PLUGIN_MANAGED_OUTPUTS_REQUIRED', `Process plugin ${manifest.id} must declare the managed-outputs capability.`);
  if (manifest.capabilities.includes('managed-outputs')) assert(manifest.execution?.outputs?.length, 'PLUGIN_OUTPUT_DECLARATIONS_REQUIRED', `Plugin ${manifest.id} declares managed-outputs but has no execution.outputs.`);
  const execution = manifest.execution ? {
    ...(manifest.execution.outputs ? { outputs: validateOutputDeclarations(manifest.execution.outputs) } : {}),
    ...(manifest.execution.sandbox ? { sandbox: { mode: manifest.execution.sandbox.mode } } : {}),
  } : null;
  if (execution?.sandbox) assert(['disabled', 'optional', 'required'].includes(execution.sandbox.mode), 'PLUGIN_SANDBOX_MODE_INVALID', `Plugin ${manifest.id} has an invalid sandbox mode.`);
  return { ...structuredClone(manifest), ...(execution ? { execution } : {}), capabilities: [...new Set(manifest.capabilities)].sort(), permissions: [...new Set(manifest.permissions)].sort() };
};

export const validatePluginInstance = (manifest, instance) => {
  for (const method of requiredMethods[manifest.kind]) assert(typeof instance?.[method] === 'function', 'PLUGIN_CONTRACT_INVALID', `Plugin ${manifest.id} is missing ${method}().`);
  if (manifest.kind === 'codec' && manifest.capabilities.includes('agent-prompt')) assert(typeof instance?.compilePrompt === 'function', 'PLUGIN_CONTRACT_INVALID', `Prompt Codec ${manifest.id} is missing compilePrompt().`);
  return instance;
};

export const assertPluginIntent = intent => {
  assert(intent && ['intent', 'event', 'receipt'].includes(intent.type), 'PLUGIN_OUTPUT_INVALID', 'Plugins may return only Intent, Event, or Receipt envelopes.');
  assert(intent.pluginId && intent.pluginVersion, 'PLUGIN_OUTPUT_IDENTITY_REQUIRED', 'Plugin output requires plugin identity.');
  assert(intent.payload && typeof intent.payload === 'object', 'PLUGIN_OUTPUT_PAYLOAD_REQUIRED', 'Plugin output requires an object payload.');
  assert(!Object.hasOwn(intent.payload, 'authority') && !Object.hasOwn(intent.payload, 'authorityWrite'), 'PLUGIN_AUTHORITY_WRITE_REJECTED', 'Plugins cannot return direct Authority writes.');
  return intent;
};

export const envelope = (manifest, type, payload) => ({ type, pluginId: manifest.id, pluginVersion: manifest.version, payload });
