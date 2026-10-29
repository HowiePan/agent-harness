import { assert } from '../../common/errors.mjs';
import { digestJson } from '../../common/canonical.mjs';

export const DELIVERY_BATCH_POLICY = 'bounded-delivery/2';
const text = value => typeof value === 'string' && value.trim().length > 0;
const list = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const path = value => text(value) && !/[:\\*?\u0000-\u001f]/u.test(value)
  && value.split('/').every(part => part && !['.', '..'].includes(part));
const under = (value, root) => value === root || value.startsWith(`${root}/`);
const overlaps = (a, b) => under(a, b) || under(b, a);

/** A versioned planning contract; existing immutable plans keep their original semantics. */
export const validateDeliveryBatches = (proposal, { maxBatches = 20, obligations = null } = {}) => {
  assert(proposal.deliveryPolicy === DELIVERY_BATCH_POLICY, 'DELIVERY_BATCH_POLICY_REQUIRED', 'An executable bounded delivery policy is required.');
  const batches = proposal.deliveryBatches;
  const reserve = proposal.deliveryBatchReserve;
  assert(Array.isArray(batches) && batches.length > 0 && Number.isInteger(reserve) && reserve >= 1
    && batches.length + reserve <= maxBatches && maxBatches <= 20,
  'DELIVERY_BATCH_CAPACITY', 'Plan at most 20 moderate deliveries including explicit repair/integration reserve; otherwise split the Feature.');
  assert(batches.every(item => item && typeof item === 'object' && !Array.isArray(item))
    && new Set(batches.map(item => item.id)).size === batches.length,
    'DELIVERY_BATCH_ID', 'Delivery IDs must be distinct.');
  const byId = new Map(batches.map(item => [item.id, item]));
  const ancestors = id => {
    const seen = new Set();
    const visiting = new Set();
    const visit = key => {
      assert(byId.has(key) && !visiting.has(key), 'DELIVERY_BATCH_GRAPH', 'Unknown dependency or cyclic delivery graph.');
      if (seen.has(key)) return;
      visiting.add(key);
      for (const dep of byId.get(key).dependsOn) visit(dep);
      visiting.delete(key); seen.add(key);
    };
    visit(id); seen.delete(id); return seen;
  };
  for (const batch of batches) {
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(batch.id) && text(batch.objective)
      && ['acceptance', 'verification', 'obligationIds', 'allowedPaths', 'writePaths', 'dependsOn'].every(key => list(batch[key]))
      && batch.acceptance.length && batch.verification.length && batch.obligationIds.length && batch.allowedPaths.length
      && batch.allowedPaths.every(value => path(value)
        && proposal.allowedPaths.some(root => under(value, root))
        && !(proposal.forbiddenPaths ?? []).some(root => under(value, root)))
      && batch.writePaths.every(value => path(value) && batch.allowedPaths.some(root => under(value, root))
        && !(proposal.forbiddenPaths ?? []).some(root => overlaps(value, root))),
    'DELIVERY_BATCH_SCOPE', 'Each delivery needs a coherent objective, acceptance, verification, exact obligations, dependencies and bounded authorized paths.');
    const size = batch.sizing;
    assert(text(size?.basis) && text(size?.reserve) && text(size?.cohesion)
      && [size?.estimatedUnits, size?.capacityUnits].every(value => Number.isFinite(value) && value > 0)
      && size.estimatedUnits <= size.capacityUnits
      && (size.estimatedUnits / size.capacityUnits >= 0.25 || text(size.smallBatchReason)),
    'DELIVERY_BATCH_SIZING', 'Explain cohesion and estimate against a moderate session capacity; justify unusually small deliveries instead of padding or overpacking.');
    assert(['development', 'acceptance', 'source-exit', 'verification', 'convergence'].includes(batch.phase),
      'DELIVERY_BATCH_PHASE', 'Declare the delivery phase.');
    assert(Array.isArray(batch.checks) && batch.checks.length && batch.checks.every(item => item && typeof item === 'object' && !Array.isArray(item))
      && new Set(batch.checks.map(item => item.id)).size === batch.checks.length,
      'DELIVERY_BATCH_CHECKS', 'Plan executable checks and their complete source/configuration/toolchain inputs.');
    for (const check of batch.checks) assert(text(check.id) && Array.isArray(check.command) && check.command.length && check.command.every(text)
      && check.executionClass === 'deterministic-process'
      && !/^(?:codex|claude|opencode|aider|gemini)(?:\.(?:exe|cmd|bat))?$/iu.test(check.command[0].split(/[\\/]/u).at(-1))
      && !/\b(?:codex\s+(?:exec|e)\b|opencode\s+run\b|claude\s+(?:-p|--print)\b)/iu.test(check.command.join(' '))
      && (check.cwd === undefined || check.cwd === '.' || path(check.cwd))
      && list(check.inputs) && check.inputs.length && check.inputs.every(path)
      && list(check.outputs) && check.outputs.every(path)
      && list(check.covers) && check.covers.length && check.covers.every(id => batch.phase === 'convergence'
        ? batches.some(item => item.obligationIds.includes(id)) : batch.obligationIds.includes(id))
      && typeof check.cacheable === 'boolean' && text(check.environment)
      && (!check.cacheable || (list(check.toolchainFiles) && check.toolchainFiles.length > 0))
      && (batch.phase !== 'convergence' || check.cacheable === false),
    'DELIVERY_BATCH_CHECKS', 'Check coverage must remain in this delivery; final convergence always requires fresh checks.');
    assert(batch.obligationIds.every(id => batch.checks.some(check => check.covers.includes(id))),
      'DELIVERY_BATCH_CHECK_COVERAGE', 'Every assigned obligation needs a planned behavior/contract check.');
  }
  const finals = batches.filter(item => item.phase === 'convergence');
  assert(finals.length === 1 && ancestors(finals[0].id).size === batches.length - 1,
    'DELIVERY_BATCH_CONVERGENCE', 'Exactly one final convergence must depend on every other delivery.');
  const allIds = batches.flatMap(item => item.obligationIds);
  assert(new Set(allIds).size === allIds.length, 'DELIVERY_BATCH_DUPLICATE_OWNER', 'Each obligation has exactly one primary delivery owner.');
  if (obligations) {
    const expected = obligations.map(item => item.id);
    assert(expected.length === allIds.length && expected.every(id => allIds.includes(id)),
      'DELIVERY_BATCH_OBLIGATION_COVERAGE', 'The batches must cover the exact pinned contract, verification, certificate and source-exit obligations.');
  }
  // Proof consumers run after all planned writes to their inputs. A shared file
  // is an ordering edge, never a reason to merge a whole connected component.
  for (const reader of batches) for (const writer of batches) {
    if (reader.id === writer.id) continue;
    if (reader.checks.some(check => check.inputs.some(input => writer.writePaths.some(output => overlaps(input, output))))) {
      assert(ancestors(reader.id).has(writer.id), 'DELIVERY_BATCH_PROOF_ORDER',
        `Proof delivery ${reader.id} must follow writer ${writer.id}; separate broad write authority from stable proof inputs.`);
    }
  }
  return { policy: DELIVERY_BATCH_POLICY, digest: digestJson(batches), reserve, batches: structuredClone(batches) };
};

export const deliveryBatchProjection = (proposal, batch) => batch.phase === 'convergence' ? proposal : {
  ...proposal, contracts: [...batch.acceptance], verification: [...batch.verification],
};

export const deliveryPlanningInstructions = [
  `New implementation plans use deliveryPolicy ${DELIVERY_BATCH_POLICY} and deliveryBatches on every project-owned proposal.`,
  'Preplan moderate coherent deliveries, including real consumers, behavior proofs, source exits, cross-cutting contracts and final verification. Count planned deliveries plus deliveryBatchReserve (at least one) against 20 per Feature. If this does not fit, propose a bounded Feature split; never inflate a delivery to satisfy the count.',
  'Each delivery declares id, phase (development/acceptance/source-exit/verification/convergence), objective, dependsOn, allowedPaths, planned writePaths, exact pinned obligationIds, acceptance, verification, and sizing {basis,cohesion,estimatedUnits,capacityUnits,reserve,smallBatchReason?}. Justify an estimate below one quarter of capacity; never add make-work.',
  'Each delivery declares deterministic-process checks [{id,executionClass,command:[executable,...args],inputs,outputs,covers,environment,cacheable,toolchainFiles?}]. Checks run build/test/verification commands, never an Agent CLI. Inputs enumerate complete behavior/configuration inputs. Reuse additionally requires real resolved toolchain files, never just wrapper binaries or a claimed version. Harness executes checks and seals receipts. Place every planned writer before proofs that read its paths. Exactly one convergence depends on all others and uses cacheable:false. Every obligation has one owner; no arbitrary certificate quota.',
  'Distinct deliveries become distinct native Agent Features with a shared budget ancestry. Independent deliveries may run in parallel only within authorized conflict-free paths and Descriptor limits. A completed delivery never means the original Feature is fully accepted.',
  'Use focused checks with material code changes. Put full-Feature checks at convergence and preserve version Gates in Project policy; do not schedule the whole-project suite for every certificate cohort. Complete proof-input ordering and valid success reuse prevent repetitive broad checks without reducing acceptance.',
  '90% concerns applicability across development scenarios and versions, never single-dispatch completion or a workload quota. Record exceptional scenarios and their fallback without claiming statistical future coverage.',
];
