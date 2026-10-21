import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { prepareBudgetExtension } from '../kernel/attempt-budget.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { isResumableImplementationSubmission } from './lifecycle-resume.mjs';

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** Budget control is deliberately separate from starting or resuming execution. */
export const verifyImplementationBudgetScope = async ({ harness, state, development, featureId, currentSourceDigest = null }) => {
  const project = await harness.projectRegistry.get(state.projectId);
  const feature = state.features.find(item => item.id === state.submissions.at(-1)?.featureId);
  const submission = state.submissions.at(-1);
  assert((featureId === undefined || featureId === feature?.id)
    && state.metadata?.commandIntent?.action === 'implement' && feature?.metadata?.stage === 'implementation'
    && isResumableImplementationSubmission(state, feature, submission),
  'IMPLEMENTATION_BUDGET_SCOPE_MISMATCH', 'Budget addition requires an unfinished project-owned implementation, not an approval or external dependency.');
  assert(state.metadata?.workspace?.root && samePath(state.metadata.workspace.root, project.workspace.root)
    && samePath(process.cwd(), project.workspace.root), 'IMPLEMENTATION_BUDGET_WORKSPACE_MISMATCH', 'Use the exact registered project checkout.');
  if (development) {
    const manifest = development.manifest;
    await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
      controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot });
    const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
    assert(config.request.binding.projectId === state.projectId && samePath(manifest.projectRoot, project.workspace.root),
      'IMPLEMENTATION_BUDGET_BINDING_MISMATCH', 'Development binding does not own this Run.');
  }
  const observed = currentSourceDigest ?? (await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] })).digest;
  assert(observed === state.sourceDigest, 'IMPLEMENTATION_BUDGET_SOURCE_CHANGED', 'Budget approval must bind the current authoritative project source.');
};

export const previewImplementationBudget = async ({ harness, state, development, request }) => {
  await verifyImplementationBudgetScope({ harness, state, development, featureId: request.featureId });
  return prepareBudgetExtension({ state, ...request });
};
