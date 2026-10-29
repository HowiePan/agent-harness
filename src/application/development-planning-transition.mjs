import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { HarnessKernel } from '../kernel/kernel.mjs';
import { loadExtensionPack } from '../platform/extensions/contract.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { createLocalDevelopmentInvocation, decisionFromLocalDevelopmentInvocation } from './local-development-invocation.mjs';

/** Fence the idle old Run before rebinding H4; no lifecycle intent or Agent is started. */
export const freezeDevelopmentPlanningTransition = async ({ plan, manifest, preview, commandId, cwd }) => {
  assert(plan.level === 'H4' && preview.transition === 'freeze-until-amendment' && preview.inspection.commandReady,
    'DEVELOPMENT_PLANNING_TRANSITION_INVALID', 'Freeze requires a verified bounded amendment preview.');
  const invocation = await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot,
    configPath: manifest.configPath, controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const extensions = await Promise.all(config.request.extensions.map(item => loadExtensionPack(item.module,
    { cwd: manifest.controlRoot, controlRoot: manifest.controlRoot })));
  const generator = extensions.find(item => item.id === config.request.project.generatorExtensionId);
  const descriptor = generator.operations.createProjectDescriptor(config.request.project.input);
  const snapshot = await captureWorkspace(manifest.projectRoot, { excluded: descriptor.workspace.excluded ?? [] });
  assert(snapshot.digest === preview.inspection.workspaceSourceDigest
    && digestJson(descriptor.policy.planChangeRequests[preview.inspection.selector]) === preview.inspection.changeRequestDigest,
  'DEVELOPMENT_PLANNING_TRANSITION_STALE', 'Planning inputs changed after the read-only preview.');
  const authorityStore = new AuthorityStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot });
  const prior = await authorityStore.read(preview.projectId, preview.priorRunId);
  assert(prior.authorityDigest === preview.priorAuthorityDigest,
    'DEVELOPMENT_PLANNING_TRANSITION_STALE', 'Run Authority changed after preview.');
  const existing = prior.decisions.find(item => item.action === 'freeze-execution' && item.decision === 'approved'
    && item.context?.replacementArtifactDigest === plan.after.runtimeDigest
    && item.context?.changeRequestDigest === preview.inspection.changeRequestDigest);
  if (existing) return { decisionId: existing.id, runId: prior.runId, revision: prior.revision,
    authorityDigest: prior.authorityDigest, sourceDigest: prior.sourceDigest, reused: true };
  const approval = decisionFromLocalDevelopmentInvocation(invocation, { action: 'freeze-execution',
    planDigest: plan.planDigest, commandId, projectId: prior.projectId, runId: prior.runId,
    priorAuthorityDigest: prior.authorityDigest, sourceDigest: prior.sourceDigest,
    replacementArtifactDigest: plan.after.runtimeDigest, inspectionDigest: digestJson(preview.inspection),
    changeRequestDigest: preview.inspection.changeRequestDigest, selector: preview.inspection.selector });
  const kernel = new HarnessKernel({ authorityStore, evidenceStore: new EvidenceStore({ root: manifest.dataRoot,
    controlRoot: manifest.controlRoot }), profiles: new Map(extensions.flatMap(item => item.profiles ?? []).map(profile => [profile.id, profile])) });
  const frozen = await kernel.recordDecision(prior.projectId, prior.runId, approval,
    { expectedRevision: prior.revision, commandId: `${commandId}.freeze` });
  assert(digestJson(frozen.state.attempts) === digestJson(prior.attempts)
    && frozen.state.sourceDigest === prior.sourceDigest && digestJson(frozen.state.submissions) === digestJson(prior.submissions),
  'DEVELOPMENT_PLANNING_TRANSITION_CHANGED_PROGRESS', 'Execution freeze cannot change source, history or budgets.');
  return { decisionId: approval.id, runId: prior.runId, revision: frozen.state.revision,
    authorityDigest: frozen.state.authorityDigest, sourceDigest: prior.sourceDigest, reused: false };
};
