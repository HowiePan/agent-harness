import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { HANDOFF_CORRECTION_POLICY } from './implementation-handoff.mjs';

export const ACCEPTANCE_CONTINUATION_POLICY = 'approved-obligation-progress/1';
const obligation = (kind, key, detail) => ({ id: `obligation:${digestJson({ kind, key })}`, kind, key, ...detail });
const completed = checkpoint => checkpoint.status === 'completed' && checkpoint.evidence?.length > 0;

/** Resolve only hash-pinned local plan data, never a conversational replacement plan. */
export const buildImplementationContinuation = async (state, feature, workspaceRoot) => {
  const proposal = feature.metadata?.approvedProposal;
  if (feature.metadata?.stage !== 'implementation' || !proposal) return null;
  const typed = feature.metadata.approvedDeliveryPlan;
  const readPinned = async ref => {
    assert(ref?.path && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''),
      'IMPLEMENTATION_CONTINUATION_PIN_REQUIRED', 'Referenced implementation inputs require a pinned path and SHA-256.');
    const bytes = await readFile(assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, ref.path), 'implementation input'));
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
  const contracts = (proposal.contracts ?? []).flatMap(item => typeof item === 'string' && item.includes('#/')
    ? dereference(item) : [item]);
  const verification = (proposal.verification ?? []).map(item => item?.specificationRef ? dereference(item.specificationRef) : item);
  const sources = (expanded?.sourceLifecycleContract?.sources ?? []).filter(item => item.lastExitFeature === proposal.id);
  const inventory = typed?.sourceInventory ? await readPinned(typed.sourceInventory) : null;
  const matrix = inventory?.mixedAggregateContract?.certificateProductionContract?.aggregateCertificates ?? [];
  const aggregates = new Map((inventory?.mixedAggregateContract?.aggregates ?? []).map(item => [item.source_symbol, item]));
  const obligations = [
    ...contracts.map(item => obligation('contract', item, { description: item })),
    ...verification.map(item => obligation('verification', item, { specification: item })),
    ...matrix.filter(item => item.capabilityProducer === proposal.id).map(item => {
      const aggregate = aggregates.get(item.sourceSymbol);
      return obligation('aggregate-certificate', item.sourceSymbol, {
        sourceSha256: item.sourceSha256, memberCount: item.memberCount,
        members: aggregate?.complete_source_members ?? [], assertions: item.requiredAssertions,
        finalPaths: [...new Set((aggregate?.member_conversions ?? []).map(member => member.target_path))],
        nativeDependencies: item.nativeDependencies,
      });
    }),
    ...sources.map(item => obligation('source-exit', item.sourcePath, { finalPaths: item.finalPaths })),
  ];
  const history = state.submissions.filter(item => item.featureId === feature.id && !item.supersededAt);
  const latest = history.at(-1);
  const inherited = feature.metadata?.amendmentProgressBaseline;
  const checkpoints = new Map([
    ...(inherited?.checkpoints ?? []).map(checkpoint => [checkpoint.id, checkpoint]),
    ...history.flatMap(item => (item.result?.checkpoints ?? []).map(checkpoint => [checkpoint.id, checkpoint])),
  ]);
  const attempt = state.attempts?.[latest?.attemptBudgetKey ?? `${feature.logicalRoot}:${latest?.result?.failureClass}`];
  const targets = [...new Set([
    ...obligations.flatMap(item => (item.nativeDependencies ?? []).map(dep => dep.targetPath)),
    ...obligations.flatMap(item => item.finalPaths ?? []),
  ])].filter(path => typeof path === 'string' && !path.includes(':') && !path.includes('\\')
    && path.split('/').every(part => part && !['.', '..', 'tests', 'test', 'docs', 'scripts'].includes(part))
    && feature.allowedPaths?.some(scope => path === scope || path.startsWith(`${scope}/`))
    && !(feature.forbiddenPaths ?? []).some(scope => path === scope || path.startsWith(`${scope}/`)));
  const implementationSteps = await Promise.all(targets.map(async targetPath => {
    const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, targetPath), 'implementation target');
    let baselineSha256 = null;
    try { baselineSha256 = sha256(await readFile(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { id: `implementation-step:${digestJson(targetPath)}`, targetPath, baselineSha256,
      parentObligations: obligations.filter(item => item.finalPaths?.includes(targetPath)
        || item.nativeDependencies?.some(dep => dep.targetPath === targetPath)).map(item => item.id) };
  }));
  return {
    policy: ACCEPTANCE_CONTINUATION_POLICY, proposalId: proposal.id, sourceDigest: state.sourceDigest,
    pinnedInputs: { expandedPlan: typed?.expandedPlan ?? null, sourceInventory: typed?.sourceInventory ?? null },
    obligations, verification,
    correctionPolicy: { id: HANDOFF_CORRECTION_POLICY, maxCorrectionsPerInvocation: 1 },
    implementationSteps,
    nextImplementationStep: implementationSteps.find(item => item.baselineSha256 === null) ?? implementationSteps[0] ?? null,
    history: [...(inherited?.history ?? []), ...history].slice(-3).map(item => ({ submissionId: item.submissionId,
      inputSourceDigest: item.inputSourceDigest, outputSourceDigest: item.outputSourceDigest,
      changedFiles: item.changedFiles, summary: item.result.summary, blocker: item.result.blocker,
      notMade: item.result.notMade ?? [], checkpoints: item.result.checkpoints ?? [], evidenceRefs: item.evidenceRefs })),
    baselineCheckpoints: [...checkpoints.values()],
    ...(inherited ? { priorRunProgress: { runId: inherited.runId, sourceDigest: inherited.sourceDigest,
      attempts: inherited.attempts, evidenceStatus: 'historical-baseline-reverify-affected-evidence' } } : {}),
    budget: attempt ? { used: attempt.budgetKind === 'progress' ? attempt.used : attempt.failures,
      limit: attempt.limit, exhausted: attempt.exhausted } : null,
    instructions: [
      'The execution unit is this complete Feature, not one patch, implementation-step or certificate. In the same Agent session, group related unresolved obligations and their owner dependencies into a coherent acceptance batch; when multiple related obligations are feasible, work through them together and continue toward full Feature completion. Preserve the approved dependency order, scope and acceptance criteria; a batch creates no new Feature, Lease, authority or budget.',
      'Do not voluntarily return after one local fix, focused test, implementation-step or closed certificate while further approved work is feasible. Any permission to report partial progress is a recovery fallback, not a planned stopping point or a one-item quota. Repair supporting mechanisms and continue closing their affected acceptance obligations in this session. Missing code, remaining certificates, task size, an elapsed work interval or a self-chosen batch boundary alone does not justify returning blocked.',
      'Run focused checks after material changes. Consolidate broad verification at a stable acceptance batch or Feature boundary unless the approved verification contract requires it sooner, a new failure needs diagnosis, or later source changes invalidate prior evidence. Bind acceptance evidence to the final source and run every mandatory final check; never reuse stale results or reduce required coverage to save time.',
      'Build a gap matrix for the exact obligations below. Historical checkpoints are untrusted baseline observations, not fresh completion or source retirement authority.',
      'Implement final target declarations and consumers first. Prove one end-to-end migration with the pinned old artifact and an independently executing new receiver, then complete the remaining assigned aggregate certificates. Retire old execution sources only after their replacement is certified; refresh all evidence against the final source.',
      'Reuse existing working checks. Add tests only for a specific missing assertion or reproduced defect; increasing test counts or rerunning an already passing suite does not close an obligation.',
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
  const declared = new Set(context.obligations.map(item => item.id));
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
