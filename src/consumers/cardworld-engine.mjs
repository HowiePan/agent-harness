import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../errors.mjs';
import { ENGINE_STAGES } from '../profiles/engine-delivery.mjs';
import { engineDeliveryProfile } from '../profiles/engine-delivery.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { defineCommandManifest } from '../extensions/command-contract.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';

export const CARDWORLD_FINAL_GATE_IDS = Object.freeze([
  'context-budget',
  'rust-format',
  'rust-tests-all-targets',
  'rust-clippy-deny-warnings',
  'wasm-release-boundary',
]);

export const cardWorldCommandManifest = defineCommandManifest({
  protocolVersion: '1.0',
  id: 'engine-delivery-commands',
  profileId: 'engine-delivery',
  actions: {
    full: { targetKind: 'version', presets: { default: { scope: 'requirement-intake..delivery-receipt', stateChanging: true } } },
    requirements: {
      aliases: ['req'], targetKind: 'version', defaultPreset: 'full', presets: {
        full: { scope: 'requirements..version-plan', stateChanging: true },
        'expand-to-plan': { scope: 'requirement-expansion..version-plan', stateChanging: true },
        'plan-only': { scope: 'version-planning', stateChanging: true },
      },
    },
    plan: { targetKind: 'version', presets: { default: { scope: 'version-planning', stateChanging: true } } },
    implement: { aliases: ['impl'], targetKind: 'version', presets: { default: { scope: 'implementation', stateChanging: true } } },
    scope: { targetKind: 'version', presets: { default: { scope: 'scope-resolution', stateChanging: true } } },
    quality: {
      aliases: ['qa'], targetKind: 'version', defaultPreset: 'full', presets: {
        full: { scope: 'quality', stateChanging: true, sourcePolicy: 'review-and-repair' },
        'review-only': { scope: 'quality', stateChanging: true, sourcePolicy: 'read-only' },
        recheck: { scope: 'quality-recheck', stateChanging: true, sourcePolicy: 'read-only' },
      },
    },
    docs: { targetKind: 'version', presets: { default: { scope: 'docs-closeout', stateChanging: true } } },
    review: { targetKind: 'version', presets: { default: { scope: 'user-code-review', stateChanging: true, sourcePolicy: 'read-only' } } },
    deliver: { targetKind: 'version', presets: { default: { scope: 'delivery-receipt', stateChanging: true } } },
    status: { targetKind: 'version-or-run-id', presets: { default: { scope: 'status', stateChanging: false } } },
    resume: { targetKind: 'version-or-run-id', presets: { default: { scope: 'ordinary-resume', stateChanging: true } } },
    recover: {
      targetKind: 'run-id', defaultPreset: 'assess', presets: {
        assess: { scope: 'recovery-assessment', stateChanging: false },
        hard: { scope: 'hard-recovery', stateChanging: true, approval: 'live-hard-recovery' },
      },
    },
  },
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultContextBudgetCommand = () => [process.execPath, resolve(packageRoot, 'scripts', 'check-context-budget.mjs')];

const gate = (id, command, cwd, extra = {}) => ({ id, scope: 'final', required: true, forceFresh: true, command, cwd, ...extra });
const powershell = process.platform === 'win32' ? 'powershell' : 'pwsh';
const cardWorldTask = (task, ...args) => [powershell, '-NoProfile', '-File', 'scripts/cardworld.ps1', '-Task', task, ...args];

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
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded: ['.git', '.cardworld-local', 'card_world_engine/target', 'card_world_engine/pkg', 'node_modules'] };
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
      gate('rust-format', cardWorldTask('engine-fmt'), '.'),
      gate('rust-tests-all-targets', cardWorldTask('engine-test', '--all-targets'), '.'),
      gate('rust-clippy-deny-warnings', cardWorldTask('engine-clippy'), '.'),
      gate('wasm-release-boundary', cardWorldTask('engine-wasm-release-check'), '.'),
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
  commandManifest: cardWorldCommandManifest,
  operations: {
    createProjectDescriptor: createCardWorldProjectDescriptor,
    compileFeatureGraph: compileCardWorldFeatureGraph,
  },
});

export default extensionPack;
