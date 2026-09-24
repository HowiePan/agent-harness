import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

export const createLocalDevelopmentInvocation = async ({ projectRoot, configPath, controlRoot, dataRoot, cwd = process.cwd() }) => {
  const root = await realpath(projectRoot);
  const current = await realpath(cwd);
  assert(samePath(current, root), 'LOCAL_DEVELOPMENT_PROJECT_CONTEXT_REQUIRED', 'Run the local development command from the exact project checkout, or provide an external Decision.');
  const config = await realpath(configPath);
  const configRelative = relative(root, config);
  assert(configRelative && !configRelative.startsWith('..') && !isAbsolute(configRelative), 'LOCAL_DEVELOPMENT_CONFIG_OUTSIDE_PROJECT', 'Local development configuration must belong to the invoking project checkout.');
  return {
    protocolVersion: '1.0', kind: 'local-development-invocation',
    projectRoot: root, configPath: config,
    controlRoot: resolve(controlRoot), dataRoot: resolve(dataRoot),
  };
};

export const assertLocalDevelopmentInvocation = (invocation, { projectRoot, configPath, controlRoot, dataRoot }) => {
  assert(invocation?.protocolVersion === '1.0' && invocation.kind === 'local-development-invocation'
    && ['projectRoot', 'configPath', 'controlRoot', 'dataRoot'].every(key => typeof invocation[key] === 'string' && isAbsolute(invocation[key]))
    && samePath(invocation.projectRoot, projectRoot)
    && samePath(invocation.configPath, configPath)
    && samePath(invocation.controlRoot, controlRoot)
    && samePath(invocation.dataRoot, dataRoot),
  'LOCAL_DEVELOPMENT_INVOCATION_MISMATCH', 'Local development invocation does not match the exact project and Harness roots.');
  return structuredClone(invocation);
};

export const decisionFromLocalDevelopmentInvocation = (invocation, { action, planDigest, commandId, ...scope }) => {
  assert(invocation?.kind === 'local-development-invocation' && action && planDigest && commandId, 'LOCAL_DEVELOPMENT_DECISION_CONTEXT_REQUIRED', 'Local development Decision requires an exact invocation, action, plan, and command.');
  const context = { ...structuredClone(invocation), planDigest, commandId, ...scope };
  return {
    id: `local-dev-${digestJson(context).slice(0, 24)}`,
    actor: 'project-local-invocation', decision: 'approved', action,
    authorityBasis: 'local-development-invocation', context,
    issuedAt: new Date().toISOString(),
  };
};
