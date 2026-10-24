import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../../../common/errors.mjs';
import { digestJson, sha256 } from '../../../common/canonical.mjs';
import { assertNoLinkPath } from '../../../common/paths.mjs';
import { AuthorityStore } from '../../../kernel/authority-store.mjs';
import { EvidenceStore } from '../../../kernel/evidence-store.mjs';
import { captureWorkspace } from '../../../common/workspace-snapshot.mjs';
import { ProjectRegistry } from '../../../platform/registry/project-registry.mjs';
import { ExtensionRegistry } from '../../../platform/extensions/registry.mjs';
import { verifyDevelopmentSourceManifest } from '../../../application/development-source.mjs';
import { createLocalDevelopmentInvocation } from '../../../application/local-development-invocation.mjs';
import { loadProjectHarnessConfig } from '../../../application/project-initialization.mjs';
import { selectPlanRevisionParent, preparePlanRevisionIntent } from '../../../application/plan-revision.mjs';
import { assertAmendmentDocumentPins, materializePlanAmendment, planAmendmentReference, readPlanAmendmentScope } from '../../../application/plan-amendment-artifacts.mjs';
import { captureAmendmentBaselines } from '../../../application/plan-amendment-baseline.mjs';
import { parseAmendmentJson } from '../../../flows/delivery-lifecycle/amendment-json.mjs';

export const resolveAmendmentWorkflow = ({ project, boundExtension, profileId, workflowId }) => {
  const workflows = project.workflows?.length ? project.workflows : (boundExtension.workflows ?? []).filter(item => item.profileId === profileId);
  const selected = workflowId ?? (workflows.length === 1 ? workflows[0].id : null);
  assert(selected && workflows.some(item => item.id === selected)
    && boundExtension.workflows.some(item => item.id === selected && item.profileId === profileId),
  'PLAN_AMENDMENT_WORKFLOW_REQUIRED', 'Select an exact registered Workflow.');
  return selected;
};

export const inspectDevelopmentAmendment = async ({ manifestFile, selector, workflowId = null }) => {
  const verified = await verifyDevelopmentSourceManifest(manifestFile);
  const manifest = verified.manifest;
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const registry = new ProjectRegistry({ root: manifest.dataRoot, controlRoot: manifest.controlRoot });
  const project = await registry.get(config.request.binding.projectId);
  const request = project.policy?.planChangeRequests?.[selector];
  assert(request, 'PLAN_AMENDMENT_SCOPE_REQUIRED', 'Select an exact registered change request.');
  const scope = await readPlanAmendmentScope(request, manifest.projectRoot);
  const boundExtension = await new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true })
    .loadOne(config.request.binding.extensionId);
  assert(project.extensions.some(item => item.id === boundExtension.id && item.digest === boundExtension.digest),
    'PLAN_AMENDMENT_WORKFLOW_REQUIRED', 'The bound Extension identity must match the Project.');
  const selectedWorkflow = resolveAmendmentWorkflow({ project, boundExtension, workflowId, profileId: config.request.binding.profileId });
  const states = await new AuthorityStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot }).list(project.id);
  // Read-only lookup/validation only: this does not mint a Hook intent, compile a lifecycle Plan or mutate Authority.
  const lookup = { action: 'amend', target: request.target, workflowId: selectedWorkflow, selector };
  const parent = selectPlanRevisionParent({ intent: lookup, states });
  const context = preparePlanRevisionIntent({ intent: lookup, states, project, sourceDigest: parent?.sourceDigest, amendmentScope: scope });
  assertAmendmentDocumentPins(context.planRevision);
  for (const document of scope.documents) {
    const path = assertNoLinkPath(manifest.projectRoot, resolve(manifest.projectRoot, document.source.path), 'amendment input');
    assert(sha256(await readFile(path)) === document.source.sha256,
      'PLAN_AMENDMENT_INPUT_STALE', `Amendment input changed: ${document.source.path}`);
  }
  const baselines = await captureAmendmentBaselines({ states, revision: context.planRevision,
    snapshot: await captureWorkspace(manifest.projectRoot, { excluded: project.workspace.excluded ?? [] }),
    evidenceStore: new EvidenceStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot }), project });
  return { kind: 'plan-amendment-inspection', projectId: project.id, projectRevision: project.revision,
    workflowId: selectedWorkflow, selector, changeRequestDigest: digestJson(request),
    baseRunId: parent.runId, basePlanDigest: context.planRevision.parentPlanDigest,
    scope, idleImplementationRuns: context.planRevision.affectedImplementationRuns,
    replacesAmendment: context.planRevision.replacesAmendment ?? null,
    baselines: baselines.map(item => ({ runId: item.runId, sourceDigest: item.sourceDigest,
      snapshotEvidenceRef: item.snapshotEvidenceRef, completedProposalIds: item.completed.map(entry => entry.proposalId) })),
    commandReady: true, executionReady: false, runCreated: false, implementationStarted: false };
};

export const materializeDevelopmentAmendment = async ({ manifestFile, runId, patchFile }) => {
  const { manifest } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const state = await new AuthorityStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot })
    .read(config.request.binding.projectId, runId);
  const feature = state.features.find(item => item.state === 'running' && item.metadata?.stage === 'version-planning');
  assert(state.metadata?.commandIntent?.action === 'amend' && feature
    && state.leases.some(item => item.status === 'active' && item.featureId === feature.id),
  'PLAN_AMENDMENT_ACTIVE_DISPATCH_REQUIRED', 'Materialization requires the active amendment-planning Dispatch.');
  const path = assertNoLinkPath(manifest.projectRoot, resolve(patchFile), 'amendment delta');
  const scope = state.metadata.planRevision.amendmentScope;
  assert(path.startsWith(`${resolve(manifest.projectRoot, scope.artifactRoot)}${process.platform === 'win32' ? '\\' : '/'}`),
    'PLAN_AMENDMENT_SCOPE_VIOLATION', 'Draft delta must be inside the registered amendment artifact root.');
  const patch = parseAmendmentJson(await readFile(path, 'utf8'));
  const materialized = await materializePlanAmendment({ revision: state.metadata.planRevision, patch, workspaceRoot: manifest.projectRoot });
  const impact = materialized.plan.amendment;
  return { ok: true, outputValue: planAmendmentReference(materialized), artifacts: materialized.artifacts,
    impact: { affectedFeatureIds: impact.affectedFeatureIds, modifiedFeatureIds: impact.modifiedFeatureIds,
      downstreamFeatureIds: impact.downstreamFeatureIds, deltaDigest: impact.deltaDigest },
    authorityModified: false, implementationStarted: false };
};
