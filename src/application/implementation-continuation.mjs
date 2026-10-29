import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { HANDOFF_CORRECTION_POLICY } from './implementation-handoff.mjs';
import { buildImplementationWorkBatch } from './implementation-work-batch.mjs';
import { validateDeliveryBatches, DELIVERY_BATCH_POLICY } from '../flows/delivery-lifecycle/delivery-batches.mjs';
import { deliveryBatchFeedback } from '../flows/delivery-lifecycle/delivery-feedback.mjs';
import { fingerprintDeliveryPaths } from './delivery-verification.mjs';
import { mergeImplementationObligations } from './implementation-obligations.mjs';

export const ACCEPTANCE_CONTINUATION_POLICY = 'approved-obligation-progress/1';
const obligation = (kind, key, detail) => ({ id: `obligation:${digestJson({ kind, key })}`, kind, key, ...detail });
const completed = checkpoint => checkpoint.status === 'completed' && checkpoint.evidence?.length > 0;

/** Resolve only hash-pinned local plan data, never a conversational replacement plan. */
export const buildImplementationContinuation = async (state, feature, workspaceRoot, { readPinnedBytes = null } = {}) => {
  const proposal = feature.metadata?.deliveryOwnerProposal ?? feature.metadata?.approvedProposal;
  if (feature.metadata?.stage !== 'implementation' || !proposal) return null;
  const typed = feature.metadata.approvedDeliveryPlan;
  const planned = proposal.deliveryPolicy === DELIVERY_BATCH_POLICY;
  const readPinned = async ref => {
    assert(ref?.path && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''),
      'IMPLEMENTATION_CONTINUATION_PIN_REQUIRED', 'Referenced implementation inputs require a pinned path and SHA-256.');
    const bytes = readPinnedBytes ? await readPinnedBytes(ref)
      : await readFile(assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, ref.path), 'implementation input'));
    assert(sha256(bytes) === ref.sha256, 'IMPLEMENTATION_CONTINUATION_INPUT_STALE', `Implementation input changed: ${ref.path}`);
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  const expanded = typed?.expandedPlan ? await readPinned(typed.expandedPlan) : null;
  const dereference = ref => {
    const [path, pointer] = ref.split('#');
    assert(expanded && path === typed.expandedPlan.path && pointer?.startsWith('/'),
      'IMPLEMENTATION_CONTINUATION_REFERENCE_INVALID', 'Implementation references must resolve inside the pinned expanded plan.');
    const value = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce((current, part) => current?.[part], expanded);
    assert(value !== undefined, 'IMPLEMENTATION_CONTINUATION_REFERENCE_MISSING', `Missing approved reference: ${ref}`);
    return structuredClone(value);
  };
  let sourceOwner = proposal;
  const ancestors = new Set();
  while (sourceOwner.splitFrom) {
    assert(!ancestors.has(sourceOwner.id), 'DELIVERY_BATCH_SOURCE_ANCESTRY', 'Cyclic source-obligation ancestry.');
    ancestors.add(sourceOwner.id);
    sourceOwner = typed.proposedFeatures?.find(item => item.id === sourceOwner.splitFrom);
    assert(sourceOwner, 'DELIVERY_BATCH_SOURCE_ANCESTRY', 'Missing source-obligation convergence owner.');
  }
  const resolveContracts = item => (item.contracts ?? []).flatMap(item => typeof item === 'string' && item.includes('#/')
    ? dereference(item) : [item]);
  const resolveVerification = item => (item.verification ?? []).map(item => item?.specificationRef ? dereference(item.specificationRef) : item);
  const contracts = resolveContracts(sourceOwner);
  const verification = resolveVerification(sourceOwner);
  const sourced = (kind, key, detail, collection, resolvedIndex, owner = sourceOwner) => obligation(kind, key, {
    ...detail,
    ...(planned ? { sourceOccurrences: [{ proposalId: owner.id, collection, resolvedIndex,
      ...(collection === 'contracts' ? { declarationRefs: (owner.contracts ?? []).filter(value => typeof value === 'string' && value.includes('#/')) } : {}) }] } : {}),
  });
  const sources = (expanded?.sourceLifecycleContract?.sources ?? []).filter(item => item.lastExitFeature === sourceOwner.id);
  const inventory = typed?.sourceInventory ? await readPinned(typed.sourceInventory) : null;
  const matrix = inventory?.mixedAggregateContract?.certificateProductionContract?.aggregateCertificates ?? [];
  const aggregates = new Map((inventory?.mixedAggregateContract?.aggregates ?? []).map(item => [item.source_symbol, item]));
  let obligations = [
    ...contracts.map((item, index) => sourced('contract', item, { description: item }, 'contracts', index)),
    ...verification.map((item, index) => sourced('verification', item, { specification: item }, 'verification', index)),
    ...matrix.filter(item => item.capabilityProducer === sourceOwner.id).map((item, index) => {
      const aggregate = aggregates.get(item.sourceSymbol);
      return sourced('aggregate-certificate', item.sourceSymbol, {
        sourceSha256: item.sourceSha256, memberCount: item.memberCount,
        members: aggregate?.complete_source_members ?? [], assertions: item.requiredAssertions,
        finalPaths: [...new Set((aggregate?.member_conversions ?? []).map(member => member.target_path))],
        nativeDependencies: item.nativeDependencies,
      }, 'aggregate-certificates', index);
    }),
    ...sources.map((item, index) => sourced('source-exit', item.sourcePath, { finalPaths: item.finalPaths }, 'source-exits', index)),
  ];
  if (planned) obligations = mergeImplementationObligations(obligations);
  if (sourceOwner.id !== proposal.id) {
    assert(Array.isArray(proposal.deliveryObligationIds) && proposal.deliveryObligationIds.length
      && proposal.deliveryObligationIds.every(id => obligations.some(item => item.id === id)),
    'DELIVERY_BATCH_SOURCE_ASSIGNMENT', 'A split child must explicitly assign real pinned source-owner obligations.');
    const own = [...resolveContracts(proposal).map((item, index) => sourced('contract', item, { description: item }, 'contracts', index, proposal)),
      ...resolveVerification(proposal).map((item, index) => sourced('verification', item, { specification: item }, 'verification', index, proposal))];
    const selected = [...obligations.filter(item => proposal.deliveryObligationIds.includes(item.id)), ...own];
    obligations = planned ? mergeImplementationObligations(selected) : [...new Map(selected.map(item => [item.id, item])).values()];
  }
  const batch = feature.metadata.deliveryBatch;
  if (planned && proposal.deliveryBatches) validateDeliveryBatches(proposal, { obligations });
  else if (planned) assert(feature.metadata.deliveryPlanBinding?.obligationSetDigest === digestJson(obligations.map(item => item.id).sort()),
    'DELIVERY_BATCH_OBLIGATION_COVERAGE', 'Compiled deliveries must still cover the exact pinned obligations.');
  const historyIds = new Set(planned ? state.features.filter(item => item.logicalRoot === feature.logicalRoot).map(item => item.id) : [feature.id]);
  const history = state.submissions.filter(item => historyIds.has(item.featureId) && !item.supersededAt);
  const latest = history.at(-1);
  const inherited = state.metadata?.approvedPlan?.amendmentBaseline?.progress?.[feature.metadata.amendmentProgressBaselineOwner]
    ?? feature.metadata.amendmentProgressBaseline;
  const checkpoints = new Map([
    ...(inherited?.checkpoints ?? []).map(checkpoint => [checkpoint.id, checkpoint]),
    ...history.flatMap(item => (item.result?.checkpoints ?? []).map(checkpoint => [checkpoint.id, checkpoint])),
  ]);
  const attempt = state.attempts?.[latest?.attemptBudgetKey ?? `${feature.logicalRoot}:progress`]
    ?? state.attempts?.[`${feature.logicalRoot}:${latest?.result?.failureClass}`];
  const targetObligations = batch ? obligations.filter(item => batch.obligationIds.includes(item.id)) : obligations;
  const targets = [...new Set([
    ...targetObligations.flatMap(item => (item.nativeDependencies ?? []).map(dep => dep.targetPath)),
    ...targetObligations.flatMap(item => item.finalPaths ?? []),
    ...(batch?.writePaths ?? []),
  ])].filter(path => typeof path === 'string' && !path.includes(':') && !path.includes('\\')
    && path.split('/').every(part => part && !['.', '..', 'tests', 'test', 'docs', 'scripts'].includes(part))
    && feature.allowedPaths?.some(scope => path === scope || path.startsWith(`${scope}/`))
    && !(feature.forbiddenPaths ?? []).some(scope => path === scope || path.startsWith(`${scope}/`)));
  const implementationSteps = await Promise.all(targets.map(async targetPath => {
    const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, targetPath), 'implementation target');
    let baselineSha256 = null;
    let targetKind = batch?.writePaths.includes(targetPath) ? 'path' : 'file';
    try {
      if ((await stat(path)).isDirectory()) { targetKind = 'directory'; baselineSha256 = await fingerprintDeliveryPaths(workspaceRoot, [targetPath]); }
      else baselineSha256 = sha256(await readFile(path));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { id: `implementation-step:${digestJson(targetPath)}`, targetPath, baselineSha256,
      ...(targetKind !== 'file' ? { targetKind } : {}),
      parentObligations: targetObligations.filter(item => item.finalPaths?.includes(targetPath)
        || item.nativeDependencies?.some(dep => dep.targetPath === targetPath)).map(item => item.id) };
  }));
  // This selects the next development candidate, never certifies acceptance.
  // A carried partial implementation must not restart at its already verified
  // target merely because every target file now exists.
  const verifiedTarget = step => step.baselineSha256 !== null
    && completed(checkpoints.get(step.id) ?? {})
    && completed(checkpoints.get(`${step.id}:focused-verification`) ?? {});
  const nextImplementationStep = implementationSteps.find(step => !verifiedTarget(step)) ?? null;
  const closedIds = new Set(history.flatMap(item => (item.result?.checkpoints ?? [])
    .filter(completed).map(checkpoint => checkpoint.id)));
  let workBatch = buildImplementationWorkBatch({ obligations: targetObligations, steps: implementationSteps,
    next: nextImplementationStep, verified: verifiedTarget, closedIds, history,
    isAllowedPath: path => feature.allowedPaths?.some(scope => path === scope || path.startsWith(`${scope}/`))
      && !(feature.forbiddenPaths ?? []).some(scope => path === scope || path.startsWith(`${scope}/`)) });
  if (batch) {
    const definition = Object.fromEntries(Object.entries(batch).filter(([key]) => !['policy', 'planDigest'].includes(key)));
    assert(feature.metadata.deliveryPlanBinding?.batchDigest === digestJson(definition)
      && batch.planDigest === feature.metadata.deliveryPlanBinding.planDigest,
    'DELIVERY_BATCH_DISPATCH_MISMATCH', 'The native delivery must bind the exact approved plan.');
    const ids = new Set(batch.obligationIds);
    const targets = implementationSteps.filter(step => step.parentObligations.some(id => ids.has(id))
      || batch.writePaths.includes(step.targetPath));
    const paths = [...new Set(obligations.filter(item => ids.has(item.id)).flatMap(item => [
      ...(item.finalPaths ?? []), ...(item.nativeDependencies ?? []).map(dep => dep.targetPath),
    ]).concat(batch.writePaths))];
    workBatch = { ...workBatch, ...structuredClone(batch),
      targetStepIds: targets.map(item => item.id),
      pendingTargetStepIds: targets.filter(item => !verifiedTarget(item)).map(item => item.id),
      supportingPaths: paths.filter(path => !targets.some(item => item.targetPath === path)),
      unavailableDependencyPaths: paths.filter(path => !feature.allowedPaths.some(root => path === root || path.startsWith(`${root}/`))),
      certificateCandidateIds: workBatch.certificateCandidateIds.filter(id => ids.has(id)),
      acceptanceStatus: 'assigned-obligations-require-bound-proof' };
  }
  const visibleIds = batch ? new Set([...batch.obligationIds, ...workBatch.targetStepIds,
    ...workBatch.targetStepIds.map(id => `${id}:focused-verification`)]) : null;
  return {
    policy: ACCEPTANCE_CONTINUATION_POLICY, proposalId: proposal.id, sourceDigest: state.sourceDigest,
    pinnedInputs: { expandedPlan: typed?.expandedPlan ?? null, sourceInventory: typed?.sourceInventory ?? null },
    obligations: batch ? obligations.filter(item => batch.obligationIds.includes(item.id)) : obligations,
    ...(batch ? { originalObligationSummary: Object.fromEntries([...new Set(obligations.map(item => item.kind))]
      .map(kind => [kind, obligations.filter(item => item.kind === kind).length])),
      ...(batch.phase === 'convergence' ? { originalObligationIds: obligations.map(item => item.id) } : {}) } : {}),
    verification: batch ? batch.verification : verification,
    correctionPolicy: { id: HANDOFF_CORRECTION_POLICY, maxCorrectionsPerInvocation: 1 },
    implementationSteps: batch ? implementationSteps.filter(item => workBatch.targetStepIds.includes(item.id)) : implementationSteps,
    nextImplementationStep: batch ? implementationSteps.find(item => workBatch.pendingTargetStepIds.includes(item.id)) ?? null : nextImplementationStep,
    workBatch,
    ...(batch ? { deliveryFeedback: deliveryBatchFeedback(state, feature) } : {}),
    externalPrerequisites: structuredClone(expanded?.externalPrerequisites ?? []),
    history: [...(inherited?.history ?? []), ...history].slice(-3).map(item => ({ submissionId: item.submissionId,
      inputSourceDigest: item.inputSourceDigest, outputSourceDigest: item.outputSourceDigest,
      changedFiles: item.changedFiles, summary: item.result.summary, blocker: item.result.blocker ?? null,
      notMade: item.result.notMade ?? [], checkpoints: (item.result.checkpoints ?? []).filter(checkpoint => !visibleIds || visibleIds.has(checkpoint.id)), evidenceRefs: item.evidenceRefs })),
    baselineCheckpoints: [...checkpoints.values()].filter(checkpoint => !visibleIds || visibleIds.has(checkpoint.id)),
    ...(inherited ? { priorRunProgress: { runId: inherited.runId, sourceDigest: inherited.sourceDigest,
      attempts: inherited.attempts, evidenceStatus: 'historical-baseline-reverify-affected-evidence' } } : {}),
    budget: attempt ? { used: attempt.budgetKind === 'progress' ? attempt.used : attempt.failures,
      limit: attempt.limit, exhausted: attempt.exhausted } : null,
    instructions: batch ? [
      `This native Agent delivers approved batch ${batch.id}, phase ${batch.phase}, within the original proposal ${proposal.id}.`,
      'Complete the cohesive workBatch objective, assigned obligationIds, real consumers and declared checks. A completed planned batch is a valid handoff to another native Agent; it is not full original Feature acceptance. Do not volunteer one-file/one-certificate slices or absorb other batches.',
      'Use exact approved obligation IDs as completed checkpoints with real evidence. Every planned check also needs a checkpoint delivery-check:<check.id> with its evidence file paths. Harness captures fingerprints of inputs and outputs; only an exact attested environment match can enable cache reuse. Mandatory convergence checks run fresh.',
      'Preserve scope, source-retirement prerequisites, genuine external/permission blockers and shared retry budgets. Local feasible work may continue independently of a prerequisite that only guards a later protected action. Never fabricate proof or turn a receipt into write authority.',
      'On a real interruption or reproduced defect retain verified partial progress and exact next actions. Repair related failures within this moderate batch and its authorized scope. Report capacity mismatch with sizing evidence; never pad work or silently grow the batch.',
      'At convergence verify all original acceptance obligations against current inputs; reject stale upstream proof, run every mandatory final check and report original completedContracts only when the whole proposal is accepted.',
    ] : [
      'The execution unit is this complete Feature, not one patch, implementation-step or certificate. In the same Agent session, group related unresolved obligations and their owner dependencies into a coherent acceptance batch; when multiple related obligations are feasible, work through them together and continue toward full Feature completion. Preserve the approved dependency order, scope and acceptance criteria; a batch creates no new Feature, Lease, authority or budget.',
      'Do not voluntarily return after one local fix, focused test, implementation-step or closed certificate while further approved work is feasible. Any permission to report partial progress is a recovery fallback, not a planned stopping point or a one-item quota. Repair supporting mechanisms and continue closing their affected acceptance obligations in this session. Missing code, remaining certificates, task size, an elapsed work interval or a self-chosen batch boundary alone does not justify returning blocked.',
      'Run focused checks after material changes. Consolidate broad verification at a stable acceptance batch or Feature boundary unless the approved verification contract requires it sooner, a new failure needs diagnosis, or later source changes invalidate prior evidence. Bind acceptance evidence to the final source and run every mandatory final check; never reuse stale results or reduce required coverage to save time.',
      'Use workBatch as the connected delivery frontier, not nextImplementationStep as a one-file assignment. Resolve its targetStepIds and obligationIds through the existing arrays; implement owners, real consumers and their behavior proofs together in approved dependency order. Do not split a connected chain at a filename or a self-chosen count. unavailableDependencyPaths confer no write authority; diagnose their exact ownership or prerequisite. The batch is guidance within the same complete Feature, never a completion quota.',
      'Try certificateCandidateIds against independently executing final receivers before expanding into unrelated targets. These IDs mean only that historical target checkpoints exist, never that behavior or compatibility is certified. If a candidate still needs an owner, authored program, inverse or continuation behavior, implement that missing in-scope dependency in the same session and close the original obligation when proved. Do not postpone every certificate until all target files exist or fabricate a certificate to improve progress counts.',
      'If workBatch.consecutiveDevelopmentHandoffs is nonzero, address the outstanding acceptance gap rather than repeat a file-only delivery pattern. Carry a compact delta to the existing gap matrix; do not repeatedly dump or recreate the full pinned inventory. Use focused checks while developing; do not spend the remaining context re-running unchanged known-failing broad checks unless required by the approved contract or changed inputs. At a stable boundary run required broad checks once against the final source. A real context limit remains a valid handoff; report the concrete limit, completed batch phases, unclosed obligation IDs and exact next action without calling partial work acceptance.',
      'Build a gap matrix for the exact obligations below. Historical checkpoints are untrusted baseline observations, not fresh completion or source retirement authority.',
      'Implement final target declarations and consumers first. Prove one end-to-end migration with the pinned old artifact and an independently executing new receiver, then complete the remaining assigned aggregate certificates. Retire old execution sources only after their replacement is certified; refresh all evidence against the final source.',
      'Apply every pinned externalPrerequisites entry to its declared requiredBefore action. A receipt required before removing an old implementation does not authorize removal, cross-project writes or fabricated receiver evidence, and does not by itself prevent independent approved local implementation. Preserve the blocked action and its evidence in deliveryPrerequisites, keep its acceptance obligations open, and continue all feasible local targets, owner dependencies and certificates before returning an external-only blocker. If a real prerequisite prevents further independent work, identify the exact attempted action and observed failure. If an unavoidable handoff still leaves feasible local work alongside that prerequisite, report failureClass external-prerequisite-and-incomplete-implementation, identify that work in blocker.resumeWhen and preserve actual progress checkpoints; this is bounded continuation, never external prerequisite clearance.',
      'nextImplementationStep is an unfinished development candidate selected from approved targets and historical partial checkpoints. Reinspect the existing implementation and reverify affected behavior; selecting a later target does not certify earlier aggregate acceptance, preserve stale evidence or grant source retirement.',
      'Reuse existing working checks. Add tests only for a specific missing assertion or reproduced defect; increasing test counts or rerunning an already passing suite does not close an obligation.',
      'Before importing analysis helpers or running checks, disable implicit compiler/import caches or route them inside declared verificationOutputPaths. At final handoff compare the entire workspace delta with the original baseline, including generated files outside source directories. Do not merely omit an unexpected artifact from changedFiles; preserve evidence and correct its output route within authorized scope before returning.',
      'Do not return merely because implementation or certificates are missing, the task is large, or no additional direction arrived: the approved work is already authorized. Start the nextImplementationStep target, implementing missing owner dependencies before thin consumers in the approved dependency order. The candidate does not override that order. Investigating a gap is not a substitute for implementing it. A concrete authority, environment, scope or external prerequisite must identify the exact failed action and evidence.',
      'At an unavoidable handoff caused by a concrete authority, environment, scope or external prerequisite, or an actual host/runtime/context limit that prevents further execution, preserve partial final-target implementation using its implementation-step id and a second checkpoint with id <implementation-step id>:focused-verification, both completed with actual source/compile/behavior evidence. Name the exact stopping constraint and its observed evidence, the intended acceptance batch, the obligations actually closed and the next executable action. Partial checkpoints advance development only; they do not mark any parent obligation or aggregate certificate completed. Do not add placeholders, disconnected declarations or test-only changes for this checkpoint.',
      'If still incomplete, use checkpoints with the exact obligation id, status completed and concrete evidence only for obligations actually closed. Include remaining obligations in notMade and the next concrete implementation action in blocker.resumeWhen. Do not mark a whole obligation completed for a partial mechanism observation.',
      'Automatic continuation requires a newly closed approved obligation, or a changed approved final target plus completed implementation and focused-verification checkpoints, with bound evidence. Source edits alone are insufficient. An unproductive implementation-only handoff receives at most one corrective retry per explicit invocation, consuming the existing budget. These reports never waive full completion or final Gates; actual protected blockers and exhausted budgets stop execution.',
    ],
  };
};

/** A partial milestone report is continuation evidence, never final acceptance. */
export const hasNewAcceptanceCheckpoint = (state, feature, submission, context) => {
  if (context?.policy !== ACCEPTANCE_CONTINUATION_POLICY || !submission.evidenceRefs?.length) return false;
  const declared = new Set(context.workBatch?.policy === DELIVERY_BATCH_POLICY
    ? context.workBatch.obligationIds : context.obligations.map(item => item.id));
  const previous = state.submissions.filter(item => item.featureId === feature.id
    && item.submissionId !== submission.submissionId && !item.supersededAt)
    .flatMap(item => (item.result?.checkpoints ?? []).filter(completed));
  const prior = new Set(previous.map(item => item.id));
  // Historical check IDs may predate obligation IDs. Relabeling a green suite
  // cannot turn that same verification into a new acceptance milestone.
  for (const item of context.obligations) {
    if (item.kind === 'verification' && prior.has(item.specification?.id)) prior.add(item.id);
  }
  const previousEvidence = new Set(previous.flatMap(item => item.evidence));
  return (submission.result?.checkpoints ?? []).some(item => declared.has(item.id) && !prior.has(item.id)
    && completed(item) && item.evidence.some(ref => !previousEvidence.has(ref)));
};
