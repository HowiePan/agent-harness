import { sha256 } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../common/task-contract.mjs';

const unique = values => [...new Set(values ?? [])];
const cleanReviewSubmission = (state, feature) => {
  const submission = state.submissions.find(item => item.featureId === feature.id && !item.supersededAt);
  const inventory = feature.metadata?.knownFindingInventory;
  if (feature.metadata?.qualityRoot?.startsWith('engine:') && ['quality', 'full', 'deliver'].includes(state.metadata?.commandIntent?.action) && !inventory) return false;
  const dispositions = submission?.result?.knownFindingDispositions;
  const inventoryClean = !inventory || (Array.isArray(dispositions) && dispositions.length === inventory.findings.length && dispositions.every(item => item.disposition === 'not-reproduced'));
  return Boolean(submission && submission.outputSourceDigest === state.sourceDigest && (submission.result.findings ?? []).length === 0 && inventoryClean && !state.findings.some(finding => finding.status !== 'resolved'));
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
  const taskProjection = taskFeatureProjection(defineNodeTaskContract({
    role: { id: 'quality-repairer', description: 'Repairs one exact evidence-backed quality finding within its authorized paths.' },
    objective: `Resolve ${finding.severity} quality finding ${finding.id}: ${finding.summary}`,
    instructions: ['Inspect the cited finding evidence and current source.', 'Apply the smallest complete repair.', 'Run focused checks that directly verify the repaired behavior.'],
    inputs: [{ id: 'finding', source: 'feature', path: 'findingId', required: true, description: 'The exact finding assigned to this repair Feature.' }],
    steps: [{ id: 'repair', instruction: `Repair finding ${finding.id}.` }, { id: 'verify', instruction: `Verify the repair for finding ${finding.id}.` }],
    constraints: ['Modify only affected authorized paths.', 'Do not mark the finding resolved without current verification evidence.'],
    acceptance: [`Resolve ${finding.severity} quality finding ${finding.id}: ${finding.summary}`, 'Focused verification passes with non-empty evidence.'],
    evidenceRequirements: ['Cite the original finding evidence, exact changed paths, and every focused verification result.'],
  }));
  return {
    id: `quality-repair-${suffix}`,
    executionClass: 'agent-reasoning',
    kind: 'quality-repair',
    ownerRole: 'worker',
    logicalRoot: `finding:${finding.id}`,
    laneId: `finding:${finding.id}`,
    ...taskProjection,
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
      qualityContext: structuredClone(feature.metadata.qualityContext ?? {}),
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
  const taskProjection = taskFeatureProjection(defineNodeTaskContract({
    role: { id: 'quality-reviewer', description: 'Performs a fresh full-scope independent review after repairs.' },
    objective: 'Determine whether the repaired current source is free of every P0-P3 finding in the complete quality scope.',
    instructions: ['Review the complete scope, not only repaired lines.', 'Run relevant read-only checks on the current source digest.', 'Report every remaining or newly introduced finding.'],
    inputs: [{ id: 'quality-root', source: 'feature', path: 'qualityRoot', required: true, description: 'The exact quality scope that must be re-reviewed.' }],
    steps: [{ id: 'review', instruction: 'Re-review the complete quality scope after repairs.' }, { id: 'report', instruction: 'Report all remaining findings against the current source digest.' }],
    constraints: ['Remain read-only and independent from repair claims.'],
    acceptance: ['A fresh full-scope review is complete on the post-repair source digest.', 'Every remaining P0-P3 finding has non-empty evidence.', 'A zero-finding result is required for closure.'],
    evidenceRequirements: ['Cite current-source checks, inspected paths, and evidence for every finding or clean conclusion.'],
  }));
  return [{
    id,
    executionClass: 'agent-reasoning',
    kind: 'quality-recheck',
    ownerRole: 'reviewer',
    logicalRoot: `${root}:recheck:${reviewRound}`,
    laneId: feature.laneId,
    ...taskProjection,
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
