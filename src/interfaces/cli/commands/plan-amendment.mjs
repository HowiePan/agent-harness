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
import { assertAmendmentDocumentPins, compactPlanAmendmentDelta, materializePlanAmendment, planAmendmentReference, readPlanAmendmentScope } from '../../../application/plan-amendment-artifacts.mjs';
import { captureAmendmentBaselines } from '../../../application/plan-amendment-baseline.mjs';
import { digestAmendmentJson, parseAmendmentJson } from '../../../flows/delivery-lifecycle/amendment-json.mjs';
import { inspectPlanAmendment } from '../../../application/plan-amendment-inspection.mjs';

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
  const bindingsDir = resolve(manifest.dataRoot, 'development', 'local-codex', '.plugin-data');
  let localRouteVerified = null;
  try { await readFile(resolve(bindingsDir, 'bindings.json')); localRouteVerified = false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (localRouteVerified === false) {
    const { resolveLocalSourceProjectBindingsDir } = await import('../../../../integrations/codex/agent-harness-codex/hooks/local-source-route.mjs');
    const selected = await resolveLocalSourceProjectBindingsDir({ cwd: manifest.projectRoot,
      projectAlias: config.request.binding.alias, defaultBindingsDir: bindingsDir });
    const matches = process.platform === 'win32' ? resolve(selected).toLowerCase() === bindingsDir.toLowerCase() : resolve(selected) === bindingsDir;
    assert(matches, 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH', 'Amend inspection must match the actual local route binding.');
    localRouteVerified = true;
  }
  const inspection = await inspectPlanAmendment({ project, selector, workflowId: selectedWorkflow, workspaceRoot: manifest.projectRoot,
    authorityStore: new AuthorityStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot }),
    evidenceStore: new EvidenceStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot }) });
  return { ...inspection, localRouteVerified };
};

export const materializeDevelopmentAmendment = async ({ manifestFile, runId, patchFile, compact = false }) => {
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
  const original = parseAmendmentJson(await readFile(path, 'utf8'));
  const patch = compact ? await compactPlanAmendmentDelta({ revision: state.metadata.planRevision,
    patch: original, workspaceRoot: manifest.projectRoot }) : original;
  const materialized = await materializePlanAmendment({ revision: state.metadata.planRevision, patch, workspaceRoot: manifest.projectRoot });
  const impact = materialized.plan.amendment;
  return { ok: true, outputValue: planAmendmentReference(materialized), artifacts: materialized.artifacts,
    ...(compact ? { compaction: { sourceDeltaDigest: digestAmendmentJson(original),
      sourceBytes: Buffer.byteLength(JSON.stringify(original)), deltaBytes: Buffer.byteLength(JSON.stringify(materialized.patch)),
      equivalence: 'same-result-as-input-delta' } } : {}),
    impact: { affectedFeatureIds: impact.affectedFeatureIds, modifiedFeatureIds: impact.modifiedFeatureIds,
      downstreamFeatureIds: impact.downstreamFeatureIds, deltaDigest: impact.deltaDigest },
    authorityModified: false, implementationStarted: false };
};
