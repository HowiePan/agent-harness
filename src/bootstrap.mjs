import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestJson } from './canonical.mjs';
import { assert } from './errors.mjs';
import { inspectExtensionArtifact } from './extensions/contract.mjs';
import { ExtensionRegistry } from './extensions/registry.mjs';
import { assertJsonSchema } from './json-schema.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from './kernel/atomic-io.mjs';
import { AuthorityStore } from './kernel/authority-store.mjs';
import { safeSegment, slash } from './paths.mjs';
import { inspectLifecycleReadiness } from './readiness.mjs';
import { ProjectRegistry } from './registry/project-registry.mjs';
import { assertProjectDescriptorInput } from './registry/project-contract.mjs';
import { assertHarnessWritePath, harnessControlRoot } from './write-boundary.mjs';
import { activeReleaseFile } from './registry/active-generation.mjs';

const requestSchema = JSON.parse(readFileSync(new URL('../schemas/bootstrap-request.schema.json', import.meta.url), 'utf8'));

export const validateBootstrapRequest = input => {
  assertJsonSchema(input, requestSchema, { code: 'BOOTSTRAP_REQUEST_INVALID', label: 'Bootstrap request' });
  assert(new Set(input.extensions.map(item => item.id)).size === input.extensions.length, 'BOOTSTRAP_EXTENSION_DUPLICATE', 'Bootstrap request repeats an Extension ID.');
  assert(input.extensions.some(item => item.id === input.project.generatorExtensionId), 'BOOTSTRAP_GENERATOR_EXTENSION_REQUIRED', 'Bootstrap descriptor generator must be included in the requested Extension set.');
  assert(input.extensions.some(item => item.id === input.binding.extensionId), 'BOOTSTRAP_BOUND_EXTENSION_REQUIRED', 'Bootstrap bound Extension must be included in the requested Extension set.');
  assert(isAbsolute(input.binding.workspaceRoot), 'BOOTSTRAP_WORKSPACE_INVALID', 'Bootstrap binding workspaceRoot must be absolute.');
  if (input.project.input.id !== undefined) assert(input.project.input.id === input.binding.projectId, 'BOOTSTRAP_PROJECT_ID_MISMATCH', 'Bootstrap generator input and binding project IDs differ.');
  if (input.project.input.workspaceRoot !== undefined) assert(resolve(input.project.input.workspaceRoot) === resolve(input.binding.workspaceRoot), 'BOOTSTRAP_WORKSPACE_MISMATCH', 'Bootstrap generator input and binding workspace roots differ.');
  return structuredClone(input);
};

export const verifyBootstrapPlan = plan => {
  assert(plan?.protocolVersion === '1.0' && plan.kind === 'bootstrap-plan', 'BOOTSTRAP_PLAN_INVALID', 'Bootstrap plan is invalid.');
  assert(/^[a-f0-9]{64}$/.test(plan.planDigest ?? ''), 'BOOTSTRAP_PLAN_INVALID', 'Bootstrap plan requires a SHA-256 digest.');
  assert(plan.planDigest === digestJson(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest'))), 'BOOTSTRAP_PLAN_DIGEST_MISMATCH', 'Bootstrap plan digest mismatch.');
  validateBootstrapRequest(plan.request);
  return structuredClone(plan);
};

export const createBootstrapPlan = async (input, { controlRoot: controlRootInput, dataRoot: dataRootInput, releaseIdentity } = {}) => {
  const request = validateBootstrapRequest(input);
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput ?? resolve(controlRoot, '.agent-harness-data'), 'Harness dataRoot', controlRoot);
  assert(!(await readJson(activeReleaseFile(dataRoot), null)), 'BOOTSTRAP_REQUIRES_RELEASE_ACTIVATION', 'An initialized active release must be upgraded through release activation, not Bootstrap.');
  assert(releaseIdentity?.verified && /^\d+\.\d+\.\d+$/.test(releaseIdentity.version ?? '') && /^[a-f0-9]{64}$/.test(releaseIdentity.artifactDigest ?? ''), 'BOOTSTRAP_RELEASE_IDENTITY_REQUIRED', 'Bootstrap requires a verified Harness release identity.');
  const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot });
  const extensionState = await extensionRegistry.list();
  const projectRegistry = new ProjectRegistry({ controlRoot, root: dataRoot });
  const existingProjectRevision = await projectRegistry.getPersistedRevision(request.binding.projectId);
  const extensions = [];
  for (const requested of request.extensions) {
    const artifact = await inspectExtensionArtifact(requested.module, { controlRoot, requireArtifactManifest: true });
    const entry = slash(relative(controlRoot, artifact.resolvedPath));
    assert(entry && !entry.startsWith('../'), 'BOOTSTRAP_EXTENSION_OUTSIDE_CONTROL_ROOT', 'Bootstrap Extension must be inside the control root.', { module: requested.module });
    const existing = extensionState.extensions.find(item => item.id === requested.id) ?? null;
    const action = existing && existing.version === requested.version && existing.digest === artifact.digest && existing.entry === entry ? 'reuse' : 'register';
    extensions.push({ id: requested.id, version: requested.version, entry, artifactDigest: artifact.digest, action });
  }
  const body = {
    protocolVersion: '1.0',
    kind: 'bootstrap-plan',
    request,
    harness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
    controlRoot,
    dataRoot,
    expectedExtensionRevision: extensionState.revision,
    expectedProjectRevision: existingProjectRevision,
    extensions,
  };
  return { ...body, planDigest: digestJson(body) };
};

export const applyBootstrapPlan = async (planInput, { controlRoot: controlRootInput, dataRoot: dataRootInput, releaseIdentity, commandId, authorityDecision, now = () => new Date().toISOString() } = {}) => {
  const plan = verifyBootstrapPlan(planInput);
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Bootstrap apply requires a command ID.');
  assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'BOOTSTRAP_AUTHORITY_DECISION_REQUIRED', 'Bootstrap apply requires an approved Authority Decision.');
  const safeCommandId = safeSegment(commandId, 'commandId');
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput ?? plan.dataRoot, 'Harness dataRoot', controlRoot);
  assert(resolve(plan.controlRoot) === controlRoot && resolve(plan.dataRoot) === dataRoot, 'BOOTSTRAP_PLAN_ROOT_MISMATCH', 'Bootstrap plan roots do not match the apply target.');
  assert(releaseIdentity?.verified && plan.harness.version === releaseIdentity.version && plan.harness.artifactDigest === releaseIdentity.artifactDigest, 'BOOTSTRAP_RELEASE_IDENTITY_MISMATCH', 'Bootstrap plan does not match the active Harness release.');
  const journalFile = assertHarnessWritePath(resolve(dataRoot, 'registry', 'bootstrap', `${safeCommandId}.json`), 'Bootstrap journal', controlRoot);
  await mkdir(dataRoot, { recursive: true });
  return withDirectoryLock(`${journalFile}.lock`, async () => {
    const prior = await readJson(journalFile, null);
    if (prior) {
      assert(prior.planDigest === plan.planDigest, 'COMMAND_ID_REUSED', 'Bootstrap command ID was reused with a different plan.');
      if (prior.status === 'committed') return { receipt: prior, reused: true };
    } else {
      const fresh = await createBootstrapPlan(plan.request, { controlRoot, dataRoot, releaseIdentity });
      assert(fresh.planDigest === plan.planDigest, 'BOOTSTRAP_PLAN_STALE', 'Bootstrap state changed after the plan was created.', { expected: plan.planDigest, actual: fresh.planDigest });
      await atomicWriteJson(journalFile, { protocolVersion: '1.0', kind: 'bootstrap-receipt', commandId: safeCommandId, planDigest: plan.planDigest, status: 'prepared', preparedAt: now(), authorityDecision: structuredClone(authorityDecision) }, { root: dataRoot });
    }

    const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot, now });
    let revision = plan.expectedExtensionRevision;
    for (const extension of plan.extensions) {
      if (extension.action === 'reuse') continue;
      const receipt = await extensionRegistry.register(resolve(controlRoot, extension.entry), { expectedRevision: revision, commandId: `${safeCommandId}.extension.${extension.id}`, authorityDecision });
      assert(receipt.id === extension.id && receipt.version === extension.version && receipt.digest === extension.artifactDigest, 'BOOTSTRAP_EXTENSION_IDENTITY_MISMATCH', `Bootstrap Extension identity mismatch: ${extension.id}`);
      revision += 1;
    }

    await new AuthorityStore({ root: dataRoot, controlRoot, now }).init();
    const generator = await extensionRegistry.loadOne(plan.request.project.generatorExtensionId);
    assert(typeof generator.operations.createProjectDescriptor === 'function', 'BOOTSTRAP_DESCRIPTOR_GENERATOR_MISSING', 'Bootstrap generator Extension does not provide createProjectDescriptor().');
    const draft = generator.operations.createProjectDescriptor(plan.request.project.input);
    assert(draft.id === plan.request.binding.projectId, 'BOOTSTRAP_PROJECT_ID_MISMATCH', 'Generated Project Descriptor does not match the binding project ID.');
    assert(draft.profiles.includes(plan.request.binding.profileId), 'BOOTSTRAP_PROFILE_MISMATCH', 'Generated Project Descriptor does not include the bound Profile.');
    assert(resolve(draft.workspace.root) === resolve(plan.request.binding.workspaceRoot), 'BOOTSTRAP_WORKSPACE_MISMATCH', 'Generated Project Descriptor does not match the bound workspace.');
    const installed = (await extensionRegistry.verifyInstalled()).extensions;
    const descriptor = {
      ...draft,
      harness: structuredClone(plan.harness),
      extensions: (draft.extensions ?? []).map(required => {
        const found = installed.find(item => item.id === required.id);
        assert(found && found.version === required.version, 'BOOTSTRAP_PROJECT_EXTENSION_MISSING', `Generated Project Descriptor requires an unavailable Extension: ${required.id}`);
        return { id: required.id, version: required.version, digest: found.digest };
      }),
    };
    assertProjectDescriptorInput(descriptor);
    const projectRegistry = new ProjectRegistry({ root: dataRoot, controlRoot, now });
    const project = await projectRegistry.register(descriptor, { expectedRevision: plan.expectedProjectRevision, commandId: `${safeCommandId}.project.${descriptor.id}`, authorityDecision });
    const readiness = await inspectLifecycleReadiness({ controlRoot, dataRoot, releaseIdentity, projectId: plan.request.binding.projectId, profileId: plan.request.binding.profileId, extensionId: plan.request.binding.extensionId, executionWorkspaceRoot: plan.request.binding.workspaceRoot });
    assert(readiness.lifecycleReady, 'BOOTSTRAP_READINESS_FAILED', 'Bootstrap completed writes but project-scoped lifecycle readiness did not pass.', { projectReadiness: readiness.projectReadiness });
    const receiptBody = { protocolVersion: '1.0', kind: 'bootstrap-receipt', commandId: safeCommandId, planDigest: plan.planDigest, status: 'committed', projectId: project.id, projectRevision: project.revision, descriptorDigest: project.descriptorDigest, extensionRegistryRevision: readiness.extensionRegistryRevision, committedAt: now(), authorityDecision: structuredClone(authorityDecision), readiness };
    const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
    await atomicWriteJson(journalFile, receipt, { root: dataRoot });
    return { receipt, reused: false };
  }, { root: dataRoot });
};
