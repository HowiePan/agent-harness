import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { rebindAmendmentReferences } from '../flows/delivery-lifecycle/plan-amendment.mjs';
import { matchesAmendmentRetry, rejectedAmendmentDraftEvidence } from './plan-amendment-retry.mjs';
import { verifyBlockedDraftArtifacts } from './plan-amendment-draft-artifacts.mjs';

const implementation = feature => feature.metadata?.stage === 'implementation';
const convergence = feature => !feature.metadata?.deliveryBatch || feature.metadata.deliveryBatch.phase === 'convergence';

const verifyOutputBaseline = async (prior, baseline, evidenceStore) => {
  const submission = prior.submissions.find(item => item.submissionId === baseline.terminalSubmissionId && !item.supersededAt);
  const evidence = await evidenceStore.read(baseline.snapshotEvidenceRef);
  const record = JSON.parse(evidence.bytes.toString('utf8'));
  assert(submission && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
    && submission.evidenceRefs.includes(baseline.snapshotEvidenceRef)
    && evidence.metadata.projectId === prior.projectId && evidence.metadata.runId === prior.runId
    && evidence.metadata.dispatchId === submission.dispatchId && evidence.metadata.featureId === submission.featureId
    && record.outputSourceDigest === prior.sourceDigest && submission.outputSourceDigest === prior.sourceDigest
    && record.inputSourceDigest === submission.inputSourceDigest && digestJson(record.result) === digestJson(submission.result)
    && baseline.outputSnapshot.root === prior.metadata.workspace.root
    && baseline.outputSnapshot.digest === prior.sourceDigest
    && digestJson(baseline.outputSnapshot.files) === prior.sourceDigest,
  'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Output snapshot must bind a committed immutable result and exact source digest.');
  return baseline.outputSnapshot;
};

/** Capture current Authority identities and snapshot evidence, never conversational completion claims. */
export const captureAmendmentBaselines = async ({ states, revision, snapshot, evidenceStore, project }) => {
  const baselines = [];
  const retry = revision.replacesAmendment && states.find(state => matchesAmendmentRetry(state, { intent: {
    ...state.metadata.commandIntent, planRevision: revision }, harness: project?.harness }));
  assert(!revision.replacesAmendment || retry, 'PLAN_AMENDMENT_RETRY_UNSAFE', 'Prior amendment Authority changed.');
  const inherited = retry?.metadata.planRevision.implementationBaselines ?? [];
  const transferred = inherited.map(item => {
    const prior = states.find(state => state.runId === item.runId);
    const chain = [...(item.retirementChain ?? []), retry.runId];
    assert(prior && (['failed', 'incomplete'].includes(prior.status) || prior.status === 'superseded')
      && prior.sourceDigest === item.sourceDigest,
    'PLAN_AMENDMENT_BASELINE_RUN_CHANGED', 'Retired implementation baseline changed.');
    let predecessor = prior;
    for (const runId of chain) {
      const draft = states.find(state => state.runId === runId);
      assert(draft && predecessor.status === 'superseded' && predecessor.metadata?.supersededByRunId === runId
        && predecessor.metadata.supersedePlanDigest === draft.metadata.lifecyclePlanDigest
        && draft.metadata?.commandIntent?.action === 'amend'
        && draft.metadata.planRevision.parentPlanDigest === revision.parentPlanDigest
        && (!draft.submissions.some(row => row.result?.status === 'completed') || rejectedAmendmentDraftEvidence(draft)),
      'PLAN_AMENDMENT_BASELINE_RUN_CHANGED', 'Retired implementation does not bind the preceding unaccepted amendment.');
      predecessor = draft;
    }
    return { prior, chain, baseline: item };
  });
  const candidates = [...transferred.map(item => item.prior), ...revision.affectedImplementationRuns
    .map(item => states.find(state => state.runId === item.runId)).filter(state => !transferred.some(item => item.prior.runId === state.runId))];
  const unfinished = candidates.filter(state => !['failed', 'incomplete'].includes(state.status));
  assert(unfinished.length <= 1, 'PLAN_AMENDMENT_BASELINE_AMBIGUOUS', 'More than one unfinished implementation claims the amendment baseline.');
  const selected = unfinished[0] ?? candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  for (const prior of candidates.filter(item => item.runId === selected?.runId)) {
    const inheritedBaseline = transferred.find(item => item.prior.runId === prior.runId)?.baseline;
    let ref = inheritedBaseline?.snapshotEvidenceRef
      ?? prior.dispatches.findLast(dispatch => dispatch.sourceDigest === prior.sourceDigest && dispatch.sourceSnapshotRef)?.sourceSnapshotRef;
    let outputBaseline = null;
    let before;
    if (inheritedBaseline?.snapshotKind) {
      assert(inheritedBaseline.snapshotKind === 'committed-result-output',
        'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Unsupported inherited implementation snapshot.');
      outputBaseline = { snapshotKind: inheritedBaseline.snapshotKind, terminalSubmissionId: inheritedBaseline.terminalSubmissionId,
        outputSnapshot: structuredClone(inheritedBaseline.outputSnapshot) };
      before = await verifyOutputBaseline(prior, { ...outputBaseline, snapshotEvidenceRef: ref }, evidenceStore);
    } else if (!ref) {
      const last = prior.submissions.at(-1);
      const dispatch = prior.dispatches.find(item => item.dispatchId === last?.dispatchId && item.status === 'committed');
      assert(last?.outputSourceDigest === prior.sourceDigest && dispatch?.sourceSnapshotRef && last.evidenceRefs?.length,
        'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Missing trusted final implementation baseline.');
      const input = JSON.parse((await evidenceStore.read(dispatch.sourceSnapshotRef)).bytes.toString('utf8'));
      assert(input.digest === last.inputSourceDigest && digestJson(input.files) === input.digest,
        'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Invalid original input snapshot.');
      const preparations = revision.amendmentScope.baselineCompatibilityPaths ?? [];
      assert(!(last.changedFiles ?? []).some(path => preparations.includes(path)),
        'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED', 'Preparation paths overlap the last implementation output.');
      const files = snapshot.files.filter(file => !preparations.includes(file.path))
        .concat(input.files.filter(file => preparations.includes(file.path))).sort((a, b) => a.path.localeCompare(b.path));
      ref = last.evidenceRefs[0];
      outputBaseline = { snapshotKind: 'committed-result-output', terminalSubmissionId: last.submissionId,
        outputSnapshot: { protocolVersion: '1.0', root: snapshot.root, files, digest: digestJson(files) } };
      before = await verifyOutputBaseline(prior, { ...outputBaseline, snapshotEvidenceRef: ref }, evidenceStore);
    } else {
      const record = await evidenceStore.read(ref);
      before = JSON.parse(record.bytes.toString('utf8'));
      assert(record.metadata.projectId === prior.projectId && record.metadata.runId === prior.runId
        && record.metadata.sourceDigest === prior.sourceDigest && before.digest === prior.sourceDigest,
      'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Implementation source baseline must bind the exact Run and snapshot.');
    }
    const changed = diffWorkspaceSnapshots(before, snapshot);
    const preparations = revision.amendmentScope.baselineCompatibilityPaths ?? [];
    const draftArtifacts = await verifyBlockedDraftArtifacts({
      drafts: (transferred.find(item => item.prior.runId === prior.runId)?.chain ?? [])
        .map(runId => states.find(state => state.runId === runId)),
      snapshot, evidenceStore, artifactRoot: revision.amendmentScope.artifactRoot });
    const planningPaths = project?.policy?.actionPaths?.plan ?? ['docs/versions'];
    assert(preparations.every(path => path === 'harness.json' || planningPaths.some(root => path === root || path.startsWith(`${root}/`))),
      'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED', 'Preparation exceptions must remain inside registered planning paths.');
    assert(changed.every(path => preparations.includes(path) || draftArtifacts.has(path)),
      'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED', 'Source changed outside exact registered amendment preparation paths.', { changedPaths: changed });
    baselines.push({ runId: prior.runId, sourceDigest: prior.sourceDigest, snapshotEvidenceRef: ref, ...outputBaseline,
      ...(transferred.find(item => item.prior.runId === prior.runId)?.chain ? {
        retirementChain: transferred.find(item => item.prior.runId === prior.runId).chain } : {}),
      approvedPlanDigest: prior.metadata?.approvedPlan?.planDigest ?? null,
      completed: [...(prior.metadata?.approvedPlan?.amendmentBaseline?.completedProposals ?? []),
        ...prior.features.filter(implementation).filter(convergence).filter(feature => feature.state === 'completed').map(feature => ({
        originRunId: prior.runId, featureId: feature.id, proposalId: feature.metadata.approvedProposal?.id,
        proposalDigest: digestJson(feature.metadata.approvedProposal), submissionId: feature.submissionId,
      }))],
      preparationPaths: changed.map(path => snapshot.files.find(file => file.path === path)).filter(Boolean),
    });
  }
  return baselines;
};

export const verifyAmendmentBaselines = async ({ planRun, typedPlan, snapshot, authorityStore, evidenceStore, archivePath = null, archiveDigest = null }) => {
  if (!typedPlan.amendment) return { completedProposalIds: [], completedProposals: [], progress: {} };
  const revision = planRun.metadata.planRevision;
  const approved = typedPlan.amendment;
  const ids = [];
  const completions = [];
  const progress = {};
  const documents = approved.documentBindings;
  for (const baseline of revision.implementationBaselines ?? []) {
    const prior = await authorityStore.read(planRun.projectId, baseline.runId);
    const chain = [...(baseline.retirementChain ?? []), planRun.runId];
    let predecessor = prior;
    for (const runId of baseline.retirementChain ?? []) {
      const retiredDraft = await authorityStore.read(planRun.projectId, runId);
      assert(predecessor.metadata?.supersededByRunId === runId
        && predecessor.metadata.supersedePlanDigest === retiredDraft.metadata.lifecyclePlanDigest
        && retiredDraft.status === 'superseded' && retiredDraft.metadata?.commandIntent?.action === 'amend'
        && retiredDraft.metadata.planRevision.parentPlanDigest === revision.parentPlanDigest
        && (!retiredDraft.submissions.some(row => row.result?.status === 'completed') || rejectedAmendmentDraftEvidence(retiredDraft)),
      'PLAN_AMENDMENT_BASELINE_RUN_CHANGED', 'Amendment retirement chain is not an unaccepted draft lineage.');
      predecessor = retiredDraft;
    }
    assert((prior.status === 'superseded' && prior.metadata?.supersededByRunId === chain[0]
      && predecessor.metadata?.supersededByRunId === planRun.runId
      && predecessor.metadata.supersedePlanDigest === planRun.metadata.lifecyclePlanDigest)
      || ['failed', 'incomplete'].includes(prior.status),
    'PLAN_AMENDMENT_BASELINE_RUN_CHANGED', 'The baseline implementation must remain safely retired.');
    const before = baseline.snapshotKind === 'committed-result-output'
      ? await verifyOutputBaseline(prior, baseline, evidenceStore)
      : JSON.parse((await evidenceStore.read(baseline.snapshotEvidenceRef)).bytes.toString('utf8'));
    assert(before.digest === baseline.sourceDigest && prior.sourceDigest === baseline.sourceDigest,
      'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED', 'The retired implementation source identity changed.');
    const changes = diffWorkspaceSnapshots(before, snapshot);
    const preparations = new Map(baseline.preparationPaths.map(file => [file.path, file.sha256]));
    assert(changes.every(path => {
      if (path.startsWith(`${revision.amendmentScope.artifactRoot}/`)) return true;
      if (path === archivePath) return snapshot.files.find(file => file.path === path)?.sha256 === archiveDigest;
      return preparations.has(path) && snapshot.files.find(file => file.path === path)?.sha256 === preparations.get(path);
    }), 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED', 'Implementation source changed outside verified planning artifacts.');
    for (const entry of baseline.completed) {
      if (approved.affectedFeatureIds.includes(entry.proposalId)) continue;
      const proposal = typedPlan.proposedFeatures.find(item => item.id === entry.proposalId && item.projectId === planRun.projectId);
      const origin = entry.originRunId && entry.originRunId !== prior.runId
        ? await authorityStore.read(planRun.projectId, entry.originRunId) : prior;
      const feature = origin.features.find(item => item.id === entry.featureId);
      assert(proposal && feature?.state === 'completed' && feature.submissionId === entry.submissionId
        && digestJson(rebindAmendmentReferences(proposal, documents, true)) === entry.proposalDigest,
      'PLAN_AMENDMENT_BASELINE_PROPOSAL_CHANGED', 'An inherited completed proposal changed and requires re-verification.');
      const submission = origin.submissions.find(item => item.submissionId === entry.submissionId && !item.supersededAt);
      assert(submission?.result?.status === 'completed' && submission.evidenceRefs?.length
        && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest'])),
      'PLAN_AMENDMENT_BASELINE_SUBMISSION_INVALID', 'Completion requires the original immutable Submission and Evidence.');
      for (const ref of submission.evidenceRefs) {
        const evidence = await evidenceStore.read(ref);
        assert(evidence.metadata.projectId === prior.projectId && evidence.metadata.featureId === feature.id
          && evidence.metadata.dispatchId === submission.dispatchId && evidence.metadata.sourceDigest === submission.inputSourceDigest,
        'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Completion Evidence does not bind its original Feature, Dispatch and source.');
        const evidenceOrigin = await authorityStore.read(prior.projectId, evidence.metadata.runId);
        assert(evidenceOrigin.submissions.some(item => item.submissionDigest === submission.submissionDigest),
          'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'Completion Evidence has no matching original Authority Submission.');
      }
      ids.push(entry.proposalId);
      completions.push({ ...entry, originRunId: origin.runId, proposalDigest: digestJson(proposal) });
    }
    for (const feature of prior.features.filter(implementation).filter(convergence)) {
      const proposalId = feature.metadata.approvedProposal?.id;
      if (!proposalId) continue;
      const related = new Set(prior.features.filter(item => item.logicalRoot === feature.logicalRoot).map(item => item.id));
      const history = prior.submissions.filter(item => related.has(item.featureId) && !item.supersededAt);
      const checkpoints = new Map(history.flatMap(item => item.result?.checkpoints ?? []).map(item => [item.id, item]));
      progress[proposalId] = { runId: prior.runId, sourceDigest: prior.sourceDigest,
        history: history.slice(-3), checkpoints: [...checkpoints.values()],
        attempts: Object.fromEntries(Object.entries(prior.attempts ?? {}).filter(([key]) => key.startsWith(`${feature.logicalRoot}:`))) };
    }
  }
  assert(new Set(ids).size === ids.length, 'PLAN_AMENDMENT_BASELINE_AMBIGUOUS', 'More than one baseline claims the same completed proposal.');
  return { completedProposalIds: ids, completedProposals: completions, progress };
};
