import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { selectPlanRevisionParent, preparePlanRevisionIntent } from './plan-revision.mjs';
import { assertAmendmentDocumentPins, readPlanAmendmentScope } from './plan-amendment-artifacts.mjs';
import { captureAmendmentBaselines } from './plan-amendment-baseline.mjs';

/** Shared read-only inspection for current bindings and future-source migration previews. */
export const inspectPlanAmendment = async ({ project, selector, workflowId, workspaceRoot, authorityStore, evidenceStore }) => {
  const request = project.policy?.planChangeRequests?.[selector];
  assert(request, 'PLAN_AMENDMENT_SCOPE_REQUIRED', 'Select an exact registered change request.');
  const scope = await readPlanAmendmentScope(request, workspaceRoot);
  const states = await authorityStore.list(project.id);
  const lookup = { action: 'amend', target: request.target, workflowId, selector };
  const parent = selectPlanRevisionParent({ intent: lookup, states });
  const context = preparePlanRevisionIntent({ intent: lookup, states, project, sourceDigest: parent?.sourceDigest, amendmentScope: scope });
  assertAmendmentDocumentPins(context.planRevision);
  for (const document of scope.documents) {
    const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, document.source.path), 'amendment input');
    assert(sha256(await readFile(path)) === document.source.sha256,
      'PLAN_AMENDMENT_INPUT_STALE', `Amendment input changed: ${document.source.path}`);
  }
  const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  const baselines = await captureAmendmentBaselines({ states, revision: context.planRevision,
    snapshot, evidenceStore, project });
  return { kind: 'plan-amendment-inspection', projectId: project.id, projectRevision: project.revision ?? null,
    workflowId, selector, changeRequestDigest: digestJson(request), workspaceSourceDigest: snapshot.digest,
    baseRunId: parent.runId, basePlanDigest: context.planRevision.parentPlanDigest,
    scope, idleImplementationRuns: context.planRevision.affectedImplementationRuns,
    replacesAmendment: context.planRevision.replacesAmendment ?? null,
    baselines: baselines.map(item => ({ runId: item.runId, sourceDigest: item.sourceDigest,
      snapshotEvidenceRef: item.snapshotEvidenceRef, completedProposalIds: item.completed.map(entry => entry.proposalId) })),
    commandReady: true, executionReady: false, runCreated: false, implementationStarted: false };
};
