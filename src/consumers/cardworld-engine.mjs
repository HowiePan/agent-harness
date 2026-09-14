import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../errors.mjs';
import { ENGINE_STAGES } from '../profiles/engine-delivery.mjs';
import { engineDeliveryProfile } from '../profiles/engine-delivery.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { defineCommandManifest } from '../extensions/command-contract.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';
import { AUTO_CONCURRENCY } from '../concurrency.mjs';

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
const actionStage = Object.freeze({ full: 'requirement-intake', requirements: 'requirement-intake', plan: 'version-planning', implement: 'implementation', scope: 'scope-resolution', quality: 'quality', docs: 'docs-closeout', review: 'user-code-review', deliver: 'docs-closeout' });

export const createCardWorldProjectDescriptor = ({
  id = 'cardworld-engine',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-isolated-runtime',
  runtimeExtension,
  extensions = [],
  model,
  contextBudgetCommand = defaultContextBudgetCommand(),
  maxConcurrency = AUTO_CONCURRENCY,
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'CARDWORLD_WORKSPACE_REQUIRED', 'CardWorld descriptor requires an absolute workspaceRoot.');
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded: ['.git', '.cardworld-local', 'card_world_engine/target', 'card_world_engine/pkg', 'node_modules'] };
  if (remote) workspace.remote = remote;
  const runtimeConfig = { sandbox: 'workspace-write', ephemeral: true, approveForMe: true };
  if (model) runtimeConfig.model = model;
  const selectedRuntimeExtension = runtimeExtension === undefined
    ? (['codex-cli-runtime', 'codex-isolated-runtime'].includes(runtimePluginId) ? { id: 'codex-runtime', version: '1.0.0' } : null)
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

const CARDWORLD_QUALITY_ALLOWED_PATHS = Object.freeze([
  'card_world_engine/src',
  'card_world_engine/tests',
  'card_world_engine/Cargo.toml',
  'card_world_engine/Cargo.lock',
  'card_world_web/src',
  'card_world_web/tests',
  'docs/versions/v3/v3.8.4.md',
  'docs/versions/INDEX.md',
  'docs/integration_guide.md',
]);

/**
 * Compile the action-level plan consumed by the neutral lifecycle executor.
 * This function only returns data; it never touches Authority or the workspace.
 */
export const createCardWorldLifecyclePlan = ({ intent, project, runId }) => {
  const gateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const quality = intent.action === 'quality';
  const readOnly = intent.sourcePolicy === 'read-only';
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['engine-delivery'] ?? {}),
    requiredFinalGates: gateIds,
    ...(quality ? { requireCanonicalDecision: false, requireUserCodeReview: false } : {}),
  };
  const feature = {
    id: `${intent.action}/${intent.target}`,
    kind: intent.action,
    ownerRole: quality ? 'reviewer' : 'operator',
    logicalRoot: `${intent.action}:${intent.target}`,
    laneId: quality ? 'quality' : intent.action,
    acceptance: quality
      ? [
          `Review the complete ${intent.target} implementation against the authoritative version documents and current workspace state.`,
          'Run the relevant focused checks and record evidence for every quality conclusion.',
          ...(readOnly ? [] : ['For every actionable P0-P3 finding, report affectedPaths, symbols, contracts, generatedOutputs, and conflictKeys so independent repairs can be scheduled safely.']),
          'Return a complete structured result with accurate changedFiles and any unresolved blockers.',
        ]
      : [
          `Execute the declared ${intent.action} scope for ${intent.target} and return structured evidence.`,
          'If the work naturally decomposes into independent tasks, return followUpFeatures with one scoped item per task so the Harness can schedule non-conflicting work in parallel.',
        ],
    steps: quality ? [
      { id: 'review', title: `Review ${intent.target} implementation, tests, contracts, and release-boundary evidence.` },
      { id: 'report', title: 'Report the final disposition and remaining blockers.' },
    ] : [{ id: 'execute', title: `Execute ${intent.action} for ${intent.target}.` }],
    dependsOn: [],
    allowedPaths: readOnly ? [] : [...CARDWORLD_QUALITY_ALLOWED_PATHS],
    forbiddenPaths: ['.git', '.agent-harness-data', '.cardworld-local', 'F:/agent-harness'],
    conflictKeys: [`${intent.target}-${intent.action}`],
    gatePlan: gateIds,
    metadata: { scope: intent.scope, sourcePolicy: intent.sourcePolicy ?? 'review-and-repair', stage: quality ? 'quality' : actionStage[intent.action], target: intent.target, version: intent.target, allowDynamicDecomposition: !quality && !readOnly },
  };
  return {
    run: { runId, profileId: 'engine-delivery', profileConfig, features: [feature], runtimePluginId: project.policy?.defaultRuntimePlugin },
    stopCondition: { type: 'quality-run-complete', requiresFeatureCompletion: true, requiresAllFindingsResolved: true, requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'hard-recovery', 'deletion', 'privilege-expansion', 'cutover'],
  };
};

export const extensionPack = defineExtensionPack({
  id: 'cardworld-engine-profile',
  version: '1.0.0',
  profiles: [engineDeliveryProfile],
  commandManifest: cardWorldCommandManifest,
  operations: {
    createProjectDescriptor: createCardWorldProjectDescriptor,
    compileFeatureGraph: compileCardWorldFeatureGraph,
    createLifecyclePlan: createCardWorldLifecyclePlan,
  },
});

export default extensionPack;
