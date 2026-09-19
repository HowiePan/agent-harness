import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertHardRecoveryDecision, hardRecoveryCapability } from './authorization.mjs';
import { createRecoveryCapsule, verifyRecoveryCapsule } from './capsule.mjs';
import { readRecoveryVerification, recoveryVerificationMediaType, sealRecoveryVerification } from './verification.mjs';
import { recordLegacySourceUnavailable } from './source-disposition.mjs';
import { assertRecoveryResolution, readRecoveryResolution, recoveryResolutionMediaType, sealRecoveryResolution } from './resolution.mjs';

export class RecoveryCoordinator {
  #kernel;
  #projectRegistry;

  constructor({ kernel, importers, projectRegistry = null, dataRoot = kernel.authorityStore.root, controlRoot }) {
    this.#kernel = kernel;
    this.#projectRegistry = projectRegistry;
    this.dataRoot = dataRoot;
    this.controlRoot = controlRoot;
    this.importers = new Map(importers.map(importer => [importer.id, importer]));
  }

  async assess(importerId, input) {
    const importer = this.importers.get(importerId);
    assert(importer, 'LEGACY_IMPORTER_NOT_FOUND', `Legacy Importer not found: ${importerId}`);
    return importer.inventory(input);
  }

  async createCapsule({ importerId, legacyRoot, capsuleId, commandId, maxBytes, maxFiles }) {
    const importer = this.importers.get(importerId);
    assert(importer, 'LEGACY_IMPORTER_NOT_FOUND', `Legacy Importer not found: ${importerId}`);
    return createRecoveryCapsule({ importer, legacyRoot, dataRoot: this.dataRoot, controlRoot: this.controlRoot, capsuleId, commandId, maxBytes, maxFiles });
  }

  async recordUnavailableSource({ importerId, projectId, legacyRoot, decision }, command) {
    const importer = this.importers.get(importerId);
    assert(importer, 'LEGACY_IMPORTER_NOT_FOUND', 'Legacy Importer not found: ' + importerId);
    return recordLegacySourceUnavailable({ projectId, legacyRoot, importer, decision, expectedRevision: command?.expectedRevision, commandId: command?.commandId, dataRoot: this.dataRoot, controlRoot: this.controlRoot, now: this.#kernel.now });
  }

  async verifyCapsule(capsuleRoot, { projectId, runId, ttlMs = 60 * 60 * 1000 } = {}) {
    assert(projectId && runId, 'RECOVERY_VERIFICATION_CONTEXT_REQUIRED', 'Capsule verification requires a project and run context.');
    assert(Number.isInteger(ttlMs) && ttlMs > 0, 'RECOVERY_VERIFICATION_TTL_INVALID', 'Capsule verification TTL must be a positive integer.');
    const state = await this.#kernel.authorityStore.read(projectId, runId);
    const verified = await verifyRecoveryCapsule(capsuleRoot, { controlRoot: this.controlRoot });
    const importer = this.importers.get(verified.manifest.importer.id);
    assert(importer && importer.version === verified.manifest.importer.version, 'RECOVERY_CAPSULE_IMPORTER_UNAVAILABLE', 'The exact Recovery Capsule importer is not installed.');
    const verifiedAt = this.#kernel.now();
    const receipt = sealRecoveryVerification({
      protocolVersion: '1.0', kind: 'recovery-capsule-verification', verifiedAt,
      expiresAt: new Date(Date.parse(verifiedAt) + ttlMs).toISOString(),
      capsuleRoot: verified.root, capsuleId: verified.manifest.capsuleId,
      capsuleManifestDigest: verified.manifest.manifestDigest, importer: structuredClone(verified.manifest.importer),
      sourceDigest: verified.manifest.sourceDigest, assessmentDigest: verified.manifest.assessmentDigest,
      projectId, runId, authorityEpoch: state.epoch, authorityGeneration: state.generation, targetEpoch: state.epoch + 1,
      fileCount: verified.manifest.fileCount, totalBytes: verified.manifest.totalBytes,
    });
    const evidence = await this.#kernel.evidenceStore.put(receipt, {
      mediaType: recoveryVerificationMediaType, projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId, epoch: state.epoch, generation: state.generation,
      sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
      pluginSetDigest: state.pluginSetDigest, labels: ['recovery-capsule-verification'],
    });
    return { ...verified, verification: { ...receipt, verificationRef: evidence.ref } };
  }

  async plan({ importerId, legacyRoot, projectId, runId }) {
    const assessment = await this.assess(importerId, { legacyRoot });
    const state = await this.#kernel.authorityStore.read(projectId, runId);
    const body = {
      protocolVersion: '1.0', projectId, runId, importerId, assessmentDigest: assessment.assessmentDigest,
      legacySourceDigest: assessment.sourceDigest, currentAuthorityDigest: state.authorityDigest,
      currentEpoch: state.epoch, proposedEpoch: state.epoch + 1,
      dispositions: Object.fromEntries(state.features.map(feature => [feature.id, 'stale-revalidate'])),
      invalidLegacyTransports: assessment.facts.filter(fact => fact.disposition === 'invalid').map(fact => fact.id),
    };
    return { ...body, planDigest: digestJson(body), assessment };
  }

  async resolveHardRecovery({ projectId, runId, verificationRef, authorityBasis = 'explicit-recover-command', planDigest = null, ttlMs = 60 * 60 * 1000 }, command) {
    assert(command?.commandId, 'COMMAND_ID_REQUIRED', 'Recovery resolution requires a stable command ID.');
    assert(Number.isInteger(command?.expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'Recovery resolution requires an expected Authority revision.');
    const state = await this.#kernel.authorityStore.read(projectId, runId);
    const project = this.#projectRegistry ? await this.#projectRegistry.get(projectId) : null;
    assert(project?.policy?.recovery?.automaticVerifiedHardRecovery !== false, 'HARD_RECOVERY_POLICY_DENIED', 'Project recovery policy denies automatic verified hard recovery.');
    assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before recovery resolution.', { expected: command.expectedRevision, actual: state.revision });
    const verification = await readRecoveryVerification(this.#kernel.evidenceStore, verificationRef, { projectId, runId, state, now: this.#kernel.now });
    const createdAt = this.#kernel.now();
    const receipt = sealRecoveryResolution({
      protocolVersion: '1.0', kind: 'recovery-resolution', authorityBasis, projectId, runId,
      logicalTaskKey: state.metadata?.logicalTaskKey ?? null, planDigest: planDigest ?? state.metadata?.lifecyclePlanDigest ?? null,
      verificationRef, authorityEpoch: state.epoch, authorityGeneration: state.generation, expectedRevision: state.revision,
      targetEpoch: state.epoch + 1, action: 'hard-recovery', reasonCode: 'VERIFIED_CAPSULE_REQUIRES_NEW_EPOCH',
      effectClasses: ['authority-epoch-transition', 'completion-revalidation', 'rollback-snapshot', 'transport-invalidation'],
      createdAt, expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    });
    assertRecoveryResolution(receipt, { projectId, runId, state, verification, now: this.#kernel.now });
    const evidence = await this.#kernel.evidenceStore.put(receipt, {
      mediaType: recoveryResolutionMediaType, projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId, epoch: state.epoch, generation: state.generation,
      sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
      pluginSetDigest: state.pluginSetDigest, labels: ['recovery-resolution'],
    });
    return { receipt, resolutionRef: evidence.ref };
  }

  async hardRecover({ projectId, runId, verificationRef, resolutionRef = null, decisionId = null, dispositions = {}, verifiedEvidenceRefs = {} }, command) {
    assert(command?.commandId, 'COMMAND_ID_REQUIRED', 'Live hard recovery requires a stable command ID.');
    assert(Number.isInteger(command?.expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'Live hard recovery requires an expected Authority revision.');
    assert(verificationRef, 'RECOVERY_VERIFICATION_REQUIRED', 'Live hard recovery requires a Recovery Capsule verification reference.');
    const callerDigest = digestJson({ projectId, runId, verificationRef, resolutionRef, decisionId, dispositions, verifiedEvidenceRefs });
    let current = await this.#kernel.authorityStore.read(projectId, runId);
    const prior = current.commands?.[command.commandId];
    if (prior) {
      const archive = current.recoveryArchives.find(item => item.commandId === command.commandId);
      assert(archive?.recoveryCallerDigest === callerDigest, 'COMMAND_ID_REUSED', 'The hard-recovery command ID was already used with a different request.', { commandId: command.commandId });
      return { state: current, receipt: prior, result: structuredClone(prior.result), reused: true };
    }
    if (!resolutionRef && !decisionId) {
      const resolved = await this.resolveHardRecovery({ projectId, runId, verificationRef }, { expectedRevision: command.expectedRevision, commandId: `${command.commandId}.resolve` });
      resolutionRef = resolved.resolutionRef;
    }
    const requestDigest = digestJson({ projectId, runId, verificationRef, resolutionRef, decisionId, dispositions, verifiedEvidenceRefs });
    current = await this.#kernel.authorityStore.read(projectId, runId);
    assert(current.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before recovery snapshot.', { expected: command.expectedRevision, actual: current.revision });
    const verification = await readRecoveryVerification(this.#kernel.evidenceStore, verificationRef, { projectId, runId, state: current, now: this.#kernel.now });
    const capsule = await verifyRecoveryCapsule(verification.capsuleRoot, { controlRoot: this.controlRoot });
    assert(capsule.manifest.manifestDigest === verification.capsuleManifestDigest && capsule.manifest.sourceDigest === verification.sourceDigest && capsule.manifest.assessmentDigest === verification.assessmentDigest, 'RECOVERY_CAPSULE_CHANGED_AFTER_VERIFICATION', 'Recovery Capsule changed after its verification Receipt was issued.');
    const importer = this.importers.get(verification.importer.id);
    assert(importer && importer.version === verification.importer.version, 'RECOVERY_CAPSULE_IMPORTER_UNAVAILABLE', 'The exact Recovery Capsule importer is not installed.');
    if (resolutionRef) await readRecoveryResolution(this.#kernel.evidenceStore, resolutionRef, { projectId, runId, state: current, verification, now: this.#kernel.now });
    else assertHardRecoveryDecision(current, decisionId, verification, this.#kernel.now);
    const rollbackSnapshot = await this.#kernel.evidenceStore.put(current, {
      mediaType: 'application/json', projectId, ...(current.metadata?.workspaceRef ? { workspaceRef: current.metadata.workspaceRef } : {}), runId, epoch: current.epoch, generation: current.generation,
      sourceDigest: current.sourceDigest, artifactDigest: current.artifactDigest, policyDigest: current.policyDigest,
      pluginSetDigest: current.pluginSetDigest, labels: ['recovery-rollback-snapshot'],
    });
    return this.#kernel.recover(projectId, runId, {
      mode: 'hard-recovery', assessmentDigest: verification.assessmentDigest, sourceDigest: verification.sourceDigest,
      importer: structuredClone(verification.importer), recoveryVerificationRef: verificationRef, recoveryResolutionRef: resolutionRef, authorityDecisionId: decisionId,
      recoveryRequestDigest: requestDigest, recoveryCallerDigest: callerDigest, dispositions, verifiedEvidenceRefs, rollbackSnapshotRef: rollbackSnapshot.ref,
    }, command, hardRecoveryCapability);
  }

  async rollback({ projectId, runId, rollbackSnapshotRef }, command) {
    return this.#kernel.rollbackRecovery(projectId, runId, { rollbackSnapshotRef }, command);
  }
}
