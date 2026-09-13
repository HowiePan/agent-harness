import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { createRecoveryCapsule, verifyRecoveryCapsule } from './capsule.mjs';

export class RecoveryCoordinator {
  constructor({ kernel, importers, dataRoot = kernel.authorityStore.root, controlRoot }) {
    this.kernel = kernel;
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

  async verifyCapsule(capsuleRoot) { return verifyRecoveryCapsule(capsuleRoot, { controlRoot: this.controlRoot }); }

  async plan({ importerId, legacyRoot, projectId, runId }) {
    const assessment = await this.assess(importerId, { legacyRoot });
    const state = await this.kernel.authorityStore.read(projectId, runId);
    const body = {
      protocolVersion: '1.0', projectId, runId, importerId, assessmentDigest: assessment.assessmentDigest,
      legacySourceDigest: assessment.sourceDigest, currentAuthorityDigest: state.authorityDigest,
      currentEpoch: state.epoch, proposedEpoch: state.epoch + 1,
      dispositions: Object.fromEntries(state.features.map(feature => [feature.id, 'stale-revalidate'])),
      invalidLegacyTransports: assessment.facts.filter(fact => fact.disposition === 'invalid').map(fact => fact.id),
    };
    return { ...body, planDigest: digestJson(body), assessment };
  }

  async hardRecover({ projectId, runId, assessment, dispositions = {}, verifiedEvidenceRefs = {} }, command) {
    assert(assessment?.assessmentDigest && assessment?.sourceDigest, 'RECOVERY_ASSESSMENT_INVALID', 'Hard recovery requires a complete assessment.');
    const current = await this.kernel.authorityStore.read(projectId, runId);
    assert(current.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before recovery snapshot.', { expected: command.expectedRevision, actual: current.revision });
    const rollbackSnapshot = await this.kernel.evidenceStore.put(current, {
      mediaType: 'application/json', projectId, runId, epoch: current.epoch, generation: current.generation,
      sourceDigest: current.sourceDigest, artifactDigest: current.artifactDigest, policyDigest: current.policyDigest,
      pluginSetDigest: current.pluginSetDigest, labels: ['recovery-rollback-snapshot'],
    });
    return this.kernel.recover(projectId, runId, {
      mode: 'hard-recovery', assessmentDigest: assessment.assessmentDigest, sourceDigest: assessment.sourceDigest,
      dispositions, verifiedEvidenceRefs, rollbackSnapshotRef: rollbackSnapshot.ref,
    }, command);
  }

  async rollback({ projectId, runId, rollbackSnapshotRef }, command) {
    return this.kernel.rollbackRecovery(projectId, runId, { rollbackSnapshotRef }, command);
  }
}
