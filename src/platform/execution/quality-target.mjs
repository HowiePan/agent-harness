import { digestJson, withoutKeys } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const terminalRun = run => run?.status === 'closed'
  || run?.status === 'superseded'
  || (Array.isArray(run?.features) && run.features.length > 0 && run.features.every(feature => feature.state === 'completed'));
const workflowIdOf = run => run?.metadata?.workflow?.id ?? run?.metadata?.commandIntent?.workflowId ?? null;
const matchesTarget = ({ run, projectId, workflowId, target, includeNonterminal = false }) => run?.projectId === projectId
  && run?.metadata?.commandIntent?.target === target
  && workflowIdOf(run) === workflowId
  && (includeNonterminal || terminalRun(run));
const chronological = (left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || String(left.runId).localeCompare(String(right.runId));
const findingStatus = value => ['open', 'resolved', 'rejected', 'superseded'].includes(value) ? value : 'open';

const mergeFinding = (ledger, finding, provenance) => {
  assert(typeof finding?.id === 'string' && finding.id.length > 0 && ['P0', 'P1', 'P2', 'P3'].includes(finding.severity), 'QUALITY_TARGET_FINDING_INVALID', 'Quality Target findings require a canonical ID and P0-P3 severity.');
  const prior = ledger.get(finding.id);
  const observation = {
    runId: provenance.runId,
    authorityDigest: provenance.authorityDigest,
    sourceDigest: provenance.sourceDigest,
    status: findingStatus(finding.status),
    evidenceRefs: [...new Set(finding.evidenceRefs ?? [])].sort(),
    resolutionEvidenceRefs: [...new Set(finding.resolutionEvidenceRefs ?? [])].sort(),
    observedAt: provenance.observedAt ?? null,
  };
  ledger.set(finding.id, {
    id: finding.id,
    severity: finding.severity,
    summary: String(finding.summary ?? prior?.summary ?? `Known quality finding ${finding.id}`),
    status: observation.status,
    source: String(finding.source ?? prior?.source ?? 'run-authority'),
    firstSeenRunId: prior?.firstSeenRunId ?? provenance.runId,
    lastSeenRunId: provenance.runId,
    evidenceRefs: [...new Set([...(prior?.evidenceRefs ?? []), ...observation.evidenceRefs])].sort(),
    resolutionEvidenceRefs: observation.resolutionEvidenceRefs,
    observations: [...(prior?.observations ?? []), observation],
    affectedPaths: [...new Set(finding.affectedPaths ?? prior?.affectedPaths ?? (finding.sourcePath ? [finding.sourcePath] : []))],
    evidence: [...new Set([...(prior?.evidence ?? []), ...(finding.evidence ?? [])])],
    symbols: [...new Set(finding.symbols ?? prior?.symbols ?? [])],
    contracts: [...new Set(finding.contracts ?? prior?.contracts ?? [])],
    generatedOutputs: [...new Set(finding.generatedOutputs ?? prior?.generatedOutputs ?? [])],
    conflictKeys: [...new Set(finding.conflictKeys ?? prior?.conflictKeys ?? [])],
    ...(finding.sourcePath ? { sourcePath: finding.sourcePath } : prior?.sourcePath ? { sourcePath: prior.sourcePath } : {}),
  });
};

const applyDisposition = (ledger, item, submission, run) => {
  const finding = ledger.get(item?.id);
  if (!finding || item.disposition !== 'not-reproduced') return;
  const evidenceRefs = [...new Set(submission.evidenceRefs ?? [])].sort();
  ledger.set(finding.id, {
    ...finding,
    status: 'resolved',
    lastSeenRunId: run.runId,
    resolutionEvidenceRefs: evidenceRefs,
    observations: [...finding.observations, {
      runId: run.runId,
      authorityDigest: run.authorityDigest,
      sourceDigest: submission.outputSourceDigest ?? run.sourceDigest,
      status: 'resolved',
      disposition: 'not-reproduced',
      evidence: [...new Set(item.evidence ?? [])].sort(),
      evidenceRefs,
      observedAt: submission.submittedAt ?? run.updatedAt ?? null,
    }],
  });
};

export const qualityTargetDigest = snapshot => digestJson(withoutKeys(snapshot, ['targetDigest']));

export const assertQualityTargetSnapshot = input => {
  assert(input?.protocolVersion === '1.0' && input.kind === 'quality-target-snapshot', 'QUALITY_TARGET_SNAPSHOT_INVALID', 'Quality Target snapshot is invalid.');
  assert(typeof input.projectId === 'string' && input.projectId.length > 0 && typeof input.workflowId === 'string' && input.workflowId.length > 0 && typeof input.target === 'string' && input.target.length > 0, 'QUALITY_TARGET_IDENTITY_INVALID', 'Quality Target snapshot requires Project, Workflow, and target identities.');
  assert(Number.isInteger(input.revision) && input.revision >= 0 && digestPattern.test(input.sourceDigest ?? '') && Array.isArray(input.runs) && Array.isArray(input.findings), 'QUALITY_TARGET_SNAPSHOT_INVALID', 'Quality Target snapshot revision, source, runs, or findings are invalid.');
  assert(input.targetDigest === qualityTargetDigest(input), 'QUALITY_TARGET_DIGEST_MISMATCH', 'Quality Target digest does not match its contents.');
  assert(new Set(input.findings.map(item => item.id)).size === input.findings.length, 'QUALITY_TARGET_FINDING_DUPLICATE', 'Quality Target snapshot contains duplicate Finding IDs.');
  return structuredClone(input);
};

export const deriveQualityTargetSnapshot = ({ projectId, workflowId, target, sourceDigest, runs = [], legacyInventory = null, includeNonterminal = false } = {}) => {
  assert(typeof projectId === 'string' && projectId.length > 0 && typeof workflowId === 'string' && workflowId.length > 0 && typeof target === 'string' && target.length > 0 && digestPattern.test(sourceDigest ?? ''), 'QUALITY_TARGET_INPUT_INVALID', 'Quality Target derivation requires Project, Workflow, target, and source identities.');
  assert(Array.isArray(runs), 'QUALITY_TARGET_RUNS_INVALID', 'Quality Target derivation requires an array of Run Authority states.');
  const ledger = new Map();
  if (legacyInventory) {
    for (const item of legacyInventory.findings ?? []) mergeFinding(ledger, {
      ...item,
      summary: `Imported known quality finding ${item.id}`,
      status: 'open',
      source: 'legacy-project-descriptor',
    }, {
      runId: 'legacy-project-descriptor',
      authorityDigest: legacyInventory.inventoryDigest,
      sourceDigest: legacyInventory.sourceDigest,
      observedAt: null,
    });
  }
  const selected = runs.filter(run => matchesTarget({ run, projectId, workflowId, target, includeNonterminal })).sort(chronological);
  const reviewHistory = runs.filter(run => matchesTarget({ run, projectId, workflowId, target, includeNonterminal: true }))
    .flatMap(run => (run.features ?? []).filter(feature => feature.metadata?.qualityReview === true && feature.state === 'completed')
      .map(feature => ({ runId: run.runId, featureId: feature.id, sourceDigest: run.submissions?.find(item => item.featureId === feature.id)?.outputSourceDigest ?? run.sourceDigest })))
    .sort((left, right) => `${left.runId}:${left.featureId}`.localeCompare(`${right.runId}:${right.featureId}`));
  const exhaustiveRunIds = runs.filter(run => matchesTarget({ run, projectId, workflowId, target, includeNonterminal: true })
    && run.metadata?.commandIntent?.action === 'quality' && run.metadata.commandIntent.preset === 'release-exhaustive')
    .map(run => run.runId).sort();
  for (const run of selected) {
    for (const finding of run.findings ?? []) mergeFinding(ledger, finding, {
      runId: run.runId,
      authorityDigest: run.authorityDigest,
      sourceDigest: run.sourceDigest,
      observedAt: run.updatedAt ?? null,
    });
    for (const submission of run.submissions ?? []) {
      for (const disposition of submission.result?.knownFindingDispositions ?? []) applyDisposition(ledger, disposition, submission, run);
    }
  }
  const runRefs = selected.map(run => ({
    runId: run.runId,
    revision: run.revision,
    authorityDigest: run.authorityDigest,
    sourceDigest: run.sourceDigest,
    status: run.status,
  }));
  const findings = [...ledger.values()].map(item => ({ ...item, observations: [...item.observations].sort((left, right) => String(left.observedAt ?? '').localeCompare(String(right.observedAt ?? '')) || String(left.runId).localeCompare(String(right.runId))) })).sort((left, right) => left.id.localeCompare(right.id));
  const body = {
    protocolVersion: '1.0',
    kind: 'quality-target-snapshot',
    projectId,
    workflowId,
    target,
    revision: runRefs.reduce((sum, run) => sum + run.revision, legacyInventory ? 1 : 0),
    sourceDigest,
    runs: runRefs,
    findings,
    reviewHistory,
    exhaustiveRunIds,
    migration: legacyInventory ? { source: 'project-descriptor', inventoryDigest: legacyInventory.inventoryDigest } : null,
  };
  return Object.freeze({ ...body, targetDigest: qualityTargetDigest(body) });
};

export const createQualityRepairInventorySnapshot = targetInput => {
  const target = assertQualityTargetSnapshot(targetInput);
  const findings = target.findings.filter(item => item.status === 'open').map(item => ({
    id: item.id, severity: item.severity, summary: item.summary,
    affectedPaths: [...new Set(item.affectedPaths?.length ? item.affectedPaths : item.sourcePath ? [item.sourcePath] : [])],
    evidence: [...new Set([...(item.evidence ?? []), ...item.evidenceRefs])],
    evidenceRefs: [...item.evidenceRefs], symbols: [...(item.symbols ?? [])], contracts: [...(item.contracts ?? [])],
    generatedOutputs: [...(item.generatedOutputs ?? [])], conflictKeys: [...(item.conflictKeys ?? [])],
  }));
  assert(findings.length > 0, 'QUALITY_REPAIR_INVENTORY_EMPTY', 'Repair-only quality flow requires at least one open authoritative Finding.');
  for (const finding of findings) assert(finding.affectedPaths.length > 0 && finding.evidence.length > 0, 'QUALITY_REPAIR_FINDING_INCOMPLETE', `Finding ${finding.id} requires affected paths and evidence for repair-only execution.`);
  const body = { version: '1.0', kind: 'quality-repair-inventory', projectId: target.projectId, workflowId: target.workflowId, target: target.target, sourceDigest: target.sourceDigest, targetDigest: target.targetDigest, findings };
  return Object.freeze({ ...body, inventoryDigest: digestJson(body) });
};

export const assertQualityRepairInventorySnapshot = input => {
  assert(input?.version === '1.0' && input.kind === 'quality-repair-inventory' && Array.isArray(input.findings) && input.findings.length > 0, 'QUALITY_REPAIR_INVENTORY_INVALID', 'Repair-only inventory is invalid.');
  assert(input.inventoryDigest === digestJson(withoutKeys(input, ['inventoryDigest'])), 'QUALITY_REPAIR_INVENTORY_DIGEST_MISMATCH', 'Repair-only inventory digest does not match its contents.');
  for (const item of input.findings) assert(item?.id && ['P0', 'P1', 'P2', 'P3'].includes(item.severity) && Array.isArray(item.affectedPaths) && item.affectedPaths.length > 0 && Array.isArray(item.evidence) && item.evidence.length > 0, 'QUALITY_REPAIR_FINDING_INCOMPLETE', 'Repair-only Finding lacks evidence or paths.');
  return structuredClone(input);
};

export const qualityInventoryDigest = inventory => digestJson(withoutKeys(inventory, ['inventoryDigest']));

export const createQualityInventorySnapshot = targetInput => {
  const target = assertQualityTargetSnapshot(targetInput);
  const body = {
    version: '2.0',
    kind: 'quality-inventory-snapshot',
    projectId: target.projectId,
    workflowId: target.workflowId,
    target: target.target,
    sourceDigest: target.sourceDigest,
    targetRevision: target.revision,
    targetDigest: target.targetDigest,
    findings: target.findings.map(item => ({
      id: item.id,
      severity: item.severity,
      status: item.status,
      evidenceRefs: [...item.evidenceRefs],
      resolutionEvidenceRefs: [...item.resolutionEvidenceRefs],
      ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
    })),
  };
  return Object.freeze({ ...body, inventoryDigest: qualityInventoryDigest(body) });
};

export const assertQualityInventorySnapshot = input => {
  assert(input?.version === '2.0' && input.kind === 'quality-inventory-snapshot', 'QUALITY_FINDING_INVENTORY_INVALID', 'Quality inventory snapshot is invalid.');
  assert(typeof input.projectId === 'string' && typeof input.workflowId === 'string' && typeof input.target === 'string' && Number.isInteger(input.targetRevision) && input.targetRevision >= 0, 'QUALITY_FINDING_INVENTORY_INVALID', 'Quality inventory snapshot identity is invalid.');
  assert(digestPattern.test(input.sourceDigest ?? '') && digestPattern.test(input.targetDigest ?? '') && Array.isArray(input.findings), 'QUALITY_FINDING_INVENTORY_INVALID', 'Quality inventory snapshot source, target, or findings are invalid.');
  assert(input.inventoryDigest === qualityInventoryDigest(input), 'QUALITY_FINDING_INVENTORY_DIGEST_MISMATCH', 'Quality inventory snapshot digest does not match its contents.');
  const ids = new Set();
  for (const item of input.findings) {
    assert(typeof item?.id === 'string' && item.id.length > 0 && !ids.has(item.id) && ['P0', 'P1', 'P2', 'P3'].includes(item.severity) && ['open', 'resolved', 'rejected', 'superseded'].includes(item.status), 'QUALITY_FINDING_INVENTORY_ITEM_INVALID', 'Quality inventory Finding is invalid or duplicated.');
    assert(Array.isArray(item.evidenceRefs) && Array.isArray(item.resolutionEvidenceRefs), 'QUALITY_FINDING_INVENTORY_ITEM_INVALID', 'Quality inventory Finding evidence references are invalid.');
    ids.add(item.id);
  }
  return structuredClone(input);
};
