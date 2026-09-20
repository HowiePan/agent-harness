import { resolve } from 'node:path';
import { digestJson, newId } from '../common/canonical.mjs';
import { assert, fail } from '../common/errors.mjs';
import { safeSegment } from '../common/paths.mjs';
import { assertHardRecoveryDecision, hardRecoveryCapability } from '../platform/recovery/authorization.mjs';
import { readRecoveryVerification } from '../platform/recovery/verification.mjs';
import { readRecoveryResolution } from '../platform/recovery/resolution.mjs';
import { atomicWriteJson } from './atomic-io.mjs';
import { qualityCanClose, validateFinding } from './quality.mjs';
import { assertArtifactRebaseDecision } from '../platform/maintenance/upgrade-authorization.mjs';
import { buildRunReceipt, writeRunReceipt } from './receipts.mjs';
import { scheduleFeatures, validateWorkGraph } from './work-graph.mjs';
import { assertDispatchResultContract, validateBusinessResult, validateProfileResult } from '../platform/execution/result-contract.mjs';

const activeLease = lease => ['requested', 'active'].includes(lease.status);
const activeDispatch = dispatch => ['requested', 'assigned'].includes(dispatch.status);

export const leaseHealth = (state, now = Date.now()) => state.leases.filter(activeLease).map(lease => {
  const elapsedMs = Math.max(0, now - Date.parse(lease.lastHeartbeatAt));
  const dispatch = state.dispatches.find(item => item.dispatchId === lease.dispatchId);
  const defaultTimeoutMs = dispatch?.execution?.runtime?.mode === 'conversation-visible' ? 120000 : Number.POSITIVE_INFINITY;
  const timeoutMs = Number(lease.heartbeatTimeoutMs ?? defaultTimeoutMs);
  const hardExpired = Number.isFinite(timeoutMs) && elapsedMs >= timeoutMs;
  return { leaseId: lease.leaseId, featureId: lease.featureId, elapsedMs, health: hardExpired ? 'expired' : elapsedMs >= 60 * 1000 ? 'warning' : 'healthy', hardExpired };
});

export const buildDispatchPacket = (state, dispatch, feature) => ({
  protocolVersion: '1.0', projectId: state.projectId, runId: state.runId, profileId: state.profile.id,
  epoch: state.epoch, generation: state.generation, dispatchId: dispatch.dispatchId, feature: structuredClone(feature), outputRef: dispatch.outputRef,
  sourceDigest: dispatch.sourceDigest ?? state.sourceDigest, sourceSnapshotRef: dispatch.sourceSnapshotRef, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, artifactDigest: state.artifactDigest,
  gates: structuredClone(dispatch.gateSnapshot ?? state.gates),
  execution: structuredClone(dispatch.execution ?? {}),
  ...(state.metadata?.workspace ? { workspace: structuredClone(state.metadata.workspace) } : {}),
  ...(state.metadata?.workspaceRef ? { workspaceRef: structuredClone(state.metadata.workspaceRef) } : {}),
  ...(state.metadata?.sourceToolBinding ? { sourceToolBinding: structuredClone(state.metadata.sourceToolBinding) } : {}),
  ...(state.profile.id === 'composable-workflow' ? { workflowContext: {
    workflow: structuredClone(state.metadata?.workflow ?? null),
    sourceManifest: structuredClone(state.metadata?.sourceManifest ?? null),
    memorySnapshot: structuredClone(state.metadata?.memorySnapshot ?? null),
    upstreamOutputs: Object.fromEntries(feature.dependsOn.map(id => [id, structuredClone([...state.submissions].reverse().find(submission => submission.featureId === id && !submission.supersededAt)?.result?.outputs ?? {})])),
  } } : {}),
});

const event = (state, type, payload, now) => {
  state.events.push({ sequence: state.events.length + 1, type, at: now(), epoch: state.epoch, generation: state.generation, ...structuredClone(payload) });
};

const deriveStatus = (state, profile) => {
  if (state.status === 'closed') return 'closed';
  if (state.leases.some(activeLease) || state.dispatches.some(activeDispatch)) return 'running';
  if (state.features.every(feature => feature.state === 'completed')) return profile.canClose(state).ok && qualityCanClose(state.findings) ? 'ready-to-close' : 'closure-blocked';
  const remaining = state.features.filter(feature => feature.state !== 'completed');
  if (remaining.every(feature => ['blocked', 'failed-budget', 'cancelled'].includes(feature.state))) return 'all-remaining-blocked';
  return 'ready';
};

export class HarnessKernel {
  constructor({ authorityStore, evidenceStore, profiles, now = () => new Date().toISOString(), id = newId }) {
    this.authorityStore = authorityStore;
    this.evidenceStore = evidenceStore;
    this.profiles = profiles;
    this.now = now;
    this.id = id;
  }

  profile(id) {
    const profile = this.profiles.get(id);
    assert(profile, 'PROFILE_NOT_FOUND', `Profile is not registered: ${id}`);
    return profile;
  }

  async startRun(input, command) {
    const profile = this.profile(input.profileId);
    const features = validateWorkGraph(input.features);
    const profileConfig = profile.validateConfig(structuredClone(input.profileConfig ?? {}), features);
    const at = this.now();
    const state = {
      protocolVersion: '1.0',
      projectId: safeSegment(input.projectId, 'projectId'),
      runId: safeSegment(input.runId, 'runId'),
      profile: { id: profile.id, version: profile.version, config: profileConfig },
      epoch: 1,
      generation: 1,
      status: 'ready',
      sourceDigest: input.sourceDigest,
      policyDigest: input.policyDigest ?? digestJson(profileConfig),
      pluginSetDigest: input.pluginSetDigest,
      artifactDigest: input.artifactDigest ?? null,
      metadata: structuredClone(input.metadata ?? {}),
      features,
      dispatches: [],
      leases: [],
      attempts: {},
      submissions: [],
      evidenceRefs: [],
      gates: [],
      findings: [],
      decisions: [],
      receipts: [],
      recoveryArchives: [],
      events: [{ sequence: 1, type: 'run.started', at, epoch: 1, generation: 1, profileId: profile.id }],
    };
    assert(state.sourceDigest && state.pluginSetDigest, 'RUN_DIGESTS_REQUIRED', 'Run requires source and plugin-set digests.');
    profile.validateRun(state);
    return this.authorityStore.create(state, { commandId: command.commandId, payload: input });
  }

  async schedule(projectId, runId, input, command) {
    assert(input.runtimePluginId, 'DEFAULT_RUNTIME_REQUIRED', 'Scheduling requires an explicit Runtime identity.');
    assert(['conversation-visible', 'headless'].includes(input.runtimeRequirements?.mode), 'RUNTIME_REQUIREMENTS_REQUIRED', 'Scheduling requires explicit Agent execution requirements.');
    assert(Object.values(input.executionByFeatureId ?? {}).every(execution => execution.prompt?.pluginId && execution.prompt?.pluginVersion && execution.prompt?.contractVersion), 'AGENT_PROMPT_BINDING_REQUIRED', 'Scheduling requires an exact Prompt Codec and contract binding for every candidate Feature.');
    const snapshotEvidence = await this.evidenceStore.read(input.sourceSnapshotRef);
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(snapshotEvidence.metadata.projectId === projectId && snapshotEvidence.metadata.runId === runId && snapshotEvidence.metadata.epoch === state.epoch && snapshotEvidence.metadata.generation === state.generation && snapshotEvidence.metadata.sourceDigest === state.sourceDigest, 'SOURCE_SNAPSHOT_CONTEXT_MISMATCH', 'Scheduling requires a workspace snapshot bound to the current Authority source.');
      const profile = this.profile(state.profile.id);
      const activeFeatures = [...new Set([...state.leases.filter(activeLease).map(lease => lease.featureId), ...state.dispatches.filter(activeDispatch).map(dispatch => dispatch.featureId)])];
      const capacity = Math.max(0, Number(input.maxConcurrency ?? 1) - activeFeatures.length);
      const selected = scheduleFeatures({ features: state.features, activeFeatureIds: activeFeatures, limit: capacity, canDispatch: feature => profile.canDispatch(feature, state).ok, candidateFeatureIds: input.candidateFeatureIds ?? null });
      const dispatches = selected.map(feature => {
        const dispatchId = this.id('dispatch');
        const outputRef = resolve(this.authorityStore.root, 'outputs', state.projectId, state.runId, `epoch-${state.epoch}`, `generation-${state.generation}`, `${dispatchId}.json`);
        const featureSnapshot = structuredClone(feature);
        const execution = { runtime: structuredClone(input.runtimeRequirements), ...structuredClone(input.executionByFeatureId?.[feature.id] ?? {}) };
        const gateSnapshot = structuredClone(state.gates);
        const packet = buildDispatchPacket(state, { dispatchId, outputRef, sourceDigest: state.sourceDigest, sourceSnapshotRef: input.sourceSnapshotRef, gateSnapshot, execution }, featureSnapshot);
        const dispatch = { dispatchId, featureId: feature.id, featureSnapshot, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, sourceSnapshotRef: input.sourceSnapshotRef, gateSnapshot, execution, packetDigest: digestJson(packet), outputRef, status: 'requested', requestedAt: this.now(), runtimePluginId: input.runtimePluginId ?? null };
        feature.state = 'dispatched';
        state.dispatches.push(dispatch);
        event(state, 'dispatch.requested', { dispatchId, featureId: feature.id }, this.now);
        return { ...dispatch, packet };
      });
      state.status = deriveStatus(state, profile);
      return { dispatches };
    });
  }

  async bindLease(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const dispatch = state.dispatches.find(item => item.dispatchId === input.dispatchId);
      assert(dispatch, 'DISPATCH_NOT_FOUND', `Dispatch not found: ${input.dispatchId}`);
      assert(dispatch.status === 'requested', 'DISPATCH_NOT_BINDABLE', 'Only a requested Dispatch can be bound.');
      assert(dispatch.epoch === state.epoch && dispatch.generation === state.generation, 'STALE_DISPATCH', 'Dispatch belongs to an older epoch or generation.');
      assert(input.agentId && input.runtimeReceipt?.runtimePluginId, 'RUNTIME_RECEIPT_REQUIRED', 'Lease binding requires an agent identity and Runtime Receipt.');
      assert(input.runtimeReceipt.runtimePluginId === dispatch.runtimePluginId, 'RUNTIME_RECEIPT_PLUGIN_MISMATCH', 'Runtime Receipt does not match the Runtime selected for this Dispatch.');
      if (dispatch.execution?.runtime?.mode === 'conversation-visible') {
        assert(input.runtimeReceipt.visibility?.mode === 'user-visible', 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED', 'A conversation-visible Dispatch requires a user-visible Runtime Receipt.');
        assert(typeof input.runtimeReceipt.visibility.surface === 'string' && input.runtimeReceipt.visibility.surface.length > 0, 'USER_VISIBLE_RUNTIME_SURFACE_REQUIRED', 'A conversation-visible Dispatch requires a visible surface kind.');
        assert(typeof input.runtimeReceipt.visibility.inspectRef === 'string' && input.runtimeReceipt.visibility.inspectRef.length > 0, 'USER_VISIBLE_RUNTIME_INSPECT_REF_REQUIRED', 'A conversation-visible Dispatch requires an inspectable task reference.');
        assert(input.runtimeReceipt.agentId === input.agentId && input.runtimeReceipt.dispatchId === dispatch.dispatchId && input.runtimeReceipt.packetDigest === dispatch.packetDigest, 'USER_VISIBLE_RUNTIME_BINDING_MISMATCH', 'Visible Runtime Receipt must bind the Agent, Dispatch, and immutable packet.');
        assert(input.runtimeReceipt.prompt?.codecPluginId === dispatch.execution?.prompt?.pluginId && input.runtimeReceipt.prompt?.codecPluginVersion === dispatch.execution?.prompt?.pluginVersion && input.runtimeReceipt.prompt?.contractVersion === dispatch.execution?.prompt?.contractVersion, 'AGENT_PROMPT_RECEIPT_IDENTITY_MISMATCH', 'Visible Runtime Receipt must bind the immutable Prompt Codec and contract identity.');
        assert(input.runtimeReceipt.prompt?.packetDigest === dispatch.packetDigest && /^[a-f0-9]{64}$/.test(input.runtimeReceipt.prompt?.promptDigest ?? ''), 'AGENT_PROMPT_RECEIPT_DIGEST_MISMATCH', 'Visible Runtime Receipt must bind the exact generated Prompt and Dispatch packet.');
        assert(input.runtimeReceipt.hostAttestation?.verified === true, 'VISIBLE_AGENT_HOST_ATTESTATION_REQUIRED', 'A conversation-visible Dispatch requires trusted host attestation.');
        assert(typeof input.runtimeReceipt.hostAttestation.provider === 'string' && input.runtimeReceipt.hostAttestation.provider.length > 0 && typeof input.runtimeReceipt.hostAttestation.assertionId === 'string' && input.runtimeReceipt.hostAttestation.assertionId.length > 0 && typeof input.runtimeReceipt.hostAttestation.observedAt === 'string' && !Number.isNaN(Date.parse(input.runtimeReceipt.hostAttestation.observedAt)), 'VISIBLE_AGENT_HOST_ATTESTATION_INVALID', 'Visible host attestation must include provider, assertion ID, and observation timestamp.');
        assert(input.runtimeReceipt.hostAttestation.agentId === input.agentId && input.runtimeReceipt.hostAttestation.dispatchId === dispatch.dispatchId && input.runtimeReceipt.hostAttestation.packetDigest === dispatch.packetDigest && input.runtimeReceipt.hostAttestation.promptDigest === input.runtimeReceipt.prompt.promptDigest, 'VISIBLE_AGENT_HOST_ATTESTATION_MISMATCH', 'Visible host attestation must bind the exact Agent, Dispatch, packet, and generated Prompt.');
      }
      assert(input.packetDigest === dispatch.packetDigest, 'PACKET_DIGEST_MISMATCH', 'Runtime receipt does not match the managed Dispatch packet.');
      const feature = state.features.find(item => item.id === dispatch.featureId);
      const lease = { leaseId: this.id('lease'), dispatchId: dispatch.dispatchId, featureId: feature.id, logicalRoot: feature.logicalRoot, agentId: input.agentId, runtimePluginId: input.runtimeReceipt.runtimePluginId, runtimeReceipt: structuredClone(input.runtimeReceipt), epoch: state.epoch, generation: state.generation, packetDigest: dispatch.packetDigest, outputRef: dispatch.outputRef, status: 'active', startedAt: this.now(), lastHeartbeatAt: this.now(), heartbeatCount: 0, ...(dispatch.execution?.runtime?.heartbeatTimeoutMs ? { heartbeatTimeoutMs: dispatch.execution.runtime.heartbeatTimeoutMs } : {}) };
      dispatch.status = 'assigned';
      dispatch.agentId = input.agentId;
      feature.state = 'running';
      state.leases.push(lease);
      event(state, 'lease.bound', { leaseId: lease.leaseId, dispatchId: dispatch.dispatchId, featureId: feature.id, agentId: input.agentId }, this.now);
      state.status = 'running';
      return { lease };
    });
  }

  async heartbeat(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const lease = state.leases.find(item => item.leaseId === input.leaseId);
      assert(lease?.status === 'active', 'LEASE_NOT_ACTIVE', 'Heartbeat requires an active Lease.');
      assert(lease.agentId === input.agentId && lease.epoch === state.epoch && lease.generation === state.generation, 'LEASE_IDENTITY_MISMATCH', 'Heartbeat identity does not match the active Lease.');
      lease.lastHeartbeatAt = this.now();
      lease.heartbeatCount = Number(lease.heartbeatCount ?? 0) + 1;
      lease.progress = input.progress ?? null;
      event(state, 'lease.heartbeat', { leaseId: lease.leaseId, progress: lease.progress }, this.now);
      return { leaseId: lease.leaseId, lastHeartbeatAt: lease.lastHeartbeatAt };
    });
  }

  async submit(projectId, runId, input, command) {
    const evidenceRecords = [];
    for (const ref of input.evidenceRefs ?? []) evidenceRecords.push(await this.evidenceStore.read(ref));
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const profile = this.profile(state.profile.id);
      const dispatch = state.dispatches.find(item => item.dispatchId === input.dispatchId);
      const lease = state.leases.find(item => item.dispatchId === input.dispatchId && item.status === 'active');
      assert(dispatch && lease, 'ACTIVE_LEASE_REQUIRED', 'Submission requires an active managed Lease.');
      assert(input.outputRef === dispatch.outputRef, 'OUTPUT_REF_OVERRIDE_REJECTED', 'Submission output must use the Dispatch-managed output reference.');
      assert(input.agentId === lease.agentId && input.packetDigest === lease.packetDigest, 'SUBMISSION_IDENTITY_MISMATCH', 'Submission identity does not match the Lease.');
      if (dispatch.execution?.runtime?.mode === 'conversation-visible') {
        assert(Number(lease.heartbeatCount ?? 0) > 0, 'VISIBLE_AGENT_HEARTBEAT_REQUIRED', 'Conversation-visible Agent submission requires at least one recorded host heartbeat.');
        const timeoutMs = Number(lease.heartbeatTimeoutMs ?? 120000);
        assert(Date.parse(this.now()) - Date.parse(lease.lastHeartbeatAt) < timeoutMs, 'VISIBLE_AGENT_HEARTBEAT_EXPIRED', 'Conversation-visible Agent heartbeat expired before submission.');
      }
      assert(input.epoch === state.epoch && input.generation === state.generation, 'STALE_SUBMISSION', 'Submission belongs to an older epoch or generation.');
      const feature = state.features.find(item => item.id === lease.featureId);
      if (dispatch.execution?.result) assertDispatchResultContract(dispatch.execution.result, feature, { conversationVisible: dispatch.execution?.runtime?.mode === 'conversation-visible' });
      const result = validateBusinessResult(input.result, { conversationVisible: dispatch.execution?.runtime?.mode === 'conversation-visible', repair: Boolean(feature?.metadata?.repairFindingId), feature });
      validateProfileResult({ profile, state, feature, result });
      for (const evidence of evidenceRecords) {
        const metadata = evidence.metadata;
        assert(metadata.projectId === projectId && metadata.runId === runId && metadata.epoch === state.epoch && metadata.generation === state.generation && metadata.featureId === feature.id && metadata.dispatchId === dispatch.dispatchId, 'EVIDENCE_CONTEXT_MISMATCH', 'Evidence does not belong to the active Feature Lease.', { ref: metadata.ref });
        if (state.metadata?.workspaceRef) assert(digestJson(metadata.workspaceRef) === digestJson(state.metadata.workspaceRef), 'EVIDENCE_WORKSPACE_MISMATCH', 'Evidence belongs to another Workspace revision or scope.');
        assert(metadata.sourceDigest === dispatch.sourceDigest && metadata.policyDigest === state.policyDigest && metadata.pluginSetDigest === state.pluginSetDigest, 'EVIDENCE_BASELINE_MISMATCH', 'Evidence baseline does not match the immutable Dispatch.', { ref: metadata.ref });
      }
      const changedFiles = [...new Set(result.changedFiles)].map(path => String(path).replaceAll('\\', '/'));
      const findingIntents = result.findings ?? [];
      assert(Array.isArray(findingIntents), 'RESULT_FINDINGS_INVALID', 'Result findings must be an array.');
      const findingIds = new Set();
      const reopenedFindingIds = new Set();
      const confirmedFindingIds = new Set();
      const findings = findingIntents.map(intent => {
        assert(intent && typeof intent === 'object' && !Array.isArray(intent), 'RESULT_FINDINGS_INVALID', 'Every result finding must be an object.');
        if (feature.metadata?.qualityReview === true || feature.metadata?.stage === 'quality' || feature.metadata?.stage === 'quality-recheck') {
          assert(Array.isArray(intent.evidence) && intent.evidence.length > 0, 'QUALITY_FINDING_EVIDENCE_REQUIRED', 'Every quality-review Finding requires non-empty evidence.');
          assert(Array.isArray(intent.affectedPaths) && intent.affectedPaths.length > 0, 'QUALITY_FINDING_PATH_REQUIRED', 'Every actionable quality-review Finding requires at least one affected path.');
        }
        const existingFinding = state.findings.find(item => item.id === intent?.id);
        const qualityReview = feature.metadata?.qualityReview === true || feature.metadata?.stage === 'quality-recheck';
        assert(!findingIds.has(intent?.id), 'FINDING_DUPLICATE', `Finding is duplicated in the same result: ${intent?.id}`);
        assert(!existingFinding || qualityReview, 'FINDING_DUPLICATE', `Finding already exists: ${intent?.id}`);
        findingIds.add(intent.id);
        const nextFinding = validateFinding({ ...intent, source: 'review', featureId: feature.id, evidenceRefs: input.evidenceRefs, openedAt: this.now(), status: 'open' });
        if (existingFinding?.status === 'resolved') {
          reopenedFindingIds.add(intent.id);
          nextFinding.history = [...(existingFinding.history ?? []), {
            openedAt: existingFinding.openedAt,
            resolvedAt: existingFinding.resolvedAt,
            resolution: structuredClone(existingFinding.resolution ?? null),
            resolutionEvidenceRefs: [...(existingFinding.resolutionEvidenceRefs ?? [])],
          }];
          nextFinding.reopenedAt = this.now();
        } else if (existingFinding) {
          confirmedFindingIds.add(intent.id);
          nextFinding.openedAt = existingFinding.openedAt;
          nextFinding.history = structuredClone(existingFinding.history ?? []);
          nextFinding.confirmedAt = this.now();
        }
        return nextFinding;
      });
      const pathWithin = (root, file) => file === root || file.startsWith(`${root.replace(/\/$/, '')}/`);
      for (const file of changedFiles) {
        assert(feature.allowedPaths.some(path => pathWithin(path, file)), 'FEATURE_PATH_NOT_ALLOWED', `Feature ${feature.id} changed an unauthorized path: ${file}`);
        assert(!feature.forbiddenPaths.some(path => pathWithin(path, file)), 'FEATURE_PATH_FORBIDDEN', `Feature ${feature.id} changed a forbidden path: ${file}`);
      }
      assert(input.resultingSourceDigest, 'RESULTING_SOURCE_DIGEST_REQUIRED', 'Submission requires the resulting workspace source digest.');
      if (result.status === 'completed') assert((input.evidenceRefs ?? []).length > 0, 'COMPLETION_EVIDENCE_REQUIRED', 'Completed Features require content-addressed evidence.');
      const submission = { submissionId: this.id('submission'), dispatchId: dispatch.dispatchId, leaseId: lease.leaseId, featureId: feature.id, agentId: lease.agentId, epoch: state.epoch, generation: state.generation, inputSourceDigest: dispatch.sourceDigest, outputSourceDigest: input.resultingSourceDigest, changedFiles, result: structuredClone(result), evidenceRefs: [...new Set(input.evidenceRefs ?? [])], submittedAt: this.now() };
      submission.submissionDigest = digestJson(submission);
      state.submissions.push(submission);
      for (const finding of findings) {
        const existingIndex = state.findings.findIndex(item => item.id === finding.id);
        if (existingIndex >= 0) state.findings[existingIndex] = finding;
        else state.findings.push(finding);
        event(state, reopenedFindingIds.has(finding.id) ? 'finding.reopened' : confirmedFindingIds.has(finding.id) ? 'finding.confirmed' : 'finding.opened', { id: finding.id, severity: finding.severity, featureId: feature.id }, this.now);
      }
      state.sourceDigest = submission.outputSourceDigest;
      state.evidenceRefs.push(...submission.evidenceRefs.filter(ref => !state.evidenceRefs.includes(ref)));
      lease.status = 'committed';
      lease.committedAt = this.now();
      dispatch.status = 'committed';
      dispatch.submissionId = submission.submissionId;
      feature.submissionId = submission.submissionId;
      if (result.status === 'completed') feature.state = 'completed';
      else {
        const key = `${feature.logicalRoot}:${result.failureClass ?? result.status}`;
        const attempt = state.attempts[key] ?? { key, logicalRoot: feature.logicalRoot, failureClass: result.failureClass ?? result.status, failures: 0, limit: feature.attemptLimit, records: [] };
        attempt.failures += 1;
        attempt.records.push({ dispatchId: dispatch.dispatchId, submissionId: submission.submissionId, at: this.now(), summary: result.summary ?? null });
        attempt.exhausted = attempt.failures >= attempt.limit;
        state.attempts[key] = attempt;
        feature.state = attempt.exhausted ? 'failed-budget' : 'blocked';
        feature.blocker = structuredClone(result.blocker ?? { kind: result.failureClass ?? 'execution', summary: result.summary ?? 'Feature blocked.' });
      }
      const repairFindingId = feature.metadata?.repairFindingId;
      if (result.status === 'completed' && repairFindingId) {
        const finding = state.findings.find(item => item.id === repairFindingId);
        assert(finding?.status === 'open', 'REPAIR_FINDING_NOT_OPEN', `Repair Feature is not bound to an open Finding: ${repairFindingId}`);
        assert(submission.evidenceRefs.length > 0, 'FINDING_RESOLUTION_EVIDENCE_REQUIRED', 'A completed repair Feature requires resolution Evidence.');
        const hasVerificationReceipt = evidenceRecords.some(record => {
          try { return JSON.parse(record.bytes.toString('utf8'))?.runtimeEvidence?.verificationReceipts?.length > 0; }
          catch { return false; }
        });
        assert(hasVerificationReceipt, 'REPAIR_VERIFICATION_RECEIPT_REQUIRED', 'A completed repair requires host-preserved verification Receipts.');
        finding.status = 'resolved';
        finding.resolution = { status: 'fixed', summary: result.summary };
        finding.resolutionEvidenceRefs = [...submission.evidenceRefs];
        finding.resolvedAt = this.now();
        event(state, 'finding.resolved', { id: finding.id, repairFeatureId: feature.id, evidenceRefs: submission.evidenceRefs }, this.now);
      }
      const followUps = typeof profile.createFollowUpFeatures === 'function'
        ? profile.createFollowUpFeatures({ state: structuredClone(state), feature: structuredClone(feature), findings: structuredClone(findings), result: structuredClone(result) })
        : [];
      if (followUps.length) {
        const existingIds = new Set(state.features.map(item => item.id));
        const normalized = validateWorkGraph([...state.features, ...followUps]);
        state.features.push(...normalized.filter(item => !existingIds.has(item.id)));
        for (const followUp of normalized.filter(item => !existingIds.has(item.id))) event(state, 'feature.follow-up-created', { featureId: followUp.id, sourceFeatureId: feature.id, findingId: followUp.metadata?.findingId ?? null }, this.now);
      }
      event(state, 'submission.committed', { submissionId: submission.submissionId, featureId: feature.id, status: feature.state }, this.now);
      state.status = deriveStatus(state, profile);
      return { submission, findings, featureState: feature.state, runStatus: state.status };
    });
  }

  async recordGate(projectId, runId, input, command) {
    for (const ref of input.evidenceRefs ?? []) await this.evidenceStore.read(ref);
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(input.id && ['passed', 'failed', 'environment-failed'].includes(input.status), 'GATE_RESULT_INVALID', 'Gate result requires id and a valid status.');
      const gate = { id: input.id, scope: input.scope ?? 'run', featureId: input.featureId ?? null, specDigest: input.specDigest, sourceDigest: input.sourceDigest, toolchainDigest: input.toolchainDigest, status: input.status, evidenceRefs: [...new Set(input.evidenceRefs ?? [])], forcedFresh: Boolean(input.forcedFresh), recordedAt: this.now() };
      assert(gate.specDigest && gate.sourceDigest && gate.toolchainDigest && gate.evidenceRefs.length > 0, 'GATE_EVIDENCE_INCOMPLETE', 'Gate results require spec, source, toolchain, and evidence digests.');
      assert(gate.sourceDigest === state.sourceDigest, 'GATE_SOURCE_STALE', 'Gate result does not bind the active source digest.');
      state.gates = state.gates.filter(item => !(item.id === gate.id && item.scope === gate.scope && item.featureId === gate.featureId));
      state.gates.push(gate);
      event(state, 'gate.recorded', { id: gate.id, status: gate.status, featureId: gate.featureId }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { gate };
    });
  }

  async recordFinding(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(!state.findings.some(item => item.id === input.id), 'FINDING_DUPLICATE', `Finding already exists: ${input.id}`);
      const finding = validateFinding({ ...input, openedAt: this.now(), status: 'open' });
      state.findings.push(finding);
      event(state, 'finding.opened', { id: finding.id, severity: finding.severity }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { finding };
    });
  }

  async resolveFinding(projectId, runId, input, command) {
    for (const ref of input.evidenceRefs ?? []) await this.evidenceStore.read(ref);
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const finding = state.findings.find(item => item.id === input.id);
      assert(finding?.status === 'open', 'FINDING_NOT_OPEN', `Finding is not open: ${input.id}`);
      assert((input.evidenceRefs ?? []).length > 0, 'FINDING_RESOLUTION_EVIDENCE_REQUIRED', 'Finding resolution requires evidence.');
      finding.status = 'resolved';
      finding.resolution = input.resolution;
      finding.resolutionEvidenceRefs = [...new Set(input.evidenceRefs)];
      finding.resolvedAt = this.now();
      event(state, 'finding.resolved', { id: finding.id }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { finding };
    });
  }

  async recordDecision(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(input.id && input.actor && input.decision, 'DECISION_INVALID', 'Decision requires id, actor, and decision.');
      assert(!state.decisions.some(item => item.id === input.id), 'DECISION_DUPLICATE', `Decision already exists: ${input.id}`);
      const decision = { ...structuredClone(input), recordedAt: this.now(), digest: digestJson(input) };
      state.decisions.push(decision);
      event(state, 'decision.recorded', { id: decision.id, decision: decision.decision }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { decision };
    });
  }

  async recover(projectId, runId, input, command, capability = null) {
    const verifiedEvidence = new Map();
    let recoveryVerification = null;
    let recoveryResolution = null;
    if (input.rollbackSnapshotRef) {
      const rollback = await this.evidenceStore.read(input.rollbackSnapshotRef);
      assert(rollback.metadata.projectId === projectId && rollback.metadata.runId === runId, 'RECOVERY_ROLLBACK_CONTEXT_MISMATCH', 'Recovery rollback snapshot belongs to another run.');
    }
    if (input.mode === 'hard-recovery') {
      assert(capability === hardRecoveryCapability, 'RECOVERY_COORDINATOR_REQUIRED', 'Live hard recovery must use the verified Recovery Coordinator path.');
      recoveryVerification = await readRecoveryVerification(this.evidenceStore, input.recoveryVerificationRef, { projectId, runId, now: this.now });
      if (input.recoveryResolutionRef) {
        const current = await this.authorityStore.read(projectId, runId);
        recoveryResolution = await readRecoveryResolution(this.evidenceStore, input.recoveryResolutionRef, { projectId, runId, state: current, verification: recoveryVerification, now: this.now });
      }
      for (const [featureId, refs] of Object.entries(input.verifiedEvidenceRefs ?? {})) {
        const values = [];
        for (const ref of refs) values.push(await this.evidenceStore.read(ref));
        verifiedEvidence.set(featureId, values);
      }
    }
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(['ordinary-resume', 'hard-recovery'].includes(input.mode), 'RECOVERY_MODE_INVALID', 'Recovery mode must be ordinary-resume or hard-recovery.');
      if (input.mode === 'hard-recovery') {
        assert(recoveryVerification.authorityEpoch === state.epoch && recoveryVerification.authorityGeneration === state.generation && recoveryVerification.targetEpoch === state.epoch + 1, 'RECOVERY_VERIFICATION_CONTEXT_MISMATCH', 'Recovery verification Receipt does not match the current Authority epoch and generation.');
        assert(recoveryVerification.assessmentDigest === input.assessmentDigest && recoveryVerification.sourceDigest === input.sourceDigest, 'RECOVERY_VERIFICATION_CONTEXT_MISMATCH', 'Hard recovery inputs do not match the verified Capsule.');
        if (input.recoveryResolutionRef) assert(recoveryResolution?.expectedRevision === state.revision, 'RECOVERY_RESOLUTION_CONTEXT_MISMATCH', 'Recovery Resolution does not match current Authority revision.');
        else assertHardRecoveryDecision(state, input.authorityDecisionId, recoveryVerification, this.now);
      }
      const archive = {
        epoch: state.epoch, generation: state.generation, authorityDigest: state.authorityDigest, status: state.status,
        archivedAt: this.now(), mode: input.mode, rollbackSnapshotRef: input.rollbackSnapshotRef ?? null,
        ...(input.mode === 'hard-recovery' ? { commandId: command.commandId, recoveryRequestDigest: input.recoveryRequestDigest, recoveryCallerDigest: input.recoveryCallerDigest ?? input.recoveryRequestDigest, recoveryVerificationRef: input.recoveryVerificationRef, recoveryResolutionRef: input.recoveryResolutionRef ?? null, authorityDecisionId: input.authorityDecisionId ?? null } : {}),
      };
      state.recoveryArchives.push(archive);
      state.generation += 1;
      for (const lease of state.leases.filter(activeLease)) { lease.status = 'superseded'; lease.supersededAt = this.now(); }
      for (const dispatch of state.dispatches.filter(activeDispatch)) dispatch.status = 'superseded';
      for (const feature of state.features.filter(item => ['dispatched', 'running'].includes(item.state))) feature.state = 'pending';
      if (input.mode === 'hard-recovery') {
        assert(input.assessmentDigest, 'RECOVERY_ASSESSMENT_REQUIRED', 'Hard recovery requires an assessment digest.');
        state.epoch += 1;
        for (const feature of state.features) {
          const disposition = input.dispositions?.[feature.id];
          const records = verifiedEvidence.get(feature.id) ?? [];
          if (disposition === 'verified-current') {
            assert(records.length > 0, 'RECOVERY_VERIFIED_EVIDENCE_REQUIRED', `Feature ${feature.id} cannot be verified-current without new-epoch Evidence.`);
            for (const record of records) assert(record.metadata.projectId === projectId && record.metadata.runId === runId && record.metadata.epoch === state.epoch && record.metadata.generation === state.generation && record.metadata.featureId === feature.id && record.metadata.sourceDigest === state.sourceDigest, 'RECOVERY_EVIDENCE_CONTEXT_MISMATCH', `Recovery Evidence does not bind the new epoch for ${feature.id}.`);
          }
          feature.state = disposition === 'verified-current' ? 'completed' : 'pending';
          feature.recoveryDisposition = disposition ?? 'stale-revalidate';
          feature.recoveryEvidenceRefs = records.map(record => record.metadata.ref);
          delete feature.submissionId;
          delete feature.blocker;
        }
        state.gates = [];
        state.findings = [];
        state.evidenceRefs = [...new Set([...verifiedEvidence.values()].flatMap(records => records.map(record => record.metadata.ref)))];
        state.metadata.lastRecoveryAssessmentDigest = input.assessmentDigest;
        state.metadata.lastRecoverySourceDigest = input.sourceDigest;
        state.metadata.lastRecoveryVerificationRef = input.recoveryVerificationRef;
        state.metadata.lastRecoveryDecisionId = input.authorityDecisionId;
      }
      event(state, 'run.recovered', { mode: input.mode, previous: archive, epoch: state.epoch, generation: state.generation }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { epoch: state.epoch, generation: state.generation, status: state.status };
    });
  }

  async rollbackRecovery(projectId, runId, input, command) {
    assert(input.rollbackSnapshotRef, 'RECOVERY_ROLLBACK_SNAPSHOT_REQUIRED', 'Recovery rollback requires a snapshot Evidence reference.');
    const record = await this.evidenceStore.read(input.rollbackSnapshotRef);
    assert(record.metadata.projectId === projectId && record.metadata.runId === runId, 'RECOVERY_ROLLBACK_CONTEXT_MISMATCH', 'Recovery rollback snapshot belongs to another run.');
    const snapshot = JSON.parse(record.bytes.toString('utf8'));
    assert(snapshot.projectId === projectId && snapshot.runId === runId && snapshot.authorityDigest, 'RECOVERY_ROLLBACK_SNAPSHOT_INVALID', 'Recovery rollback Evidence is not an Authority snapshot.');
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const archive = state.recoveryArchives.find(item => item.rollbackSnapshotRef === input.rollbackSnapshotRef);
      assert(archive, 'RECOVERY_ROLLBACK_NOT_LINKED', 'Snapshot is not linked to a recovery archive in the current run.');
      const previous = { epoch: state.epoch, generation: state.generation, authorityDigest: state.authorityDigest };
      state.epoch += 1;
      state.generation += 1;
      state.profile = structuredClone(snapshot.profile);
      state.sourceDigest = snapshot.sourceDigest;
      state.policyDigest = snapshot.policyDigest;
      state.pluginSetDigest = snapshot.pluginSetDigest;
      state.artifactDigest = snapshot.artifactDigest;
      state.metadata = { ...structuredClone(snapshot.metadata ?? {}), rollbackOfRecoverySnapshotRef: input.rollbackSnapshotRef };
      state.features = structuredClone(snapshot.features).map(feature => {
        const restored = { ...feature, state: feature.state === 'cancelled' ? 'cancelled' : 'pending', recoveryDisposition: 'rollback-revalidate', recoveryEvidenceRefs: [] };
        delete restored.submissionId;
        delete restored.blocker;
        return restored;
      });
      state.attempts = structuredClone(snapshot.attempts ?? {});
      state.gates = [];
      state.findings = structuredClone(snapshot.findings ?? []);
      state.decisions = structuredClone(snapshot.decisions ?? []);
      state.evidenceRefs = [];
      for (const lease of state.leases.filter(activeLease)) { lease.status = 'superseded'; lease.supersededAt = this.now(); lease.supersededReason = 'recovery-rollback'; }
      for (const dispatch of state.dispatches.filter(activeDispatch)) { dispatch.status = 'superseded'; dispatch.supersededAt = this.now(); }
      event(state, 'run.recovery-rolled-back', { rollbackSnapshotRef: input.rollbackSnapshotRef, previous, restoredAuthorityDigest: snapshot.authorityDigest, epoch: state.epoch, generation: state.generation }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { rollbackSnapshotRef: input.rollbackSnapshotRef, epoch: state.epoch, generation: state.generation, status: state.status };
    });
  }

  async reopenFeature(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      const feature = state.features.find(item => item.id === input.featureId);
      assert(feature?.state === 'blocked', 'FEATURE_NOT_REOPENABLE', 'Only a blocked Feature with remaining budget can be reopened.');
      feature.state = 'pending';
      feature.reopenedAt = this.now();
      feature.reopenReason = input.reason;
      delete feature.blocker;
      event(state, 'feature.reopened', { featureId: feature.id, reason: input.reason }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { featureId: feature.id, state: feature.state };
    });
  }

  async supersedeRun(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(state.status !== 'closed' && state.status !== 'superseded', 'RUN_NOT_SUPERSEDABLE', `Run cannot be superseded from status ${state.status}.`);
      assert(input.replacementRunId && input.planDigest, 'RUN_SUPERSEDE_CONTEXT_REQUIRED', 'Run supersede requires a replacement Run ID and Command Plan digest.');
      for (const lease of state.leases.filter(activeLease)) { lease.status = 'superseded'; lease.supersededAt = this.now(); lease.supersededReason = 'run-superseded'; }
      for (const dispatch of state.dispatches.filter(activeDispatch)) { dispatch.status = 'superseded'; dispatch.supersededAt = this.now(); dispatch.supersededReason = 'run-superseded'; }
      state.status = 'superseded';
      state.metadata = { ...(state.metadata ?? {}), supersededByRunId: input.replacementRunId, supersedePlanDigest: input.planDigest, supersededReason: input.reason ?? 'replacement-lifecycle-plan' };
      event(state, 'run.superseded', { replacementRunId: input.replacementRunId, planDigest: input.planDigest }, this.now);
      return { runId, replacementRunId: input.replacementRunId, planDigest: input.planDigest, status: state.status };
    });
  }

  async rebaseArtifact(projectId, runId, input, command) {
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      assert(input.artifactDigest && input.artifactDigest !== state.artifactDigest, 'ARTIFACT_REBASE_INVALID', 'Artifact rebase requires a new artifact digest.');
      const impacted = new Set(input.impactedFeatureIds ?? []);
      assert(impacted.size > 0 && [...impacted].every(id => state.features.some(feature => feature.id === id)), 'ARTIFACT_IMPACT_SET_INVALID', 'Artifact rebase requires a valid non-empty Feature impact set.');
      const decision = assertArtifactRebaseDecision(state, input.decisionId, input, this.now);
      const previous = state.artifactDigest;
      state.artifactDigest = input.artifactDigest;
      state.generation += 1;
      for (const lease of state.leases.filter(item => activeLease(item) && impacted.has(item.featureId))) { lease.status = 'superseded'; lease.supersededAt = this.now(); lease.supersededReason = 'artifact-rebase'; }
      for (const dispatch of state.dispatches.filter(item => activeDispatch(item) && impacted.has(item.featureId))) { dispatch.status = 'superseded'; dispatch.supersededAt = this.now(); }
      for (const feature of state.features.filter(item => impacted.has(item.id))) {
        feature.state = 'pending';
        feature.recoveryDisposition = 'artifact-rebase-required';
        delete feature.submissionId;
        delete feature.blocker;
      }
      for (const submission of state.submissions.filter(item => impacted.has(item.featureId))) { submission.supersededAt = this.now(); submission.supersededReason = 'artifact-rebase'; }
      state.gates = state.gates.filter(gate => gate.featureId && !impacted.has(gate.featureId));
      state.evidenceRefs = state.submissions.filter(item => !item.supersededAt).flatMap(item => item.evidenceRefs).filter((ref, index, values) => values.indexOf(ref) === index);
      event(state, 'artifact.rebased', { previousArtifactDigest: previous, artifactDigest: input.artifactDigest, impactedFeatureIds: [...impacted], authorityDecisionId: decision.id }, this.now);
      state.status = deriveStatus(state, this.profile(state.profile.id));
      return { previousArtifactDigest: previous, artifactDigest: input.artifactDigest, impactedFeatureIds: [...impacted], authorityDecisionId: decision.id, generation: state.generation };
    });
  }

  async closeRun(projectId, runId, input, command) {
    const current = await this.authorityStore.read(projectId, runId);
    assert(current.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before closure.', { expected: command.expectedRevision, actual: current.revision });
    const profile = this.profile(current.profile.id);
    const closure = profile.canClose(current);
    assert(current.features.every(feature => feature.state === 'completed'), 'FEATURES_INCOMPLETE', 'All Features must be completed before closure.');
    assert(qualityCanClose(current.findings), 'QUALITY_FINDINGS_OPEN', 'All P0-P3 findings must be resolved before closure.');
    assert(current.gates.every(gate => gate.status === 'passed'), 'GATES_NOT_PASSED', 'All current Gate results must pass before closure.');
    assert(closure.ok, 'PROFILE_CLOSURE_BLOCKED', closure.reason ?? 'Profile closure policy rejected the run.');
    const staged = structuredClone(current);
    staged.revision = current.revision + 1;
    staged.status = 'closed';
    staged.closedAt = this.now();
    const receipt = buildRunReceipt(staged);
    const receiptFile = await writeRunReceipt(this.authorityStore.root, receipt);
    return this.authorityStore.transact(projectId, runId, { expectedRevision: command.expectedRevision, commandId: command.commandId, payload: input }, state => {
      state.status = 'closed';
      state.closedAt = staged.closedAt;
      state.receipts.push({ kind: receipt.kind, digest: receipt.receiptDigest, file: receiptFile });
      event(state, 'run.closed', { receiptDigest: receipt.receiptDigest }, this.now);
      return { receipt, receiptFile };
    });
  }
}
