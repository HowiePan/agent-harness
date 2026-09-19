import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../../../../common/errors.mjs';
import { ENGINE_STAGES } from '../../policy/index.mjs';
import { validateWorkGraph } from '../../../../kernel/work-graph.mjs';
import { AUTO_CONCURRENCY } from '../../../../common/concurrency.mjs';

export const CARDWORLD_FINAL_GATE_IDS = Object.freeze([
  'context-budget',
  'rust-format',
  'rust-tests-all-targets',
  'rust-clippy-deny-warnings',
  'wasm-release-boundary',
]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const defaultContextBudgetCommand = () => [process.execPath, resolve(packageRoot, 'scripts', 'check-context-budget.mjs')];

const gate = (id, command, cwd, extra = {}) => ({ id, executionClass: 'deterministic-process', scope: 'final', required: true, forceFresh: true, command, cwd, ...extra });
const powershell = process.platform === 'win32' ? 'powershell' : 'pwsh';
const cardWorldTask = (task, ...args) => [powershell, '-NoProfile', '-File', 'scripts/cardworld.ps1', '-Task', task, ...args];
const actionStage = Object.freeze({ requirements: 'requirement-intake', plan: 'version-planning', implement: 'implementation', scope: 'scope-resolution', quality: 'quality', docs: 'docs-closeout', review: 'user-code-review', deliver: 'delivery-receipt' });

export const createCardWorldProjectDescriptor = ({
  id = 'cardworld-engine',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-conversation-runtime',
  runtimePluginIds = [runtimePluginId],
  agentExecutionMode,
  runtimeExtension,
  headlessRuntimeExtension,
  runtimeConfigs: runtimeConfigOverrides = {},
  extensions = [],
  model,
  contextBudgetCommand = defaultContextBudgetCommand(),
  maxConcurrency = AUTO_CONCURRENCY,
  actionExecution = {},
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'CARDWORLD_WORKSPACE_REQUIRED', 'CardWorld descriptor requires an absolute workspaceRoot.');
  assert(actionExecution && typeof actionExecution === 'object' && !Array.isArray(actionExecution), 'CARDWORLD_ACTION_EXECUTION_INVALID', 'CardWorld actionExecution must be an object.');
  if (runtimePluginId !== 'codex-conversation-runtime') assert(agentExecutionMode, 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED', 'Selecting a non-default Runtime requires an explicit agentExecutionMode; headless execution is never inferred from a Runtime ID.');
  const resolvedAgentExecutionMode = agentExecutionMode ?? 'conversation-visible';
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded: ['.git', '.cardworld-local', 'card_world_engine/target', 'card_world_engine/pkg', 'node_modules'] };
  if (remote) workspace.remote = remote;
  const runtimePlugins = [...new Set(runtimePluginIds)];
  assert(runtimePlugins.includes(runtimePluginId), 'PROJECT_RUNTIME_ALLOWLIST_INVALID', 'runtimePluginIds must include the default Runtime.');
  for (const [action, value] of Object.entries(actionExecution)) assert(runtimePlugins.includes(value?.runtimePluginId), 'ACTION_RUNTIME_EXPLICIT_ALLOWLIST_REQUIRED', `Action ${action} Runtime must be explicitly included in runtimePluginIds.`);
  const selectedRuntimeExtensions = [];
  if (runtimePlugins.includes('codex-conversation-runtime')) selectedRuntimeExtensions.push(runtimeExtension === undefined ? { id: 'codex-runtime', version: '1.0.0' } : runtimeExtension);
  if (runtimePlugins.some(id => ['codex-cli-runtime', 'codex-isolated-runtime'].includes(id))) selectedRuntimeExtensions.push(headlessRuntimeExtension === undefined ? { id: 'codex-headless-runtime', version: '1.0.0' } : headlessRuntimeExtension);
  if (!runtimePlugins.some(id => ['codex-conversation-runtime', 'codex-cli-runtime', 'codex-isolated-runtime'].includes(id)) && runtimeExtension) selectedRuntimeExtensions.push(runtimeExtension);
  const runtimeConfigs = Object.fromEntries(runtimePlugins.map(id => {
    const processBacked = ['codex-cli-runtime', 'codex-isolated-runtime'].includes(id);
    const config = { ...(processBacked ? { sandbox: 'workspace-write', ephemeral: true } : {}), ...(runtimeConfigOverrides[id] ?? {}) };
    if (model) config.model = model;
    return [id, config];
  }));
  return {
    id,
    ...(harness ? { harness: structuredClone(harness) } : {}),
    workspace,
    profiles: ['engine-delivery'],
    extensions: [
      { id: 'cardworld-engine-profile', version: '1.0.0' },
      ...selectedRuntimeExtensions.filter(Boolean).map(value => structuredClone(value)),
      ...structuredClone(extensions),
    ],
    policy: {
      agentExecutionMode: resolvedAgentExecutionMode,
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins,
      promptCodecPlugin: 'reference-agent-prompt-codec',
      runtimeConfigs,
      ...(Object.keys(actionExecution).length ? { actionExecution: structuredClone(actionExecution) } : {}),
      recovery: { automaticLineageResolution: true, automaticOrdinaryResume: true, automaticVerifiedHardRecovery: true, preserveSupersededRuns: true },
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
    executionClass: 'agent-reasoning',
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
