import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';

const code = 'INTERRUPTED_SOURCE_RECOVERY_UNVERIFIED';
const safe = path => typeof path === 'string' && path.length > 0 && !/[\\:*]/.test(path)
  && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
const within = (scope, path) => safe(scope) && (path === scope || path.startsWith(`${scope}/`));
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');

/** A contained, abandoned Dispatch may leave a draft, never a completion. */
export const assessInterruptedWorkspace = ({ state, before, after, effect }) => {
  assert(state.metadata?.commandIntent?.action === 'implement'
    && !['closed', 'failed', 'incomplete', 'superseded'].includes(state.status)
    && !state.leases.some(item => item.status === 'active')
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status)), code,
  'Interrupted source recovery requires an idle implementation Run.');
  const recovered = state.events.at(-1);
  assert(recovered?.type === 'run.recovered' && recovered.mode === 'ordinary-resume'
    && recovered.epoch === state.epoch && recovered.generation === state.generation
    && recovered.previous?.epoch === state.epoch
    && recovered.previous.generation === state.generation - 1, code,
  'Only the immediately preceding ordinary resume can preserve abandoned source.');
  const dispatches = state.dispatches.filter(item => item.status === 'superseded'
    && item.epoch === state.epoch && item.generation === state.generation - 1
    && item.sourceDigest === state.sourceDigest && item.sourceSnapshotRef
    && !state.submissions.some(submission => submission.dispatchId === item.dispatchId));
  assert(dispatches.length === 1, code, 'Recovery requires one exact abandoned Dispatch.');
  const dispatch = dispatches[0];
  const leases = state.leases.filter(item => item.dispatchId === dispatch.dispatchId && item.status === 'superseded');
  const lease = leases[0];
  const feature = state.features.find(item => item.id === dispatch.featureId);
  const spawn = lease?.runtimeReceipt?.hostSpawnReceipt;
  assert(leases.length === 1 && lease.epoch === dispatch.epoch && lease.generation === dispatch.generation
    && lease.packetDigest === dispatch.packetDigest && feature?.state === 'pending'
    && feature.metadata?.stage === 'implementation' && feature.metadata?.sourcePolicy !== 'read-only'
    && digestJson(feature.allowedPaths) === digestJson(dispatch.featureSnapshot.allowedPaths)
    && digestJson(feature.forbiddenPaths) === digestJson(dispatch.featureSnapshot.forbiddenPaths)
    && spawn?.effectId === effect?.effectId && spawn.agentId === lease.agentId
    && spawn.dispatchId === dispatch.dispatchId && spawn.packetDigest === dispatch.packetDigest
    && spawn.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest, code,
  'The abandoned Lease and Feature must retain their original Dispatch identity and paths.');
  assert(effect.state === 'contained' && effect.outcome?.reason === 'preflight-reconciliation'
    && effect.outcome.disposition === 'interrupted' && effect.outcome.target === lease.agentId
    && [effect.outcome.interruptRequestDigest, effect.outcome.interruptResultDigest,
      effect.outcome.verificationRequestDigest].every(hash)
    && effect.canonicalAgentName === lease.agentId && effect.nativeTaskName === spawn.nativeTaskName
    && effect.sessionId === spawn.sessionId && effect.requestDigest === spawn.requestDigest
    && effect.binding?.projectId === state.projectId && effect.binding.runId === state.runId
    && effect.binding.dispatchId === dispatch.dispatchId && effect.binding.packetDigest === dispatch.packetDigest
    && effect.binding.promptDigest === spawn.promptDigest, code,
  'Source recovery requires the exact native interruption and containment proof.');
  assert(before?.protocolVersion === '1.0' && before.root === resolve(state.metadata.workspace.root)
    && before.digest === digestJson(before.files) && before.digest === dispatch.sourceDigest
    && after?.root === before.root && after.digest === digestJson(after.files), code,
  'Source snapshots must bind the Dispatch baseline and the actual workspace.');
  const changedFiles = diffWorkspaceSnapshots(before, after);
  assert(changedFiles.length > 0 && changedFiles.every(path => safe(path)
    && feature.allowedPaths.some(scope => within(scope, path))
    && !(feature.forbiddenPaths ?? []).some(scope => within(scope, path))
    && !(feature.metadata?.verificationOutputPaths ?? []).some(scope => within(scope, path))), code,
  'Every preserved draft change must be inside the original source scope.');
  return { dispatch, lease, feature, changedFiles };
};

const assertSnapshotEvidence = (record, state, dispatch) => {
  const meta = record.metadata;
  assert(meta.ref === dispatch.sourceSnapshotRef && meta.projectId === state.projectId && meta.runId === state.runId
    && meta.epoch === dispatch.epoch && meta.generation === dispatch.generation
    && meta.sourceDigest === dispatch.sourceDigest && meta.artifactDigest === state.artifactDigest
    && meta.policyDigest === state.policyDigest && meta.pluginSetDigest === state.pluginSetDigest
    && meta.featureId === null && meta.dispatchId === null && meta.labels.includes('workspace-snapshot'), code,
  'Draft baseline Evidence does not bind the abandoned Dispatch.');
};

/** Application maintenance transaction: source provenance only; no Submission is invented. */
export const recoverInterruptedWorkspace = async ({ state, project, authorityStore, evidenceStore,
  controlRoot, dataRoot, commandId, patchReceiptDigest = null, readHostEffect = null }) => {
  const after = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
  if (after.digest === state.sourceDigest) return state;
  const candidates = state.dispatches.filter(item => item.status === 'superseded'
    && item.sourceDigest === state.sourceDigest && item.generation === state.generation - 1
    && !state.submissions.some(submission => submission.dispatchId === item.dispatchId));
  assert(candidates.length === 1, code, 'Source drift has no unique interrupted Dispatch.');
  const dispatch = candidates[0];
  const lease = state.leases.find(item => item.dispatchId === dispatch.dispatchId);
  const spawn = lease?.runtimeReceipt?.hostSpawnReceipt;
  assert(spawn?.effectId && spawn.contract, code, 'Source drift has no native Host binding.');
  const effect = readHostEffect ? await readHostEffect(spawn.effectId, spawn.contract)
    : await new CodexHostEffectJournal({ controlRoot, dataRoot, contract: spawn.contract }).read(spawn.effectId, { required: true });
  const record = await evidenceStore.read(dispatch.sourceSnapshotRef);
  assertSnapshotEvidence(record, state, dispatch);
  const before = JSON.parse(record.bytes.toString('utf8'));
  const { feature, changedFiles } = assessInterruptedWorkspace({ state, before, after, effect });
  const body = { kind: 'interrupted-workspace-draft', version: '1.0', projectId: state.projectId,
    runId: state.runId, epoch: state.epoch, generation: state.generation,
    priorAuthorityDigest: state.authorityDigest, priorRevision: state.revision,
    dispatchId: dispatch.dispatchId, leaseId: lease.leaseId, featureId: feature.id,
    packetDigest: dispatch.packetDigest, hostEffectDigest: effect.effectDigest,
    sourceSnapshotRef: dispatch.sourceSnapshotRef, fromSourceDigest: before.digest, toSourceDigest: after.digest,
    changedFiles, changedFilesDigest: digestJson(changedFiles), snapshot: after,
    attribution: 'unsubmitted-interrupted-dispatch-draft', patchReceiptDigest };
  const evidence = await evidenceStore.put(body, { mediaType: 'application/json', projectId: state.projectId,
    runId: state.runId, epoch: state.epoch, generation: state.generation,
    featureId: feature.id, dispatchId: dispatch.dispatchId, sourceDigest: before.digest,
    artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest,
    labels: ['interrupted-workspace-draft'] });
  const current = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
  assert(current.digest === after.digest, code, 'Workspace changed during draft preservation.');
  const claim = { evidenceRef: evidence.ref, dispatchId: dispatch.dispatchId,
    fromSourceDigest: before.digest, toSourceDigest: after.digest, changedFilesDigest: body.changedFilesDigest };
  return (await authorityStore.transact(state.projectId, state.runId,
    { expectedRevision: state.revision, commandId, payload: { ...claim, patchReceiptDigest } }, currentState => {
      assert(currentState.authorityDigest === state.authorityDigest, code, 'Run changed before draft preservation.');
      currentState.sourceDigest = after.digest;
      currentState.metadata.interruptedWorkspaceDraft = claim;
      currentState.evidenceRefs = [...new Set([...currentState.evidenceRefs, evidence.ref])];
      currentState.events.push({ sequence: currentState.events.length + 1,
        type: 'workspace.interrupted-draft-preserved', at: new Date().toISOString(),
        epoch: state.epoch, generation: state.generation, priorAuthorityDigest: state.authorityDigest,
        priorRevision: state.revision, ...claim, patchReceiptDigest });
      return claim;
    })).state;
};

/** Re-check persisted provenance before using it as an approval-source bridge. */
export const readInterruptedWorkspaceDraft = async ({ state, evidenceStore, controlRoot, dataRoot, readHostEffect = null }) => {
  const claim = state.metadata?.interruptedWorkspaceDraft;
  if (!claim) return null;
  const evidence = await evidenceStore.read(claim.evidenceRef);
  const body = JSON.parse(evidence.bytes.toString('utf8'));
  const event = state.events.find(item => item.type === 'workspace.interrupted-draft-preserved'
    && item.evidenceRef === claim.evidenceRef);
  assert(event && body.kind === 'interrupted-workspace-draft' && body.version === '1.0'
    && body.projectId === state.projectId && body.runId === state.runId
    && body.epoch === event.epoch && body.generation === event.generation
    && body.priorAuthorityDigest === event.priorAuthorityDigest && body.priorRevision === event.priorRevision
    && body.patchReceiptDigest === event.patchReceiptDigest
    && evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
    && evidence.metadata.sourceDigest === body.fromSourceDigest
    && evidence.metadata.epoch === body.epoch && evidence.metadata.generation === body.generation
    && evidence.metadata.featureId === body.featureId && evidence.metadata.dispatchId === body.dispatchId
    && evidence.metadata.labels.includes('interrupted-workspace-draft')
    && ['dispatchId', 'fromSourceDigest', 'toSourceDigest', 'changedFilesDigest'].every(key =>
      claim[key] === body[key] && event[key] === body[key])
    && body.snapshot.digest === body.toSourceDigest && digestJson(body.snapshot.files) === body.toSourceDigest, code,
  'Draft provenance does not match its Authority event and Evidence.');
  const dispatch = state.dispatches.find(item => item.dispatchId === body.dispatchId);
  const lease = state.leases.find(item => item.leaseId === body.leaseId);
  assert(dispatch && lease?.dispatchId === dispatch.dispatchId && lease.status === 'superseded'
    && dispatch.packetDigest === body.packetDigest && dispatch.sourceSnapshotRef === body.sourceSnapshotRef, code,
  'Draft provenance lost its original Dispatch.');
  const spawn = lease.runtimeReceipt.hostSpawnReceipt;
  const effect = readHostEffect ? await readHostEffect(spawn.effectId, spawn.contract)
    : await new CodexHostEffectJournal({ controlRoot, dataRoot, contract: spawn.contract }).read(spawn.effectId, { required: true });
  assert(effect.effectDigest === body.hostEffectDigest, code, 'Draft containment proof changed.');
  const baselineRecord = await evidenceStore.read(body.sourceSnapshotRef);
  assertSnapshotEvidence(baselineRecord, state, dispatch);
  // Reconstruct only the pre-preservation view; the immutable event binds that view.
  const prior = { ...state, status: 'ready', generation: body.generation, sourceDigest: body.fromSourceDigest,
    features: state.features.map(item => item.id === body.featureId ? { ...item, state: 'pending' } : item),
    leases: state.leases.filter(item => item.generation < body.generation),
    dispatches: state.dispatches.filter(item => item.generation < body.generation),
    submissions: state.submissions.filter(item => item.generation < body.generation),
    events: state.events.filter(item => item.sequence < event.sequence) };
  const assessed = assessInterruptedWorkspace({ state: prior,
    before: JSON.parse(baselineRecord.bytes.toString('utf8')), after: body.snapshot, effect });
  assert(digestJson(assessed.changedFiles) === body.changedFilesDigest
    && digestJson(body.changedFiles) === body.changedFilesDigest, code, 'Draft source delta changed.');
  return { ...claim, changedFiles: body.changedFiles, featureId: body.featureId, patchReceiptDigest: body.patchReceiptDigest };
};
