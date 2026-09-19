import { sha256 } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';

const unique = values => [...new Set(values ?? [])];
const cleanReviewSubmission = (state, feature) => {
  const submission = state.submissions.find(item => item.featureId === feature.id && !item.supersededAt);
  return Boolean(submission && submission.outputSourceDigest === state.sourceDigest && (submission.result.findings ?? []).length === 0);
};

export const hasCurrentCleanQualityReview = (state, qualityRoot = null) => state.features
  .filter(feature => feature.metadata?.qualityReview === true && (!qualityRoot || feature.metadata.qualityRoot === qualityRoot))
  .some(feature => feature.state === 'completed' && cleanReviewSubmission(state, feature));

export const validateQualityReviewPolicies = features => {
  for (const feature of features) {
    const policy = feature.metadata?.qualityFindingPolicy;
    if (policy === undefined) continue; // Existing versioned plans use sourcePolicy.
    assert(feature.metadata.qualityReview === true && ['repair-and-rereview', 'record-only'].includes(policy), 'QUALITY_FINDING_POLICY_INVALID', `Quality Feature ${feature.id} has an invalid Finding follow-up policy.`);
    assert(feature.metadata.sourcePolicy === 'read-only' && feature.allowedPaths.length === 0, 'QUALITY_REVIEW_WRITE_POLICY_INVALID', `Quality Feature ${feature.id} must remain read-only; repair belongs to a separate Feature.`);
  }
};

const repairsForFindings = ({ feature, findings }) => findings.map(finding => {
  const qualityRoot = feature.metadata.qualityRoot ?? feature.logicalRoot;
  const reviewRound = Number(feature.metadata.reviewRound ?? 1);
  const suffix = sha256(`${qualityRoot}:${finding.id}:${reviewRound}`).slice(0, 24);
  const affectedPaths = finding.affectedPaths?.length ? finding.affectedPaths : [];
  return {
    id: `quality-repair-${suffix}`,
    executionClass: 'agent-reasoning',
    kind: 'quality-repair',
    ownerRole: 'worker',
    logicalRoot: `finding:${finding.id}`,
    laneId: `finding:${finding.id}`,
    acceptance: [
      `Resolve ${finding.severity} quality finding ${finding.id}: ${finding.summary}`,
      'Run focused checks and return non-empty verification checkpoints plus host-preserved verification Receipts.',
    ],
    steps: [
      { id: 'repair', title: `Repair finding ${finding.id}.` },
      { id: 'verify', title: `Verify the repair for finding ${finding.id}.` },
    ],
    dependsOn: [feature.id],
    allowedPaths: affectedPaths,
    forbiddenPaths: feature.forbiddenPaths,
    symbols: finding.symbols,
    contracts: finding.contracts,
    generatedOutputs: finding.generatedOutputs,
    conflictKeys: finding.conflictKeys,
    gatePlan: feature.gatePlan,
    metadata: {
      ...structuredClone(feature.metadata.qualityContext ?? {}),
      stage: 'quality-repair',
      sourcePolicy: 'repair',
      qualityRoot,
      reviewRound,
      findingId: finding.id,
      findingSeverity: finding.severity,
      findingSummary: finding.summary,
      findingEvidence: finding.evidence,
      repairFindingId: finding.id,
    },
  };
});

const nextRecheck = ({ state, feature }) => {
  const root = feature.metadata.qualityRoot;
  const rootFeatures = state.features.filter(item => item.metadata?.qualityRoot === root);
  const repairs = rootFeatures.filter(item => item.metadata?.repairFindingId);
  const open = state.findings.some(finding => finding.status !== 'resolved' && repairs.some(item => item.metadata.repairFindingId === finding.id));
  if (open || repairs.some(item => item.state !== 'completed') || hasCurrentCleanQualityReview(state, root)) return [];
  const reviewRound = 1 + Math.max(0, ...rootFeatures.filter(item => item.metadata?.qualityReview).map(item => Number(item.metadata.reviewRound ?? 0)));
  const id = `quality-recheck-${sha256(`${root}:${state.sourceDigest}:${reviewRound}`).slice(0, 24)}`;
  if (state.features.some(item => item.id === id)) return [];
  return [{
    id,
    executionClass: 'agent-reasoning',
    kind: 'quality-recheck',
    ownerRole: 'reviewer',
    logicalRoot: `${root}:recheck:${reviewRound}`,
    laneId: feature.laneId,
    acceptance: [
      'Perform a fresh full-scope read-only review against the post-repair source digest.',
      'Return every remaining P0-P3 finding; a zero-finding result is required for closure.',
    ],
    steps: [
      { id: 'review', title: 'Re-review the complete quality scope after repairs.' },
      { id: 'report', title: 'Report all remaining findings against the current source digest.' },
    ],
    dependsOn: repairs.map(item => item.id),
    allowedPaths: [],
    forbiddenPaths: feature.forbiddenPaths,
    conflictKeys: unique([...(feature.conflictKeys ?? []), `${root}:review`]),
    gatePlan: feature.gatePlan,
    metadata: {
      ...structuredClone(feature.metadata.qualityContext ?? {}),
      stage: 'quality-recheck',
      sourcePolicy: 'read-only',
      qualityFindingPolicy: 'repair-and-rereview',
      qualityReview: true,
      qualityRoot: root,
      reviewRound,
      reviewSourceDigest: state.sourceDigest,
      qualityContext: structuredClone(feature.metadata.qualityContext ?? {}),
    },
  }];
};

export const createQualityFollowUpFeatures = ({ state, feature, findings, result }) => {
  if (feature.metadata?.qualityReview === true || feature.metadata?.stage === 'quality') {
    // Pre-policy plans used sourcePolicy for the whole lifecycle. Keep them
    // readable, but new plans separate this review's write boundary from the
    // policy for findings emitted after it completes.
    const policy = feature.metadata?.qualityFindingPolicy
      ?? (feature.metadata?.sourcePolicy === 'review-and-repair' ? 'repair-and-rereview' : 'record-only');
    assert(['repair-and-rereview', 'record-only'].includes(policy), 'QUALITY_FINDING_POLICY_INVALID', 'Quality review has an unknown Finding follow-up policy.');
    if (policy === 'repair-and-rereview') return repairsForFindings({ feature: { ...feature, metadata: { ...feature.metadata, qualityRoot: feature.metadata.qualityRoot ?? feature.logicalRoot, reviewRound: feature.metadata.reviewRound ?? 1 } }, findings });
    return [];
  }
  if (feature.metadata?.repairFindingId && result?.status === 'completed') return nextRecheck({ state, feature });
  return [];
};
