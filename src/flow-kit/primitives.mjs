import { assert } from '../common/errors.mjs';
import { openBlockingFindings } from '../kernel/quality.mjs';

export const approvalSatisfied = (state, decisionId, expected = 'approved') => state.decisions.some(decision => decision.id === decisionId && decision.decision === expected);

export const orderedBarrier = ({ currentId, entries, isClosed = entry => entry.status === 'closed' }) => {
  const current = entries.find(entry => entry.id === currentId);
  assert(current, 'BARRIER_CURRENT_UNKNOWN', `Barrier entry not found: ${currentId}`);
  const blockers = entries.filter(entry => Number(entry.order) < Number(current.order) && !isClosed(entry));
  return blockers.length ? { ok: false, blockers: blockers.map(entry => entry.id) } : { ok: true, blockers: [] };
};

export const artifactPin = identity => ({ identity: structuredClone(identity), digest: identity?.identityDigest ?? identity?.digest ?? null });
export const artifactChanged = (left, right) => left?.digest !== right?.digest;

export const reviewEpochStatus = state => {
  const findings = openBlockingFindings(state.findings);
  return { ok: findings.length === 0, findings: findings.map(finding => ({ id: finding.id, severity: finding.severity })) };
};

export const docsCloseoutStatus = (state, featureKind = 'docs') => {
  const features = state.features.filter(feature => feature.kind === featureKind || feature.metadata.stage === 'docs-closeout');
  return { ok: features.length > 0 && features.every(feature => feature.state === 'completed'), features: features.map(feature => feature.id) };
};
