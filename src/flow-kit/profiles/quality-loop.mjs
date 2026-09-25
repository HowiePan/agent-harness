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

const pathOverlaps = (left, right) => left.some(a => right.some(b => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
const repairGroups = findings => {
  const groups = [];
  for (const finding of findings) {
    const paths = finding.affectedPaths ?? [];
    const matching = groups.find(group => group.length < 3 && paths.length && group.some(item => pathOverlaps(paths, item.affectedPaths ?? [])));
    if (matching) matching.push(finding);
    else groups.push([finding]);
  }
  return groups;
};

const repairsForFindings = ({ feature, findings }) => repairGroups(findings).map(group => {
  const finding = group[0];
  const findingIds = group.map(item => item.id);
  const qualityRoot = feature.metadata.qualityRoot ?? feature.logicalRoot;
  const reviewRound = Number(feature.metadata.reviewRound ?? 1);
  const suffix = sha256(`${qualityRoot}:${findingIds.join(',')}:${reviewRound}`).slice(0, 24);
  const affectedPaths = unique(group.flatMap(item => item.affectedPaths ?? []));
  const taskProjection = taskFeatureProjection(defineNodeTaskContract({
    role: { id: 'quality-repairer', description: 'Repairs compatible evidence-backed quality findings within their authorized paths.' },
    objective: `Resolve quality findings ${findingIds.join(', ')} within their shared affected paths.`,
    instructions: ['Inspect the cited finding evidence and current source.', 'Apply the smallest complete repair.', 'Run focused checks that directly verify the repaired behavior.'],
    inputs: [{ id: 'finding', source: 'feature', path: 'findingId', required: true, description: 'The exact finding assigned to this repair Feature.' }],
    steps: [{ id: 'repair', instruction: `Repair findings ${findingIds.join(', ')}.` }, { id: 'verify', instruction: `Verify each finding with a passing checkpoint named verify:<findingId>.` }],
    constraints: ['Modify only affected authorized paths.', 'Do not mark the finding resolved without current verification evidence.'],
    acceptance: [...group.map(item => `Resolve ${item.severity} quality finding ${item.id}: ${item.summary}`), 'Focused verification passes for every finding with non-empty evidence.'],
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
      repairFindingIds: findingIds,
      repairFindings: group.map(item => ({ id: item.id, severity: item.severity, summary: item.summary, evidence: item.evidence, affectedPaths: item.affectedPaths })),
    },
  };
});

const nextRecheck = ({ state, feature }) => {
  const root = feature.metadata.qualityRoot;
  const rootFeatures = state.features.filter(item => item.metadata?.qualityRoot === root);
  const repairs = rootFeatures.filter(item => item.metadata?.repairFindingId);
  const open = state.findings.some(finding => finding.status !== 'resolved' && repairs.some(item => (item.metadata.repairFindingIds ?? [item.metadata.repairFindingId]).includes(finding.id)));
  if (open || repairs.some(item => item.state !== 'completed') || hasCurrentCleanQualityReview(state, root)) return [];
  const reviewRound = 1 + Math.max(0, ...rootFeatures.filter(item => item.metadata?.qualityReview).map(item => Number(item.metadata.reviewRound ?? 0)));
  const id = `quality-recheck-${sha256(`${root}:${state.sourceDigest}:${reviewRound}`).slice(0, 24)}`;
  if (state.features.some(item => item.id === id)) return [];
  const diagnostics = [...new Map(state.submissions
    .filter(item => !item.supersededAt && item.result.status === 'completed' && rootFeatures.some(candidate => candidate.id === item.featureId && candidate.metadata?.repairFindingId))
    .flatMap(item => item.result.diagnostics ?? [])
    .map(item => [item.id, item])).values()];
  const taskProjection = taskFeatureProjection(defineNodeTaskContract({
    role: { id: 'quality-reviewer', description: 'Performs a fresh full-scope independent review after repairs.' },
    objective: 'Determine whether the repaired current source is free of every P0-P3 finding in the complete quality scope.',
    instructions: ['Review the complete scope, not only repaired lines.', 'Run relevant read-only checks on the current source digest.', 'Inspect every carried diagnostic and report a finding or evidence that it no longer reproduces.', 'Report every remaining or newly introduced finding.'],
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
      diagnostics,
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

export const createQualityGateDiagnosticReview = ({ state, gateResults }) => {
  const failed = gateResults.filter(gate => gate.status !== 'passed');
  if (!failed.length) return null;
  const prior = [...state.features].reverse().find(feature => feature.metadata?.qualityReview === true && feature.metadata?.qualityFindingPolicy === 'repair-and-rereview');
  if (!prior || !state.features.every(feature => feature.state === 'completed')) return null;
  const qualityRoot = prior.metadata.qualityRoot ?? prior.logicalRoot;
  const signature = sha256(`${qualityRoot}:${state.sourceDigest}:${failed.map(gate => gate.id).sort().join(',')}`);
  const id = `quality-gate-diagnostic-${signature.slice(0, 24)}`;
  if (state.features.some(feature => feature.id === id)) return null;
  const diagnostics = failed.map(gate => ({
    id: `gate:${gate.id}:${state.sourceDigest.slice(0, 12)}`,
    summary: `Required ${gate.id} Gate returned ${gate.status} on the current source.`,
    evidence: gate.evidenceRefs,
  }));
  const reviewRound = 1 + Math.max(0, ...state.features.filter(feature => feature.metadata?.qualityRoot === qualityRoot && feature.metadata?.qualityReview).map(feature => Number(feature.metadata.reviewRound ?? 0)));
  const taskProjection = taskFeatureProjection(defineNodeTaskContract({
    role: { id: 'quality-reviewer', description: 'Independently diagnoses required Gate failures on the current source.' },
    objective: 'Identify the source defect behind each failed Gate, with exact evidence and repair paths.',
    instructions: ['Inspect every failed Gate receipt and its current-source evidence.', 'Return a Finding with precise affectedPaths for a source defect, or fresh evidence that the failure no longer reproduces.', 'Review the complete quality scope for remaining P0-P3 defects.'],
    inputs: [{ id: 'quality-root', source: 'feature', path: 'qualityRoot', required: true, description: 'The scope of the required review.' }],
    steps: [{ id: 'diagnose', instruction: 'Reproduce and classify every failed Gate.' }, { id: 'report', instruction: 'Report evidence-backed Findings and diagnostic dispositions.' }],
    constraints: ['Remain read-only.', 'Do not modify source or broaden a repair without an evidence-backed Finding.'],
    acceptance: ['Every Gate diagnostic has a current-source disposition.', 'Every source defect has exact affected paths and evidence.'],
    evidenceRequirements: ['Cite the failed Gate receipt and fresh observed checks for every disposition.'],
  }));
  return {
    id, executionClass: 'agent-reasoning', kind: 'quality-recheck', ownerRole: 'reviewer',
    logicalRoot: `${qualityRoot}:gate-diagnostic:${reviewRound}`, laneId: prior.laneId,
    ...taskProjection, dependsOn: [prior.id], allowedPaths: [], forbiddenPaths: prior.forbiddenPaths,
    conflictKeys: unique([...(prior.conflictKeys ?? []), `${qualityRoot}:review`]), gatePlan: prior.gatePlan,
    metadata: {
      ...structuredClone(prior.metadata.qualityContext ?? {}), stage: 'quality-recheck', sourcePolicy: 'read-only',
      qualityFindingPolicy: 'repair-and-rereview', qualityReview: true, qualityRoot, reviewRound,
      reviewSourceDigest: state.sourceDigest, diagnostics, qualityContext: structuredClone(prior.metadata.qualityContext ?? {}),
    },
  };
};
