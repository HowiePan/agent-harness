import { resolve } from 'node:path';
import { sha256 } from '../../../../src/common/canonical.mjs';
import { safeSegment } from '../../../../src/common/paths.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { atomicWrite } from '../../../../src/kernel/atomic-io.mjs';

// Full immutable context stays on disk. A terminal event must be consumable even
// when Authority contains many historical prompts and submissions.
export const visibleResultSummary = result => {
  const state = result.state;
  return { status: result.status, reason: result.reason ?? null,
    runId: state?.runId ?? null, revision: state?.revision ?? null, sourceDigest: state?.sourceDigest ?? null,
    counts: state ? { features: state.features.length, completed: state.features.filter(item => item.state === 'completed').length,
      submissions: state.submissions.length, activeLeases: state.leases.filter(item => item.status === 'active').length } : null,
    blockedFeatures: (state?.features ?? []).filter(item => ['blocked', 'failed-budget'].includes(item.state)).slice(0, 8)
      .map(item => ({ id: item.id, state: item.state, blocker: item.blocker ? { kind: item.blocker.kind,
        summary: String(item.blocker.summary ?? '').slice(0, 512) } : null })),
    interruption: result.interruption ? { policy: result.interruption.policy, action: result.interruption.action,
      category: result.interruption.category, requiredDecision: result.interruption.requiredDecision,
      evidenceRef: result.interruption.evidenceRef ?? null } : null };
};
export const preserveVisibleResult = async ({ result, dataRoot, controlRoot, commandId }) => {
  const path = assertHarnessWritePath(resolve(dataRoot, 'coordination-results', `${safeSegment(commandId)}.json`), 'Lifecycle result', controlRoot);
  const bytes = Buffer.from(JSON.stringify(result));
  await atomicWrite(path, bytes, { root: dataRoot });
  return { ...visibleResultSummary(result), resultArtifact: { path, sha256: sha256(bytes), size: bytes.length } };
};
