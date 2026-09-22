import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyProjectInitializationPlan, createProjectInitializationPlan, loadProjectHarnessConfig } from '../../../src/application/project-initialization.mjs';
import { createHarness, defaultDataRoot } from '../../../src/application/harness.mjs';
import { harnessControlRoot } from '../../../src/common/write-boundary.mjs';
import { loadReleaseIdentity } from '../../../src/application/release-identity.mjs';
import { ExtensionRegistry } from '../../../src/platform/extensions/registry.mjs';
import { newId } from '../../../src/common/canonical.mjs';
import { assert } from '../../../src/common/errors.mjs';

export const initializeVSCodeProject = async ({ configPath = resolve(process.cwd(), 'harness.json'), projectRoot = process.cwd(), decisionPath, controlRoot: controlRootInput, dataRoot: dataRootInput } = {}) => {
  assert(decisionPath, 'VSCODE_INIT_DECISION_REQUIRED', 'VS Code initialization requires an external Authority Decision file.');
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = resolve(dataRootInput ?? defaultDataRoot(controlRoot));
  const releaseIdentity = await loadReleaseIdentity();
  const plan = await createProjectInitializationPlan(configPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode: 'installed' });
  const authorityDecision = JSON.parse(await readFile(resolve(decisionPath), 'utf8'));
  const result = await applyProjectInitializationPlan(plan, { controlRoot, dataRoot, releaseIdentity, commandId: newId('vscode-init'), authorityDecision });
  const loaded = await loadProjectHarnessConfig(configPath, { projectRoot });
  const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot });
  const extensions = await extensionRegistry.loadInstalled();
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, extensions, initializeStorage: false });
  return { ok: true, projectId: loaded.request.binding.projectId, alias: loaded.config.binding.alias ?? loaded.request.binding.projectId, receipt: result.receipt, harness };
};
