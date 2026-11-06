import { readVerifiedRunHistory, readVerifiedRunRecord } from './authority-history-reader.mjs';
import { assert } from '../common/errors.mjs';

const terminal = new Set(['closed', 'failed', 'incomplete', 'superseded']);
const output = (state, stage, ports, completedFeature = true) => {
  const ids = new Set(state.features.filter(feature => feature.metadata?.stage === stage
    && (!completedFeature || feature.state === 'completed')).map(feature => feature.id));
  return state.submissions.findLast(row => !row.supersededAt && ids.has(row.featureId)
    && row.result?.status === 'completed' && ports.some(port => row.result.outputs?.[port]?.value));
};

/** Read-only selection index. Every record is verified, but only the selected
 * base, live work and exact baseline/retry ancestors retain full payloads.
 * Projected records are never submitted to Kernel as Authority. */
export const readPlanRevisionHistory = async (store, projectId, intent) => {
  if (!store.root || !store.runFile) return readVerifiedRunHistory(store, projectId);
  const rows = [];
  await readVerifiedRunHistory(store, projectId, { include: state => {
    const command = state.metadata?.commandIntent;
    const related = command?.target === intent.target && command.workflowId === intent.workflowId;
    const planning = ['plan', 'replan', 'amend'].includes(command?.action)
      && state.features.some(row => row.metadata?.stage === 'plan-review');
    const reviewed = planning && Boolean(output(state, 'version-planning', ['plan', 'amendment'])
      && output(state, 'plan-review', ['plan-review']));
    const unmatchedRecovery = state.status === 'superseded'
      && /^development-h[1234]-recovery:[a-f0-9]{64}$/.test(state.metadata?.supersededReason ?? '')
      && Boolean(state.metadata.supersededByRunId && state.metadata.supersedePlanDigest);
    const header = { projectId: state.projectId, runId: state.runId, status: state.status,
      revision: state.revision, authorityDigest: state.authorityDigest, sourceDigest: state.sourceDigest,
      updatedAt: state.updatedAt, metadata: { commandIntent: command && { action: command.action,
        target: command.target, workflowId: command.workflowId, selector: command.selector },
        workflow: state.metadata?.workflow && { id: state.metadata.workflow.id },
        approvedPlan: state.metadata?.approvedPlan && { amendmentBaseline: {
          completedProposalIds: state.metadata.approvedPlan.amendmentBaseline?.completedProposalIds ?? [] } },
        supersededByRunId: state.metadata?.supersededByRunId, supersedePlanDigest: state.metadata?.supersedePlanDigest,
        supersededReason: state.metadata?.supersededReason },
      features: state.features.map(row => ({ id: row.id, state: row.state, metadata: { stage: row.metadata?.stage,
        approvedProposal: row.metadata?.approvedProposal && { id: row.metadata.approvedProposal.id },
        deliveryBatch: row.metadata?.deliveryBatch && { phase: row.metadata.deliveryBatch.phase } } })),
      submissions: [], leases: state.leases.map(row => ({ status: row.status })),
      dispatches: state.dispatches.map(row => ({ status: row.status })),
      findings: state.findings.map(row => ({ id: row.id, status: row.status })), decisions: [] };
    rows.push({ header, related, planning, reviewed, unmatchedRecovery });
    return false;
  } });
  rows.sort((a, b) => String(b.header.updatedAt).localeCompare(String(a.header.updatedAt)));
  const ids = new Set(rows.map(row => row.header.runId));
  const candidates = rows.filter(row => row.related && row.planning && (row.header.status !== 'superseded'
    || row.unmatchedRecovery && !ids.has(row.header.metadata.supersededByRunId)));
  const selected = candidates.find(row => row.reviewed) ?? candidates[0];
  const requested = new Set(selected ? [selected.header.runId] : []);
  for (const row of rows) if (row.related && (!terminal.has(row.header.status)
    || row.unmatchedRecovery && !ids.has(row.header.metadata.supersededByRunId))) requested.add(row.header.runId);
  // Failed implementations remain in the affected identity index. Only the
  // newest fallback can be selected for full baseline work when no live one exists.
  const implementation = rows.find(row => row.related && ['failed', 'incomplete'].includes(row.header.status)
    && row.header.features.some(feature => feature.metadata.stage === 'implementation'));
  if (implementation) requested.add(implementation.header.runId);
  const full = new Map();
  for (const id of requested) {
    if (full.has(id)) continue;
    const state = await readVerifiedRunRecord(store, projectId, id);
    assert(rows.find(row => row.header.runId === id)?.header.authorityDigest === state.authorityDigest,
      'AUTHORITY_HISTORY_CHANGED', 'Revision history changed while loading its selected ancestry.');
    full.set(id, state);
    if (state.status === 'closed') continue;
    const revision = state.metadata?.planRevision;
    for (const ancestor of [revision?.parentRunId, revision?.replacesAmendment?.runId,
      revision?.replacesAmendment?.preservedDraft?.rejectedReview?.originRunId,
      ...(revision?.implementationBaselines ?? []).flatMap(row => [row.runId, ...(row.retirementChain ?? [])])]) {
      if (ancestor) requested.add(ancestor);
    }
  }
  return rows.map(row => full.get(row.header.runId) ?? row.header);
};
