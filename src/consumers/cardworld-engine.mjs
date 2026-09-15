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
const actionStage = Object.freeze({ requirements: 'requirement-intake', plan: 'version-planning', implement: 'implementation', scope: 'scope-resolution', quality: 'quality', docs: 'docs-closeout', review: 'user-code-review', deliver: 'delivery-receipt' });

export const createCardWorldProjectDescriptor = ({
  id = 'cardworld-engine',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-conversation-runtime',
  agentExecutionMode,
  runtimeExtension,
  extensions = [],
  model,
  contextBudgetCommand = defaultContextBudgetCommand(),
  maxConcurrency = AUTO_CONCURRENCY,
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'CARDWORLD_WORKSPACE_REQUIRED', 'CardWorld descriptor requires an absolute workspaceRoot.');
  if (runtimePluginId !== 'codex-conversation-runtime') assert(agentExecutionMode, 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED', 'Selecting a non-default Runtime requires an explicit agentExecutionMode; headless execution is never inferred from a Runtime ID.');
  const resolvedAgentExecutionMode = agentExecutionMode ?? 'conversation-visible';
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded: ['.git', '.cardworld-local', 'card_world_engine/target', 'card_world_engine/pkg', 'node_modules'] };
  if (remote) workspace.remote = remote;
  const processBackedRuntime = ['codex-cli-runtime', 'codex-isolated-runtime'].includes(runtimePluginId);
  const runtimeConfig = processBackedRuntime ? { sandbox: 'workspace-write', ephemeral: true, approveForMe: true } : {};
  if (model) runtimeConfig.model = model;
  const selectedRuntimeExtension = runtimeExtension === undefined
    ? (['codex-conversation-runtime', 'codex-cli-runtime', 'codex-isolated-runtime'].includes(runtimePluginId) ? { id: 'codex-runtime', version: '1.0.0' } : null)
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
      agentExecutionMode: resolvedAgentExecutionMode,
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins: [runtimePluginId],
      promptCodecPlugin: 'reference-agent-prompt-codec',
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

const actionPaths = Object.freeze({
  requirements: ['docs/requirements.md', 'docs/versions'],
  plan: ['docs/versions', 'docs/requirements.md'],
  implement: [...CARDWORLD_QUALITY_ALLOWED_PATHS],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
  review: [],
  deliver: [],
});

const makeEngineFeature = ({ action, target, stage, dependsOn = [], allowedPaths, sourcePolicy = 'write', ownerRole = 'operator', qualityReview = false, sourceDigest }) => ({
  id: `${action}/${target}`,
  kind: action,
  ownerRole,
  logicalRoot: `${action}:${target}`,
  laneId: qualityReview ? 'quality' : action,
  acceptance: qualityReview
    ? [
        `Perform a complete read-only review of ${target} against authoritative version documents and the current workspace source digest.`,
        'Run relevant focused checks and cite non-empty evidence for every P0-P3 finding.',
        'Return an exact structured result; do not modify the workspace during review.',
      ]
    : [
        `Complete the declared ${action} scope for ${target}.`,
        'Return structured evidence and an exact changedFiles list.',
      ],
  steps: qualityReview
    ? [{ id: 'review', title: `Review ${target} completely without workspace writes.` }, { id: 'report', title: 'Report every P0-P3 finding and supporting evidence.' }]
    : [{ id: 'execute', title: `Execute ${action} for ${target}.` }],
  dependsOn,
  allowedPaths: qualityReview ? [] : [...allowedPaths],
  forbiddenPaths: ['.git', '.agent-harness-data', '.cardworld-local', 'F:/agent-harness'],
  conflictKeys: [`${target}-${qualityReview ? 'quality-review' : action}`],
  gatePlan: [],
  metadata: {
    stage,
    sourcePolicy,
    target,
    version: target,
    allowDynamicDecomposition: !qualityReview && allowedPaths.length > 0,
    ...(qualityReview ? {
      qualityReview: true,
      qualityRoot: `engine:${target}`,
      reviewRound: 1,
      reviewSourceDigest: sourceDigest,
      qualityContext: { target, version: target },
    } : {}),
  },
});

/**
 * Compile the action-level plan consumed by the neutral lifecycle executor.
 * This function only returns data; it never touches Authority or the workspace.
 */
export const createCardWorldLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'deliver'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const full = intent.action === 'full';
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['engine-delivery'] ?? {}),
    requiredFinalGates: gateIds,
    requireCanonicalDecision: full || (intent.action === 'requirements' && intent.scope !== 'version-planning'),
    requireUserCodeReview: full || intent.action === 'deliver',
    requireFinalQualityReview: full || quality || intent.action === 'deliver',
  };
  let features;
  if (full) {
    const chain = [
      ['requirements-intake', 'requirement-intake', actionPaths.requirements, 'write'],
      ['canonical-requirement', 'canonical-requirement', actionPaths.requirements, 'write'],
      ['plan', 'version-planning', actionPaths.plan, 'write'],
      ['implement', 'implementation', actionPaths.implement, 'write'],
      ['scope', 'scope-resolution', actionPaths.scope, 'write'],
      ['docs', 'docs-closeout', actionPaths.docs, 'write'],
    ];
    features = chain.map(([action, stage, allowedPaths, sourcePolicy], index) => makeEngineFeature({ action, target: intent.target, stage, allowedPaths, sourcePolicy, dependsOn: index ? [`${chain[index - 1][0]}/${intent.target}`] : [] }));
    features.push(makeEngineFeature({ action: 'quality', target: intent.target, stage: 'quality', allowedPaths: [], sourcePolicy: 'review-and-repair', ownerRole: 'reviewer', qualityReview: true, sourceDigest, dependsOn: [`docs/${intent.target}`] }));
    features.push(makeEngineFeature({ action: 'review', target: intent.target, stage: 'user-code-review', allowedPaths: [], sourcePolicy: 'read-only', ownerRole: 'reviewer', dependsOn: [`quality/${intent.target}`] }));
    features.push(makeEngineFeature({ action: 'deliver', target: intent.target, stage: 'delivery-receipt', allowedPaths: [], sourcePolicy: 'read-only', dependsOn: [`review/${intent.target}`] }));
  } else if (quality) {
    features = [makeEngineFeature({ action: 'quality', target: intent.target, stage: 'quality', allowedPaths: [], sourcePolicy: intent.sourcePolicy ?? 'review-and-repair', ownerRole: 'reviewer', qualityReview: true, sourceDigest })];
  } else if (intent.action === 'deliver') {
    const finalQuality = makeEngineFeature({ action: 'quality', target: intent.target, stage: 'quality', allowedPaths: [], sourcePolicy: 'review-and-repair', ownerRole: 'reviewer', qualityReview: true, sourceDigest });
    const delivery = makeEngineFeature({ action: 'deliver', target: intent.target, stage: 'delivery-receipt', allowedPaths: [], sourcePolicy: 'read-only', dependsOn: [finalQuality.id] });
    features = [finalQuality, delivery];
  } else if (intent.action === 'requirements' && intent.scope !== 'version-planning') {
    features = [
      makeEngineFeature({ action: 'requirements-intake', target: intent.target, stage: 'requirement-intake', allowedPaths: actionPaths.requirements }),
      makeEngineFeature({ action: 'canonical-requirement', target: intent.target, stage: 'canonical-requirement', allowedPaths: actionPaths.requirements, dependsOn: [`requirements-intake/${intent.target}`] }),
      makeEngineFeature({ action: 'plan', target: intent.target, stage: 'version-planning', allowedPaths: actionPaths.plan, dependsOn: [`canonical-requirement/${intent.target}`] }),
    ];
  } else {
    const readOnly = intent.sourcePolicy === 'read-only' || ['review', 'deliver'].includes(intent.action);
    const effectiveAction = intent.action === 'requirements' ? 'plan' : intent.action;
    features = [makeEngineFeature({ action: effectiveAction, target: intent.target, stage: actionStage[effectiveAction], allowedPaths: readOnly ? [] : actionPaths[effectiveAction], sourcePolicy: readOnly ? 'read-only' : 'write', ownerRole: effectiveAction === 'review' ? 'reviewer' : 'operator' })];
  }
  for (const feature of features) {
    feature.gatePlan = [...gateIds];
    feature.metadata.scope = intent.scope;
  }
  return {
    run: { runId, profileId: 'engine-delivery', profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin },
    stopCondition: { type: quality ? 'quality-run-complete' : full ? 'engine-full-complete' : 'engine-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: full || quality || intent.action === 'deliver', requiredFinalGates: gateIds },
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
