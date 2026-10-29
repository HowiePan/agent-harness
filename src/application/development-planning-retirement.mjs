import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { createHarness } from './harness.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';
import { currentPatchReceipt, assertDevelopmentRunRecoveryEffects, assertDispatchSourceSnapshotEvidence } from './development-run-recovery.mjs';
import { validateBusinessResult } from '../platform/execution/result-contract.mjs';
import { resolvedPlanAmendment } from '../flows/delivery-lifecycle/plan-amendment.mjs';
import { verifyPlanAmendmentArtifacts } from './plan-amendment-artifacts.mjs';

export const assessPlanningOutputRetirement = ({ state, feature, result, before, after }) => {
  const native = validateBusinessResult(result, { conversationVisible: true, feature });
  assert(state.metadata?.commandIntent?.action === 'amend' && feature.metadata?.stage === 'version-planning'
    && feature.state === 'running' && native.status === 'completed' && native.outputs?.amendment?.value?.deltaRef
    && !native.outputs.amendment.value.plan && !state.submissions.length,
  'DEVELOPMENT_PLANNING_RETIREMENT_SCOPE', 'Only an unaccepted, reference-bearing amendment result can be preserved.');
  const changedFiles = [...new Set(native.changedFiles.map(path => path.replaceAll('\\', '/')))].sort();
  const actual = diffWorkspaceSnapshots(before, after).sort();
  const within = (root, path) => path === root || path.startsWith(`${root}/`);
  assert(digestJson(changedFiles) === digestJson(actual)
    && changedFiles.every(path => within(state.metadata.planRevision.amendmentScope.artifactRoot, path)
      && feature.allowedPaths.some(root => within(root, path)) && !feature.forbiddenPaths.some(root => within(root, path))),
  'DEVELOPMENT_PLANNING_RETIREMENT_SOURCE_DRIFT', 'Preserve only exact native claimed draft bytes inside the original planning scope.');
  const plan = resolvedPlanAmendment(state.metadata.planRevision, native.outputs.amendment.value,
    { workspaceRoot: state.metadata.workspace.root });
  const expandedBytes = Buffer.byteLength(JSON.stringify({ ...native.outputs,
    amendment: { ...native.outputs.amendment, value: { ...native.outputs.amendment.value, plan } } }));
  assert(expandedBytes > 256 * 1024, 'DEVELOPMENT_PLANNING_RETIREMENT_REJECTION_UNVERIFIED',
    'The immutable delta must reproduce the old expanded-output budget failure.');
  return { changedFiles, expandedBytes, planDigest: digestJson(plan) };
};

export const commitPlanningOutputRetirement = async ({ authorityStore, evidenceStore, state, lease, dispatch, feature, evidenceRef, commandId }) => {
  const evidence = await evidenceStore.read(evidenceRef); const record = JSON.parse(evidence.bytes.toString('utf8'));
  assert(record.kind === 'unaccepted-planning-output' && record.version === '1.0'
    && record.priorAuthorityDigest === state.authorityDigest && record.sourceSnapshotRef === dispatch.sourceSnapshotRef
    && evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
    && evidence.metadata.featureId === feature.id && evidence.metadata.dispatchId === dispatch.dispatchId
    && evidence.metadata.sourceDigest === state.sourceDigest && evidence.metadata.artifactDigest === state.artifactDigest
    && record.originalResultDigest === digestJson(record.originalResult)
    && record.rejection.code === 'RESULT_OUTPUT_BUDGET_EXCEEDED' && record.rejection.expandedBytes > 256 * 1024
    && record.outputSnapshot.digest === digestJson(record.outputSnapshot.files),
  'DEVELOPMENT_PLANNING_RETIREMENT_EVIDENCE_INVALID', 'Planning retirement requires exact immutable native and snapshot evidence.');
  return authorityStore.transact(state.projectId, state.runId, { expectedRevision: state.revision, commandId,
    payload: { evidenceRef, priorAuthorityDigest: state.authorityDigest } }, current => {
    assert(current.status === 'running' && current.leases.filter(item => item.status === 'active').length === 1
      && current.leases.some(item => item.leaseId === lease.leaseId && item.status === 'active')
      && current.dispatches.some(item => item.dispatchId === dispatch.dispatchId && item.status === 'assigned')
      && !current.submissions.length,
    'DEVELOPMENT_PLANNING_RETIREMENT_AUTHORITY_CHANGED', 'Planning Authority changed before retirement.');
    const at = new Date().toISOString();
    Object.assign(current.leases.find(item => item.leaseId === lease.leaseId), { status: 'superseded', supersededAt: at, supersededReason: 'unaccepted-planning-output' });
    Object.assign(current.dispatches.find(item => item.dispatchId === dispatch.dispatchId), { status: 'superseded', supersededAt: at, supersededReason: 'unaccepted-planning-output' });
    const original = current.features.find(item => item.id === feature.id);
    original.state = 'blocked'; original.blocker = { kind: 'scope', code: 'UNACCEPTED_PLANNING_OUTPUT',
      summary: 'Preserved native draft requires new-source planning and independent review.' };
    current.status = 'ready'; current.metadata.unacceptedPlanningResult = { evidenceRef,
      originalResultDigest: record.originalResultDigest, observedSourceDigest: record.outputSnapshot.digest,
      patchReceiptDigest: record.patchReceiptDigest, deltaRef: structuredClone(record.originalResult.outputs.amendment.value.deltaRef) };
    current.evidenceRefs = [...new Set([...current.evidenceRefs, evidenceRef])];
    current.events.push({ sequence: (current.events.at(-1)?.sequence ?? 0) + 1, type: 'planning.unaccepted-result-preserved', at,
      epoch: current.epoch, generation: current.generation, evidenceRef });
    return { priorRunId: current.runId, evidenceRef, continuation: 'amend-command-ready', runCreated: false, implementationStarted: false };
  });
};

/** Maintenance only: preserve a native result without accepting it or dispatching a planner. */
export const retirePlanningOutput = async ({ manifestFile, runId, commandId, cwd = process.cwd() }) => {
  assert(runId && commandId, 'DEVELOPMENT_PLANNING_RETIREMENT_INPUT', 'Select an exact Run and command ID.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const extensions = await new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true }).loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions, strictProjectIdentity: false, initializeStorage: false });
  const state = await harness.authorityStore.read(config.request.binding.projectId, runId);
  if (state.metadata?.unacceptedPlanningResult) {
    const prior = state.commands?.[commandId];
    assert(prior?.result?.evidenceRef === state.metadata.unacceptedPlanningResult.evidenceRef,
      'DEVELOPMENT_PLANNING_RETIREMENT_ALREADY_DONE', 'The draft was preserved under another command.');
    return prior.result;
  }
  assert(state.status === 'running' && state.metadata?.lifecycleInvocationId
    && !state.findings.some(item => item.status !== 'resolved'),
  'DEVELOPMENT_PLANNING_RETIREMENT_SCOPE', 'Planning retirement requires the original active lifecycle.');
  const leases = state.leases.filter(item => item.status === 'active');
  const dispatches = state.dispatches.filter(item => ['requested', 'assigned'].includes(item.status));
  assert(leases.length === 1 && dispatches.length === 1 && leases[0].dispatchId === dispatches[0].dispatchId,
    'DEVELOPMENT_PLANNING_RETIREMENT_SCOPE', 'Planning retirement requires one bound transport.');
  const lease = leases[0], dispatch = dispatches[0], feature = state.features.find(item => item.id === dispatch.featureId);
  const patch = await currentPatchReceipt(manifest, state, harness.evidenceStore);
  assert(['H2', 'H3'].includes(patch.level), 'DEVELOPMENT_PLANNING_RETIREMENT_PATCH', 'A verified H2/H3 patch must cover this Run.');
  const effects = await new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    contract: lease.runtimeReceipt.hostSpawnReceipt.contract }).list();
  assertDevelopmentRunRecoveryEffects(state, effects);
  const effect = effects.find(item => item.effectId === lease.runtimeReceipt.hostSpawnReceipt.effectId);
  assert(effect.state === 'settled' && effect.outcome.disposition === 'result-observed',
    'DEVELOPMENT_PLANNING_RETIREMENT_HOST', 'Require the original settled native result.');
  const { readCodexRolloutObservation } = await import('../../integrations/codex/agent-harness-codex/lib/codex-rollout-host-exchange.mjs');
  const observed = await readCodexRolloutObservation({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    sessionId: effect.sessionId, expectedCwd: state.metadata.workspace.root,
    observationRequestDigest: effect.outcome.observationRequestDigest, agentId: lease.agentId });
  assert(digestJson(observed.result) === effect.outcome.resultDigest,
    'DEVELOPMENT_PLANNING_RETIREMENT_HOST', 'Native result must match its original Host observation.');
  const before = assertDispatchSourceSnapshotEvidence({ evidence: await harness.evidenceStore.read(dispatch.sourceSnapshotRef), state, dispatch });
  const project = await harness.projectRegistry.get(state.projectId);
  const after = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
  const assessment = assessPlanningOutputRetirement({ state, feature, result: observed.result, before, after });
  await verifyPlanAmendmentArtifacts({ state, feature, result: observed.result, workspaceRoot: state.metadata.workspace.root });
  const evidence = await harness.evidenceStore.put({ kind: 'unaccepted-planning-output', version: '1.0',
    priorAuthorityDigest: state.authorityDigest, patchReceiptDigest: patch.receiptDigest, hostObservationReceipt: observed.receipt,
    originalResult: observed.result, originalResultDigest: effect.outcome.resultDigest, sourceSnapshotRef: dispatch.sourceSnapshotRef,
    rejection: { code: 'RESULT_OUTPUT_BUDGET_EXCEEDED', expandedBytes: assessment.expandedBytes },
    changedFiles: assessment.changedFiles, outputSnapshot: after, planDigest: assessment.planDigest },
  { projectId: state.projectId, runId, epoch: state.epoch, generation: state.generation, featureId: feature.id,
    dispatchId: dispatch.dispatchId, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest,
    policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['unaccepted-planning-output'] });
  const current = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
  assert(current.digest === after.digest, 'DEVELOPMENT_PLANNING_RETIREMENT_SOURCE_DRIFT', 'Source changed during native observation.');
  const preserved = await commitPlanningOutputRetirement({ authorityStore: harness.authorityStore,
    evidenceStore: harness.evidenceStore, state, lease, dispatch, feature, evidenceRef: evidence.ref, commandId });
  return preserved.result;
};
