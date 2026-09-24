#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitWorkspaceIdentity } from '../../../../src/common/workspace-identity.mjs';
import { loadLocalSourceBindings } from '../hooks/local-source-hook.mjs';
import { createVisibleLifecycleIntent, encodeVisibleLifecycleIntent } from '../lib/visible-lifecycle-intent.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

export const createLocalSourceLifecycleCommand = async ({ bindingsDir, alias, action, target, workflowId = null, arguments: commandArguments = [], sessionId = process.env.CODEX_SESSION_ID } = {}) => {
  if (typeof alias !== 'string' || !alias || typeof action !== 'string' || !action || typeof target !== 'string' || !target || typeof sessionId !== 'string' || !sessionId) fail('LOCAL_SOURCE_LIFECYCLE_ARGUMENTS_INVALID', 'Local source lifecycle requires alias, action, target, and current Codex session.');
  const { bindings } = await loadLocalSourceBindings(bindingsDir);
  const project = bindings.projects[alias];
  if (!project) fail('LOCAL_SOURCE_PROJECT_ALIAS_UNKNOWN', `Local source project alias is not bound: ${alias}`);
  const identity = await resolveGitWorkspaceIdentity(project.workspaceRoot);
  if (!samePath(identity.commonDir, project.workspaceIdentity?.commonDir)) fail('LOCAL_SOURCE_WORKSPACE_IDENTITY_MISMATCH', 'Bound project Git identity changed.');
  const selectedWorkflow = workflowId ? project.workflows.find(item => item.id === workflowId) : project.workflows.length === 1 ? project.workflows[0] : null;
  if (!selectedWorkflow) fail('LOCAL_SOURCE_WORKFLOW_REQUIRED', 'Select an exact workflow bound to this project.');
  const selectedProject = { ...project, profileId: selectedWorkflow.profileId, extensionId: selectedWorkflow.extensionId, workflowId: selectedWorkflow.id, workflowVersion: selectedWorkflow.version, workflowDigest: selectedWorkflow.artifactDigest };
  const intent = createVisibleLifecycleIntent({ harness: bindings.harness, project: selectedProject, command: { action, target, arguments: commandArguments }, executionWorkspaceRoot: project.workspaceRoot, coordinatorEntrypoint: bindings.harness.coordinatorEntrypoint, codexSessionId: sessionId });
  return { protocolVersion: '1.0', kind: 'local-source-lifecycle-command', alias, projectId: project.projectId, workflowId: selectedWorkflow.id, action, target, commandId: intent.commandId, intentDigest: intent.intentDigest, coordinatorEntrypoint: bindings.harness.coordinatorEntrypoint, coordinationIntent: encodeVisibleLifecycleIntent(intent), executionWorkspaceRoot: project.workspaceRoot };
};

const main = async () => {
  const args = process.argv.slice(2);
  const values = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--bindings-dir', '--alias', '--action', '--target', '--workflow-id'].includes(flag) || !args.length || values[flag]) fail('LOCAL_SOURCE_LIFECYCLE_ARGUMENTS_INVALID', 'Usage: local-source-lifecycle-intent.mjs --bindings-dir <absolute-dir> --alias <bound-alias> --action <action> --target <target> [--workflow-id <id>]');
    values[flag] = args.shift();
  }
  const result = await createLocalSourceLifecycleCommand({ bindingsDir: values['--bindings-dir'], alias: values['--alias'], action: values['--action'], target: values['--target'], workflowId: values['--workflow-id'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ protocolVersion: '1.0', kind: 'local-source-lifecycle-command', ok: false, code: error.code ?? 'UNEXPECTED_ERROR', message: error.message })}\n`);
  process.exitCode = 1;
});
