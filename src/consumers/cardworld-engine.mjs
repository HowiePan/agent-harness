import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../errors.mjs';
import { ENGINE_STAGES } from '../profiles/engine-delivery.mjs';
import { engineDeliveryProfile } from '../profiles/engine-delivery.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';

export const CARDWORLD_FINAL_GATE_IDS = Object.freeze([
  'context-budget',
  'rust-format',
  'rust-tests-all-targets',
  'rust-clippy-deny-warnings',
  'wasm-release-boundary',
]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultContextBudgetCommand = () => [process.execPath, resolve(packageRoot, 'scripts', 'check-context-budget.mjs')];

const gate = (id, command, cwd, extra = {}) => ({ id, scope: 'final', required: true, forceFresh: true, command, cwd, ...extra });

export const createCardWorldProjectDescriptor = ({
  id = 'cardworld-engine',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-cli-runtime',
  runtimeExtension,
  extensions = [],
  model,
  contextBudgetCommand = defaultContextBudgetCommand(),
  maxConcurrency = 1,
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'CARDWORLD_WORKSPACE_REQUIRED', 'CardWorld descriptor requires an absolute workspaceRoot.');
  const workspace = { root: workspaceRoot, excluded: ['.git', 'card_world_engine/target', 'card_world_engine/pkg', 'node_modules'] };
  if (remote) workspace.remote = remote;
  const runtimeConfig = { sandbox: 'workspace-write', ephemeral: true, approveForMe: true };
  if (model) runtimeConfig.model = model;
  const selectedRuntimeExtension = runtimeExtension === undefined
    ? (runtimePluginId === 'codex-cli-runtime' ? { id: 'codex-runtime', version: '1.0.0' } : null)
    : runtimeExtension;
  return {
    id,
    ...(harness ? { harness: structuredClone(harness) } : {}),
    workspace,
    profiles: ['engine-delivery'],
    extensions: [
      { id: 'cardworld-engine-profile', version: '1.0.0' },
      ...(selectedRuntimeExtension ? [structuredClone(selectedRuntimeExtension)] : []),
      ...structuredClone(extensions),
    ],
    policy: {
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins: [runtimePluginId],
      runtimeConfigs: { [runtimePluginId]: runtimeConfig },
      maxConcurrency,
    },
    gateRecipes: [
      gate('context-budget', contextBudgetCommand, '.'),
      gate('rust-format', ['cargo', 'fmt', '--all', '--', '--check'], 'card_world_engine'),
      gate('rust-tests-all-targets', ['cargo', 'test', '--all-targets'], 'card_world_engine'),
      gate('rust-clippy-deny-warnings', ['cargo', 'clippy', '--all-targets', '--', '-D', 'warnings'], 'card_world_engine'),
      gate('wasm-release-boundary', ['wasm-pack', 'build', '--release', '--target', 'web'], 'card_world_engine'),
    ],
    artifactProviders: [],
  };
};

export const compileCardWorldFeatureGraph = ({ requirement, features = [] } = {}) => {
  assert(requirement?.id && requirement?.acceptance?.length, 'CANONICAL_REQUIREMENT_REQUIRED', 'CardWorld graph requires exactly one canonical requirement.');
  const canonicalId = `requirement/${requirement.id}`;
  const canonical = {
    id: canonicalId,
    kind: 'canonical-requirement',
    ownerRole: 'planner',
    logicalRoot: `requirement:${requirement.id}`,
    laneId: 'planning',
    acceptance: requirement.acceptance,
    steps: requirement.steps ?? [],
    dependsOn: requirement.dependsOn ?? [],
    allowedPaths: requirement.allowedPaths ?? ['docs/requirements.md'],
    forbiddenPaths: requirement.forbiddenPaths ?? [],
    metadata: { ...(requirement.metadata ?? {}), stage: 'canonical-requirement', canonical: true },
  };
  const compiled = features.map(feature => {
    assert(ENGINE_STAGES.includes(feature.stage), 'ENGINE_STAGE_INVALID', `Unknown CardWorld stage: ${feature.stage}`);
    assert(ENGINE_STAGES.indexOf(feature.stage) > ENGINE_STAGES.indexOf('canonical-requirement'), 'ENGINE_STAGE_BEFORE_CANONICAL', 'Compiled delivery Features must come after the canonical requirement.');
    const dependencies = feature.dependsOn?.length ? feature.dependsOn : [canonicalId];
    return { ...structuredClone(feature), dependsOn: dependencies, metadata: { ...(feature.metadata ?? {}), stage: feature.stage } };
  });
  return validateWorkGraph([canonical, ...compiled]);
};

export const extensionPack = defineExtensionPack({
  id: 'cardworld-engine-profile',
  version: '1.0.0',
  profiles: [engineDeliveryProfile],
  operations: {
    createProjectDescriptor: createCardWorldProjectDescriptor,
    compileFeatureGraph: compileCardWorldFeatureGraph,
  },
});

export default extensionPack;
