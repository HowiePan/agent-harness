import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertInside, safeSegment } from '../common/paths.mjs';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { assertQualityCloseoutSnapshot, assertQualityTargetSnapshot, createQualityCloseoutSnapshot } from '../platform/execution/quality-target.mjs';

// A deterministic projection of the immutable Kernel closure, not a second
// Authority transition. Recreating it after a crash yields the same file.
export const ensureVersionClearance = async (dataRoot, state) => {
  if (state.status !== 'closed' || !state.metadata?.qualityTarget || !['quality', 'full', 'deliver'].includes(state.metadata?.commandIntent?.action)) return null;
  const closureRef = state.receipts.find(item => item.kind === 'run-closure');
  assert(closureRef?.file && closureRef.digest, 'VERSION_CLOSURE_RECEIPT_REQUIRED', 'Version clearance requires the sealed Run closure receipt.');
  assertInside(dataRoot, closureRef.file, 'Run closure receipt');
  const closure = JSON.parse(await readFile(closureRef.file, 'utf8'));
  assert(closure.receiptDigest === closureRef.digest && digestJson(withoutKeys(closure, ['receiptDigest'])) === closureRef.digest
    && closure.projectId === state.projectId && closure.runId === state.runId && closure.sourceDigest === state.sourceDigest,
  'VERSION_CLOSURE_RECEIPT_MISMATCH', 'Run closure receipt does not match the closed Authority state.');
  const target = assertQualityTargetSnapshot(state.metadata.qualityTarget);
  const closeout = state.profile.config.closeoutOnly ? assertQualityCloseoutSnapshot(state.metadata.qualityCloseout) : null;
  if (closeout) assert(createQualityCloseoutSnapshot(target).closeoutDigest === closeout.closeoutDigest && closeout.sourceDigest === state.sourceDigest, 'VERSION_CLOSEOUT_EVIDENCE_MISMATCH', 'Independent closeout evidence differs from its pinned target.');
  assert(!state.findings.some(item => item.status !== 'resolved'), 'VERSION_CLEARANCE_FINDINGS_OPEN', 'Version clearance requires all current Findings resolved.');
  const requiredGateIds = state.profile.config.requiredFinalGates ?? [];
  const finalGates = requiredGateIds.map(id => [...state.gates].reverse().find(gate => gate.id === id && gate.scope === 'final' && gate.status === 'passed' && gate.forcedFresh && gate.sourceDigest === state.sourceDigest));
  assert(finalGates.every(Boolean), 'VERSION_CLEARANCE_FINAL_GATE_REQUIRED', 'Version clearance requires fresh final Gates on the closed source.');
  if (state.profile.config.requireRoutineExitDecision) assert(state.decisions.some(item => item.id === 'routine-version-exit' && item.decision === 'approved'), 'VERSION_EXIT_DECISION_REQUIRED', 'Routine version exit requires an approved Authority Decision.');
  const fullReviewPerformed = !state.profile.config.repairOnly && !closeout && state.features.some(feature => feature.metadata?.qualityReview === true);
  const body = {
    protocolVersion: '1.0', kind: 'version-clearance', projectId: state.projectId, runId: state.runId,
    target: state.metadata.commandIntent.target, sourceDigest: state.sourceDigest,
    runClosureDigest: closureRef.digest, qualityTargetDigest: target.targetDigest,
    qualityConclusion: {
      mode: closeout ? 'evidence-backed-closeout' : state.profile.config.repairOnly ? 'known-findings-repair' : closure.qualityConclusion?.mode ?? 'reviewed-delivery',
      fullReviewPerformed, priorRunId: closeout?.priorRunId ?? null,
      verifiedFindingIds: closeout ? closeout.resolvedFindingIds : state.findings.map(item => item.id),
    },
    finalGates: finalGates.map(gate => ({ id: gate.id, evidenceRefs: gate.evidenceRefs })),
    decisionRefs: state.decisions.map(item => item.id), status: 'development-complete', closedAt: state.closedAt,
  };
  const receipt = { ...body, receiptDigest: digestJson(body) };
  const file = resolve(dataRoot, 'receipts', safeSegment(state.projectId), safeSegment(state.runId), `${safeSegment(receipt.receiptDigest)}.version-clearance.json`);
  await atomicWriteJson(file, receipt, { root: dataRoot });
  return { receipt, file };
};
