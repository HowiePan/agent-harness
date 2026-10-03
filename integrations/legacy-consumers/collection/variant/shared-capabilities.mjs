import { assert } from '../../../../src/common/errors.mjs';
import { defineNodeTaskContract } from '../../../../src/common/task-contract.mjs';
import { validateWorkGraph } from '../../../../src/kernel/work-graph.mjs';

const DEFAULT_B1_CAPABILITY = Object.freeze({
  key: 'collection-shared',
  consumers: ['doudizhu', 'gomoku', 'texas-holdem', 'chess', 'tycoon', 'liars-dice', 'junqi', 'bind-and-die', 'go', 'riichi'],
  allowedPaths: ['packages', 'apps', 'docs', 'scripts'],
  acceptance: [
    'Resolve Texas author Schema/compiler gaps and Junqi graph/author-data gaps wherever the pinned public API permits.',
    'Reassess the Liars Dice and Riichi author mappings and every other B1 shared gap against the packaged public API.',
    'Exhaust Collection-owned shared schema, compiler, family kit, runtime, adapter, registry, and verification work for B1.',
    'Preserve the pinned published engine artifact and report remaining public-artifact gaps with black-box evidence.',
  ],
});

const keyPattern = /^[a-z][a-z0-9-]{0,63}$/;
const safeScope = path => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes(':')
  && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');

export const collectionSharedCapabilities = batch => {
  const gameIds = new Set(batch.gameIds ?? []);
  const defaultConsumers = DEFAULT_B1_CAPABILITY.consumers.filter(id => gameIds.has(id));
  const declared = batch.sharedCapabilities ?? (batch.id === 'B1' && defaultConsumers.length
    ? [{ ...DEFAULT_B1_CAPABILITY, consumers: defaultConsumers }] : []);
  const keys = new Set();
  return declared.map(input => {
    assert(keyPattern.test(input.key) && !keys.has(input.key), 'COLLECTION_CAPABILITY_KEY_INVALID', 'Shared capability keys must be unique safe identifiers.');
    keys.add(input.key);
    assert(Array.isArray(input.consumers) && input.consumers.length > 0 && input.consumers.every(id => gameIds.has(id)), 'COLLECTION_CAPABILITY_CONSUMERS_INVALID', `Shared capability ${input.key} must name declared games.`);
    assert(Array.isArray(input.allowedPaths) && input.allowedPaths.length > 0 && input.allowedPaths.every(path => safeScope(path)
      && !path.startsWith('games/') && path !== 'games' && path !== 'engine-artifact.lock.json'), 'COLLECTION_CAPABILITY_PATH_INVALID', `Shared capability ${input.key} needs safe Collection-owned paths.`);
    return structuredClone(input);
  });
};

const taskWithInstructions = (task, extra) => {
  const { taskDigest: _digest, ...body } = task;
  return defineNodeTaskContract({ ...body, instructions: [...body.instructions, ...extra] });
};

const withVerificationOutputs = (feature, outputs) => {
  if (!outputs.length) return feature;
  feature.forbiddenPaths = feature.forbiddenPaths.filter(path => !outputs.some(output => output === path || output.startsWith(`${path}/`)));
  if (feature.metadata?.qualityReview) {
    feature.metadata.qualityContext = { ...feature.metadata.qualityContext, verificationOutputPaths: [...outputs] };
  } else if (feature.metadata?.sourcePolicy !== 'read-only') {
    feature.metadata.verificationOutputPaths = [...outputs];
  }
  return feature;
};

const ownerTask = (capability, ticket = null) => defineNodeTaskContract({
  role: { id: 'capability-owner', description: 'Owns reusable Collection capabilities consumed by multiple game packs.' },
  objective: `Resolve Collection-owned shared capability ${capability.key} for its declared batch consumers.`,
  instructions: [
    'Inspect all consumer gaps and the pinned packaged engine public API before editing.',
    ...(capability.acceptance ?? []),
    'Implement every reusable Collection-owned mapping and contract that the published artifact supports; continue after finding an engine gap.',
    'Do not edit a Game Pack, engine source, artifact lock, or unpublished binding. A true artifact gap needs a consumer-side black-box fixture and Chinese ECR.',
    'Return completed only when collectionRemaining is empty; include changedFiles, verification evidence, and the remaining artifact-gap inventory in the produce output.',
    'If verified shared source changes are complete for this attempt but Collection work remains, return blocked with failureClass collection-shared-incomplete, the exact changedFiles, and collectionRemaining; the Coordinator will continue this owner in the same command.',
    ...(ticket ? [`Resolve the newly reported shared request from ${ticket.gameId}: ${ticket.summary}. A no-change completion must explain why the request is already resolved.`] : []),
  ],
  inputs: [{ id: 'batch-target', source: 'intent', path: 'target', required: true, description: 'The selected batch.' }],
  steps: [
    { id: 'inspect', instruction: 'Classify each consumer gap as Collection-owned, game-owned, or verified public-artifact gap.' },
    { id: 'implement', instruction: 'Implement Collection-owned reusable capabilities and focused regressions.' },
    { id: 'verify', instruction: 'Run affected checks and clean-room checks, then provide exact residual evidence.' },
  ],
  constraints: ['Write only within the owner allowlist.', 'Keep public artifact identity unchanged.', 'Do not claim complete if a Collection-owned capability remains.'],
  acceptance: ['Every Collection-owned shared gap in scope is fixed and verified or explicitly remains an actionable Collection blocker.', ...(capability.acceptance ?? [])],
  evidenceRequirements: ['Cite current-source verification and exact changed files.', 'Cite public-artifact black-box evidence for each remaining engine gap.'],
});

const ownerFeature = ({ batchId, capability, dependsOn = [], round = 0, ticket = null, forbiddenPaths = [], verificationOutputPaths = [] }) => {
  const task = ownerTask(capability, ticket);
  return withVerificationOutputs({
    id: `shared/${batchId}/${capability.key}/${round}`,
    executionClass: 'agent-reasoning', kind: 'shared-capability', ownerRole: task.role.id,
    attemptLimit: 12,
    logicalRoot: `shared:${batchId}:${capability.key}:${round}`, laneId: '_shared',
    acceptance: [...task.acceptance], steps: task.steps.map(step => ({ id: step.id, title: step.instruction })), task,
    dependsOn, allowedPaths: [...capability.allowedPaths], forbiddenPaths: [...forbiddenPaths, 'engine-artifact.lock.json', 'games', 'docs/rules'],
    conflictKeys: [`shared:${capability.key}`], gatePlan: ['collection-shared-verify'],
    metadata: {
      stage: 'shared-capability', batchId, gameId: null, itemId: null, ruleStatus: 'rule-ready',
      capabilityKey: capability.key, capabilityOwner: true, sharedRound: round,
      collectionProgressRetries: 11,
      ...(ticket ? { sharedTicket: structuredClone(ticket) } : {}),
      outputPorts: { produce: 'batch-produce-v1' },
      outputValueSchemas: { produce: { type: 'object', required: ['changedFiles', 'collectionRemaining'], properties: {
        changedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
        collectionRemaining: { type: 'array', items: { type: 'string', minLength: 1 } },
      }, additionalProperties: true } },
    },
  }, verificationOutputPaths);
};

export const extendCollectionFeatures = ({ intent, project, batch, itemIds, features }) => {
  if (!['produce', 'full'].includes(intent.action)) return features;
  const capabilities = collectionSharedCapabilities(batch).filter(capability => capability.consumers.some(id => itemIds.includes(id)));
  if (!capabilities.length) return features;
  const gateIds = new Set((project.gateRecipes ?? []).map(recipe => recipe.id));
  assert(gateIds.has('collection-shared-verify') && gateIds.has('collection-produce-exhaustion-verify'),
    'COLLECTION_SHARED_DESCRIPTOR_STALE', 'The Collection Project Descriptor must be rebound with shared and exhaustion verification gates.');
  const forbiddenPaths = project.workspace?.excluded ?? ['.git', 'runs'];
  const verificationOutputPaths = project.policy?.qualityVerificationOutputs ?? [];
  assert(['.cardworld-local', 'apps/web/dist', 'apps/web/dist-ts', 'apps/mobile/dist',
    '.expo', 'apps/mobile/.expo']
    .every(path => verificationOutputPaths.includes(path)), 'COLLECTION_VERIFICATION_OUTPUTS_REQUIRED',
  'Collection Descriptor must declare the project check:ci and cleanroom verification output paths.');
  const owners = capabilities.map(capability => ownerFeature({
    batchId: batch.id, capability,
    dependsOn: features.filter(feature => feature.metadata.stage === 'rules' && capability.consumers.includes(feature.metadata.gameId)).map(feature => feature.id),
    forbiddenPaths,
    verificationOutputPaths,
  }));
  for (const feature of features) withVerificationOutputs(feature, verificationOutputPaths);
  for (const feature of features.filter(item => item.metadata.stage === 'produce')) {
    const uses = capabilities.filter(capability => capability.consumers.includes(feature.metadata.gameId));
    feature.dependsOn = [...new Set([...feature.dependsOn, ...uses.map(capability => `shared/${batch.id}/${capability.key}/0`)])];
    feature.metadata.capabilityUses = uses.map(capability => capability.key);
    feature.metadata.sharedCapabilityScopes = Object.fromEntries(uses.map(capability => [capability.key, capability]));
    feature.attemptLimit = 12;
    feature.metadata.collectionProgressRetries = 11;
    feature.task = taskWithInstructions(feature.task, [
      'If verified Game Pack changes are complete for this attempt but independent game-owned work remains, return blocked with failureClass collection-game-incomplete, exact changedFiles, and nonempty readyRemaining. Harness will continue this Feature in the same command.',
      'If only a Collection-owned shared capability prevents progress, complete this Feature with a typed sharedCapabilityRequest in the produce output; do not label it engine-artifact.',
      'The request must name a declared capability key, blocked scenario IDs, summary, and evidence. Exhaust independent game-owned work first. Harness will run the owner and a game continuation in this same command.',
      'When all remaining scenarios are verified public-artifact gaps, report blocked with an exhaustive engine-artifact scenario audit. Do not report a complete game while required scenarios remain blocked.',
    ]);
  }
  return validateWorkGraph([...owners, ...features]);
};

export const collectionHandoffAllowed = ({ state, feature, request }) => {
  const round = feature.metadata.sharedRound ?? 0;
  if (round >= 3 || !feature.metadata.sharedCapabilityScopes?.[request.key]) return false;
  if (round === 0) return true;
  const priorOwner = feature.dependsOn.map(id => state.features.find(item => item.id === id)).find(item => item?.metadata?.capabilityOwner && item.metadata.capabilityKey === request.key);
  const ownerSubmission = state.submissions.findLast(item => item.featureId === priorOwner?.id);
  return Boolean(ownerSubmission && ownerSubmission.outputSourceDigest !== ownerSubmission.inputSourceDigest);
};

export const collectionCapabilityFollowUps = ({ state, feature, result }) => {
  if (feature.metadata?.stage === 'shared-capability' && result.status === 'completed' && feature.metadata.sharedRound > 0 && result.changedFiles.length) {
    const consumers = feature.metadata.sharedTicket?.gameId
      ? feature.metadata.sharedTicket.gameId
      : null;
    const scope = state.features.find(item => item.metadata?.sharedCapabilityScopes?.[feature.metadata.capabilityKey])
      ?.metadata.sharedCapabilityScopes[feature.metadata.capabilityKey];
    return (scope?.consumers ?? []).filter(gameId => gameId !== consumers).flatMap(gameId => {
      const prior = state.features.filter(item => item.metadata?.stage === 'produce' && item.metadata.gameId === gameId).at(-1);
      if (!prior || !['completed', 'blocked', 'failed-budget'].includes(prior.state)
        || state.features.some(item => item.metadata?.recheckAfterOwner === feature.id && item.metadata.gameId === gameId)) return [];
      const recheck = structuredClone(prior);
      recheck.id = `produce/${feature.metadata.batchId}/${gameId}/recheck-${feature.metadata.sharedRound}`;
      recheck.logicalRoot = `produce:${feature.metadata.batchId}:${gameId}:recheck-${feature.metadata.sharedRound}`;
      recheck.dependsOn = [feature.id];
      recheck.state = 'pending';
      recheck.metadata.sharedRound = (prior.metadata.sharedRound ?? 0) + 1;
      recheck.metadata.recheckAfterOwner = feature.id;
      delete recheck.metadata.sharedRequest;
      recheck.task = taskWithInstructions(prior.task, [`Shared capability ${feature.metadata.capabilityKey} changed. Recheck every required scenario against the current source and pinned artifact.`]);
      return [recheck];
    });
  }
  if (feature.metadata?.stage !== 'produce' || result.status !== 'completed') return [];
  const request = result.outputs?.produce?.value?.sharedCapabilityRequest;
  if (!request) return [];
  const scope = feature.metadata.sharedCapabilityScopes?.[request.key];
  if (!scope || !collectionHandoffAllowed({ state, feature, request })) return [];
  const round = (feature.metadata.sharedRound ?? 0) + 1;
  const ownerRound = 1 + Math.max(...state.features.filter(item => item.metadata?.capabilityOwner && item.metadata.capabilityKey === request.key)
    .map(item => item.metadata.sharedRound ?? 0));
  const ticket = { ...structuredClone(request), gameId: feature.metadata.gameId };
  const owner = ownerFeature({ batchId: feature.metadata.batchId, capability: scope, dependsOn: [feature.id], round,
    ticket, forbiddenPaths: feature.forbiddenPaths, verificationOutputPaths: feature.metadata.verificationOutputPaths ?? [] });
  owner.id = `shared/${feature.metadata.batchId}/${scope.key}/${ownerRound}`;
  owner.logicalRoot = `shared:${feature.metadata.batchId}:${scope.key}:${ownerRound}`;
  owner.metadata.sharedRound = ownerRound;
  // Each completed handoff is a work checkpoint. The continuation is the only
  // Feature that may declare the game's final scenario disposition.
  const continuation = structuredClone(feature);
  continuation.id = `${feature.id}/continue-${round}`;
  continuation.logicalRoot = `${feature.logicalRoot}:continue-${round}`;
  continuation.dependsOn = [owner.id];
  continuation.state = 'pending';
  continuation.metadata.sharedRound = round;
  continuation.metadata.sharedRequest = ticket;
  continuation.task = taskWithInstructions(feature.task, [`Reassess all required scenarios after shared owner ${owner.id}; do not reuse the prior scenario dispositions without current-source evidence.`]);
  return [owner, continuation];
};

export const collectionExhaustion = state => {
  const issues = [];
  for (const finding of state.findings ?? []) if (finding.status !== 'resolved') issues.push({ featureId: finding.featureId ?? null,
    kind: 'open-finding', state: finding.status });
  const owners = state.features.filter(feature => feature.metadata?.capabilityOwner);
  for (const owner of owners) if (owner.state !== 'completed') issues.push({ featureId: owner.id, kind: 'collection-capability', state: owner.state });
  const games = [...new Set(state.features.filter(feature => feature.metadata?.stage === 'produce').map(feature => feature.metadata.gameId))];
  const engineBlocked = [];
  const passed = [];
  for (const gameId of games) {
    const latest = state.features.filter(feature => feature.metadata?.stage === 'produce' && feature.metadata.gameId === gameId).at(-1);
    const submission = state.submissions?.findLast(item => item.featureId === latest.id);
    const audit = submission?.result?.outputs?.produce?.value?.scenarioAudit;
    if (latest.state === 'completed' && Array.isArray(audit) && audit.length && audit.every(item => item.disposition === 'passed')) passed.push(gameId);
    else if (latest.state === 'blocked' && latest.blocker?.kind === 'engine-artifact'
      && Array.isArray(audit) && audit.length && audit.every(item => item.disposition === 'passed'
        || (item.disposition === 'blocked' && item.blockerKind === 'engine-artifact'))) engineBlocked.push(gameId);
    else issues.push({ featureId: latest.id, kind: latest.blocker?.kind ?? 'unverified', state: latest.state });
  }
  return { onlyEngineRemaining: issues.length === 0 && engineBlocked.length > 0, engineBlocked, passed, collectionIssues: issues };
};
