import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const canonicalize = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  throw Object.assign(new Error(`Visible lifecycle intent does not support ${typeof value}.`), { code: 'VISIBLE_LIFECYCLE_INTENT_CANONICALIZATION_FAILED' });
};

const digestJson = value => createHash('sha256').update(canonicalize(value)).digest('hex');
const nonEmpty = (value, code, message) => {
  if (typeof value !== 'string' || !value.length) throw Object.assign(new Error(message), { code });
  return value;
};
const sha256Pattern = /^[a-f0-9]{64}$/;
const semverPattern = /^\d+\.\d+\.\d+$/;

export const visibleLifecycleIntentDigest = intent => {
  const copy = structuredClone(intent);
  delete copy.intentDigest;
  return digestJson(copy);
};

export const createVisibleLifecycleIntent = ({ harness, project, command, executionWorkspaceRoot, coordinatorEntrypoint, now = () => new Date().toISOString(), ttlMs = 300000 }) => {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 600000) throw Object.assign(new Error('Visible lifecycle intent TTL must be between 1 second and 10 minutes.'), { code: 'VISIBLE_LIFECYCLE_INTENT_TTL_INVALID' });
  const createdAt = now();
  const body = {
    protocolVersion: '1.0',
    kind: 'codex-visible-lifecycle-intent',
    commandId: `lifecycle_${randomUUID()}`,
    harness: {
      controlRoot: nonEmpty(harness?.controlRoot, 'VISIBLE_LIFECYCLE_CONTROL_ROOT_REQUIRED', 'Visible lifecycle intent requires the bound control root.'),
      dataRoot: nonEmpty(harness?.dataRoot, 'VISIBLE_LIFECYCLE_DATA_ROOT_REQUIRED', 'Visible lifecycle intent requires the bound data root.'),
      ...(harness?.memoryRoot ? { memoryRoot: nonEmpty(harness.memoryRoot, 'VISIBLE_LIFECYCLE_MEMORY_ROOT_INVALID', 'Visible lifecycle intent memory root is invalid.') } : {}),
      entrypoint: nonEmpty(harness?.entrypoint, 'VISIBLE_LIFECYCLE_ENTRYPOINT_REQUIRED', 'Visible lifecycle intent requires the bound Harness entrypoint.'),
      coordinatorEntrypoint: nonEmpty(coordinatorEntrypoint, 'VISIBLE_LIFECYCLE_COORDINATOR_REQUIRED', 'Visible lifecycle intent requires the verified Coordinator entrypoint.'),
      release: structuredClone(harness?.release),
    },
    project: {
      projectId: nonEmpty(project?.projectId, 'VISIBLE_LIFECYCLE_PROJECT_REQUIRED', 'Visible lifecycle intent requires a bound Project.'),
      profileId: nonEmpty(project?.profileId, 'VISIBLE_LIFECYCLE_PROFILE_REQUIRED', 'Visible lifecycle intent requires a bound Profile.'),
      extensionId: nonEmpty(project?.extensionId, 'VISIBLE_LIFECYCLE_EXTENSION_REQUIRED', 'Visible lifecycle intent requires a bound Extension.'),
      ...(project?.workspaceId ? { workspaceId: nonEmpty(project.workspaceId, 'VISIBLE_LIFECYCLE_WORKSPACE_ID_REQUIRED', 'Visible lifecycle intent requires Workspace ID.'), workspaceAlias: nonEmpty(project.workspaceAlias, 'VISIBLE_LIFECYCLE_WORKSPACE_ALIAS_REQUIRED', 'Visible lifecycle intent requires Workspace alias.'), executionTargetId: nonEmpty(project.executionTargetId, 'VISIBLE_LIFECYCLE_TARGET_ID_REQUIRED', 'Visible lifecycle intent requires execution target ID.'), ...(project.projectIds ? { projectIds: [...project.projectIds] } : {}) } : {}),
      ...(project?.workflowId ? { workflowId: nonEmpty(project.workflowId, 'VISIBLE_LIFECYCLE_WORKFLOW_INVALID', 'Visible lifecycle intent requires a Workflow ID.'), workflowVersion: nonEmpty(project.workflowVersion, 'VISIBLE_LIFECYCLE_WORKFLOW_INVALID', 'Visible lifecycle intent requires a Workflow version.'), workflowDigest: nonEmpty(project.workflowDigest, 'VISIBLE_LIFECYCLE_WORKFLOW_INVALID', 'Visible lifecycle intent requires a Workflow digest.') } : {}),
    },
    command: {
      action: nonEmpty(command?.action, 'VISIBLE_LIFECYCLE_ACTION_REQUIRED', 'Visible lifecycle intent requires an action.'),
      target: nonEmpty(command?.target, 'VISIBLE_LIFECYCLE_TARGET_REQUIRED', 'Visible lifecycle intent requires a target.'),
      arguments: [...(command?.arguments ?? [])].map(String),
    },
    executionWorkspaceRoot: nonEmpty(executionWorkspaceRoot, 'VISIBLE_LIFECYCLE_WORKSPACE_REQUIRED', 'Visible lifecycle intent requires a verified execution workspace.'),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
  };
  return Object.freeze({ ...body, intentDigest: visibleLifecycleIntentDigest(body) });
};

export const validateVisibleLifecycleIntent = (input, { now = () => new Date().toISOString() } = {}) => {
  const intent = structuredClone(input);
  const allowed = ['protocolVersion', 'kind', 'commandId', 'harness', 'project', 'command', 'executionWorkspaceRoot', 'createdAt', 'expiresAt', 'intentDigest'];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).some(key => !allowed.includes(key))) throw Object.assign(new Error('Visible lifecycle intent has an invalid envelope.'), { code: 'VISIBLE_LIFECYCLE_INTENT_INVALID' });
  if (intent.protocolVersion !== '1.0' || intent.kind !== 'codex-visible-lifecycle-intent') throw Object.assign(new Error('Visible lifecycle intent protocol is unsupported.'), { code: 'VISIBLE_LIFECYCLE_INTENT_PROTOCOL_UNSUPPORTED' });
  nonEmpty(intent.commandId, 'VISIBLE_LIFECYCLE_COMMAND_ID_REQUIRED', 'Visible lifecycle intent requires a command ID.');
  const harnessKeys = ['controlRoot', 'dataRoot', 'memoryRoot', 'entrypoint', 'coordinatorEntrypoint', 'release'];
  if (!intent.harness || Object.keys(intent.harness).some(key => !harnessKeys.includes(key))) throw Object.assign(new Error('Visible lifecycle Harness binding is invalid.'), { code: 'VISIBLE_LIFECYCLE_HARNESS_BINDING_INVALID' });
  for (const key of ['controlRoot', 'dataRoot', 'entrypoint', 'coordinatorEntrypoint']) nonEmpty(intent.harness[key], 'VISIBLE_LIFECYCLE_HARNESS_BINDING_INVALID', `Visible lifecycle Harness binding requires ${key}.`);
  if (intent.harness.memoryRoot) {
    const child = relative(resolve(intent.harness.controlRoot), resolve(intent.harness.memoryRoot));
    if (!isAbsolute(intent.harness.memoryRoot) || child.startsWith('..') || isAbsolute(child)) throw Object.assign(new Error('Visible lifecycle memory root must stay inside the control root.'), { code: 'VISIBLE_LIFECYCLE_MEMORY_ROOT_INVALID' });
  }
  const release = intent.harness.release;
  if (!release || !semverPattern.test(release.version ?? '') || !sha256Pattern.test(release.artifactDigest ?? '') || !release.generationId || !sha256Pattern.test(release.pointerDigest ?? '')) throw Object.assign(new Error('Visible lifecycle release binding is invalid.'), { code: 'VISIBLE_LIFECYCLE_RELEASE_BINDING_INVALID' });
  if (!intent.project || Object.keys(intent.project).some(key => !['projectId', 'profileId', 'extensionId', 'workflowId', 'workflowVersion', 'workflowDigest', 'workspaceId', 'workspaceAlias', 'executionTargetId', 'projectIds'].includes(key))) throw Object.assign(new Error('Visible lifecycle Project binding is invalid.'), { code: 'VISIBLE_LIFECYCLE_PROJECT_BINDING_INVALID' });
  for (const key of ['projectId', 'profileId', 'extensionId']) nonEmpty(intent.project[key], 'VISIBLE_LIFECYCLE_PROJECT_BINDING_INVALID', `Visible lifecycle Project binding requires ${key}.`);
  if (intent.project.workspaceId) {
    for (const key of ['workspaceId', 'workspaceAlias', 'executionTargetId']) nonEmpty(intent.project[key], 'VISIBLE_LIFECYCLE_WORKSPACE_BINDING_INVALID', `Visible lifecycle Workspace binding requires ${key}.`);
    if (intent.project.projectId !== `ws.${intent.project.workspaceId}.${intent.project.executionTargetId}` || intent.project.projectIds && (!Array.isArray(intent.project.projectIds) || !intent.project.projectIds.length || new Set(intent.project.projectIds).size !== intent.project.projectIds.length || intent.project.projectIds.some(id => typeof id !== 'string' || !id.length))) throw Object.assign(new Error('Visible lifecycle Workspace Project scope is invalid.'), { code: 'VISIBLE_LIFECYCLE_WORKSPACE_SCOPE_INVALID' });
  }
  if (intent.project.workflowId) {
    nonEmpty(intent.project.workflowId, 'VISIBLE_LIFECYCLE_WORKFLOW_INVALID', 'Visible lifecycle Workflow ID is required.');
    if (!semverPattern.test(intent.project.workflowVersion ?? '') || !sha256Pattern.test(intent.project.workflowDigest ?? '')) throw Object.assign(new Error('Visible lifecycle Workflow binding is invalid.'), { code: 'VISIBLE_LIFECYCLE_WORKFLOW_INVALID' });
  }
  if (!intent.command || Object.keys(intent.command).some(key => !['action', 'target', 'arguments'].includes(key)) || !Array.isArray(intent.command.arguments) || intent.command.arguments.some(value => typeof value !== 'string')) throw Object.assign(new Error('Visible lifecycle command is invalid.'), { code: 'VISIBLE_LIFECYCLE_COMMAND_INVALID' });
  nonEmpty(intent.command.action, 'VISIBLE_LIFECYCLE_COMMAND_INVALID', 'Visible lifecycle command requires an action.');
  nonEmpty(intent.command.target, 'VISIBLE_LIFECYCLE_COMMAND_INVALID', 'Visible lifecycle command requires a target.');
  nonEmpty(intent.executionWorkspaceRoot, 'VISIBLE_LIFECYCLE_WORKSPACE_REQUIRED', 'Visible lifecycle intent requires an execution workspace.');
  const createdAt = Date.parse(intent.createdAt ?? '');
  const expiresAt = Date.parse(intent.expiresAt ?? '');
  const current = Date.parse(now());
  if (![createdAt, expiresAt, current].every(Number.isFinite) || expiresAt <= createdAt || current < createdAt - 5000 || current >= expiresAt) throw Object.assign(new Error('Visible lifecycle intent is expired or has invalid timestamps.'), { code: 'VISIBLE_LIFECYCLE_INTENT_EXPIRED' });
  if (!sha256Pattern.test(intent.intentDigest ?? '') || intent.intentDigest !== visibleLifecycleIntentDigest(intent)) throw Object.assign(new Error('Visible lifecycle intent digest does not match its contents.'), { code: 'VISIBLE_LIFECYCLE_INTENT_DIGEST_MISMATCH' });
  return Object.freeze(intent);
};

export const encodeVisibleLifecycleIntent = intent => Buffer.from(JSON.stringify(intent), 'utf8').toString('base64url');

export const decodeVisibleLifecycleIntent = (encoded, options) => {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 32768) throw Object.assign(new Error('Visible lifecycle intent encoding is invalid.'), { code: 'VISIBLE_LIFECYCLE_INTENT_ENCODING_INVALID' });
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch (error) { throw Object.assign(new Error('Visible lifecycle intent is not valid encoded JSON.', { cause: error }), { code: 'VISIBLE_LIFECYCLE_INTENT_ENCODING_INVALID' }); }
  return validateVisibleLifecycleIntent(parsed, options);
};
