import { assert } from '../errors.mjs';

export const assertArtifactRebaseDecision = (state, decisionId, input, now = () => new Date().toISOString()) => {
  assert(decisionId, 'ARTIFACT_REBASE_DECISION_REQUIRED', 'Artifact rebase requires an approved Authority Decision.');
  const decision = state.decisions.find(item => item.id === decisionId);
  assert(decision, 'ARTIFACT_REBASE_DECISION_REQUIRED', 'Artifact rebase Authority Decision is not recorded in the current run.');
  assert(decision.actor && decision.decision === 'approved' && decision.action === 'artifact-rebase', 'ARTIFACT_REBASE_DECISION_REJECTED', 'Authority Decision does not approve artifact rebase.');
  assert(typeof decision.expiresAt === 'string' && !Number.isNaN(Date.parse(decision.expiresAt)) && Date.parse(decision.expiresAt) > Date.parse(now()), 'ARTIFACT_REBASE_DECISION_EXPIRED', 'Artifact rebase Authority Decision is expired or has no valid expiry.');
  const expectedFeatures = [...new Set(input.impactedFeatureIds ?? [])].sort();
  const actualFeatures = [...new Set(decision.context?.impactedFeatureIds ?? [])].sort();
  const context = decision.context ?? {};
  assert(
    context.projectId === state.projectId
      && context.runId === state.runId
      && context.expectedRevision === state.revision
      && context.previousArtifactDigest === state.artifactDigest
      && context.artifactDigest === input.artifactDigest
      && JSON.stringify(actualFeatures) === JSON.stringify(expectedFeatures),
    'ARTIFACT_REBASE_DECISION_CONTEXT_MISMATCH',
    'Artifact rebase Authority Decision does not match the run, revision, artifact identities, and impact set.',
  );
  return decision;
};
