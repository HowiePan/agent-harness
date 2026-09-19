import { resolve } from 'node:path';
import { digestJson } from '../canonical.mjs';
import { safeSegment } from '../paths.mjs';
import { atomicWriteJson } from './atomic-io.mjs';

export const buildRunReceipt = state => {
  const receipt = {
    protocolVersion: '1.0',
    kind: 'run-closure',
    projectId: state.projectId,
    ...(state.metadata?.workspaceRef ? { workspaceRef: structuredClone(state.metadata.workspaceRef) } : {}),
    runId: state.runId,
    profileId: state.profile.id,
    profileVersion: state.profile.version,
    epoch: state.epoch,
    generation: state.generation,
    authorityRevision: state.revision,
    sourceDigest: state.sourceDigest,
    policyDigest: state.policyDigest,
    pluginSetDigest: state.pluginSetDigest,
    featureResults: state.features.map(feature => ({ id: feature.id, logicalRoot: feature.logicalRoot, state: feature.state, submissionId: feature.submissionId ?? null })),
    gateResults: state.gates.map(gate => ({ id: gate.id, status: gate.status, evidenceRefs: gate.evidenceRefs })),
    findingResults: state.findings.map(finding => ({ id: finding.id, severity: finding.severity, status: finding.status, resolutionEvidenceRefs: finding.resolutionEvidenceRefs })),
    decisionRefs: state.decisions.map(decision => decision.id),
    closedAt: state.closedAt,
  };
  return { ...receipt, receiptDigest: digestJson(receipt) };
};

export const writeRunReceipt = async (root, receipt) => {
  const file = resolve(root, 'receipts', safeSegment(receipt.projectId), safeSegment(receipt.runId), `${safeSegment(receipt.receiptDigest)}.json`);
  await atomicWriteJson(file, receipt, { root });
  return file;
};
