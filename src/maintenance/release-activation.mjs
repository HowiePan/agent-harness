import { copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { inspectExtensionArtifact } from '../extensions/contract.mjs';
import { ExtensionRegistry } from '../extensions/registry.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { ProjectRegistry } from '../registry/project-registry.mjs';
import { activeReleaseFile, readActiveRelease } from '../registry/active-generation.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';
import { safeSegment } from '../paths.mjs';
import { verifyReleaseManifest } from '../release-identity.mjs';
import { activateHarnessInstallationRuntime } from '../installation.mjs';

const activationRoot = dataRoot => resolve(dataRoot, 'registry', 'activations');
const activationLock = dataRoot => resolve(dataRoot, 'registry', 'release-activation.lock');
const seal = (value, key) => ({ ...value, [key]: digestJson(value) });

export const releaseActivationPlanDigest = plan => digestJson(withoutKeys(plan, ['planDigest']));

export const verifyReleaseActivationPlan = input => {
  assert(input?.protocolVersion === '1.0' && input.kind === 'release-activation-plan', 'RELEASE_ACTIVATION_PLAN_INVALID', 'Release activation plan is invalid.');
  assert(/^[a-f0-9]{64}$/.test(input.planDigest ?? '') && input.planDigest === releaseActivationPlanDigest(input), 'RELEASE_ACTIVATION_PLAN_DIGEST_MISMATCH', 'Release activation plan digest does not match its contents.');
  assert(input.release?.verified === true && /^[a-f0-9]{64}$/.test(input.release.artifactDigest ?? ''), 'RELEASE_ACTIVATION_RELEASE_INVALID', 'Release activation requires a verified candidate release.');
  assert(Array.isArray(input.extensions) && Array.isArray(input.projects), 'RELEASE_ACTIVATION_PLAN_INVALID', 'Release activation plan must include Extension and Project sets.');
  assert(input.runtime?.relativeRoot && input.runtime?.entrypoint === 'bin/agent-harness.mjs', 'RELEASE_ACTIVATION_RUNTIME_INVALID', 'Release activation plan requires an immutable runtime target.');
  return structuredClone(input);
};

export const createReleaseActivationPlan = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, releaseIdentity, projectIds = [], now = () => new Date().toISOString() } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Release activation data root', controlRoot);
  assert(releaseIdentity?.verified && releaseIdentity.version && releaseIdentity.artifactDigest, 'RELEASE_ACTIVATION_RELEASE_REQUIRED', 'Release activation requires a verified candidate release identity.');
  const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot });
  const projectRegistry = new ProjectRegistry({ root: dataRoot, controlRoot });
  const currentExtensions = await extensionRegistry.list();
  const currentProjects = await projectRegistry.list();
  const selected = projectIds.length ? currentProjects.filter(project => projectIds.includes(project.id)) : currentProjects;
  assert(selected.length === (projectIds.length || currentProjects.length), 'RELEASE_ACTIVATION_PROJECT_NOT_FOUND', 'Release activation requested an unknown Project.');
  const extensions = [];
  for (const current of currentExtensions.extensions) {
    const artifact = await inspectExtensionArtifact(resolve(controlRoot, current.entry), { controlRoot, expectedDigest: undefined, requireArtifactManifest: true });
    extensions.push({ id: current.id, version: current.version, entry: current.entry, previousDigest: current.digest, artifactDigest: artifact.digest, registeredAt: current.registeredAt, changed: current.digest !== artifact.digest });
  }
  const extensionById = new Map(extensions.map(extension => [extension.id, extension]));
  const projects = selected.map(project => ({
    id: project.id,
    expectedRevision: project.revision,
    expectedDescriptorDigest: project.descriptorDigest,
    nextHarness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest },
    nextExtensions: (project.extensions ?? []).map(required => {
      const candidate = extensionById.get(required.id);
      assert(candidate, 'RELEASE_ACTIVATION_EXTENSION_NOT_FOUND', `Project ${project.id} requires an Extension absent from the active registry: ${required.id}`);
      assert(candidate.version === required.version, 'RELEASE_ACTIVATION_EXTENSION_VERSION_MISMATCH', `Project ${project.id} requires ${required.id}@${required.version}, but the candidate artifact is ${candidate.version}.`);
      return { id: required.id, version: required.version, digest: candidate.artifactDigest };
    }),
  }));
  const pointer = await readJson(activeReleaseFile(dataRoot), null);
  const generationDigest = digestJson({ release: releaseIdentity, extensions: extensions.map(extension => ({ id: extension.id, version: extension.version, digest: extension.artifactDigest })) });
  const body = {
    protocolVersion: '1.0',
    kind: 'release-activation-plan',
    createdAt: now(),
    controlRoot,
    dataRoot,
    currentGenerationId: pointer?.generationId ?? null,
    generationId: `g-${generationDigest.slice(0, 24)}`,
    release: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest, verified: true },
    runtime: { relativeRoot: relative(controlRoot, resolve(dataRoot, 'runtimes', releaseIdentity.version, releaseIdentity.artifactDigest)).replaceAll('\\', '/'), entrypoint: 'bin/agent-harness.mjs' },
    expectedExtensionRevision: currentExtensions.revision,
    extensions,
    projects,
  };
  return verifyReleaseActivationPlan({ ...body, planDigest: releaseActivationPlanDigest(body) });
};

export const applyReleaseActivationPlan = async (planInput, { controlRoot: controlRootInput, dataRoot: dataRootInput, releaseIdentity, commandId, authorityDecision, activateInstallation = false, now = () => new Date().toISOString() } = {}) => {
  const plan = verifyReleaseActivationPlan(planInput);
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Release activation requires a command ID.');
  assert(authorityDecision?.actor && authorityDecision.decision === 'approved' && authorityDecision.action === 'release-activation', 'RELEASE_ACTIVATION_AUTHORITY_REQUIRED', 'Release activation requires an approved release-activation Decision.');
  assert(authorityDecision.context?.planDigest === plan.planDigest, 'RELEASE_ACTIVATION_DECISION_CONTEXT_MISMATCH', 'Release activation Decision does not bind the supplied plan.');
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput ?? plan.dataRoot, 'Release activation data root', controlRoot);
  assert(resolve(plan.controlRoot) === controlRoot && resolve(plan.dataRoot) === dataRoot, 'RELEASE_ACTIVATION_ROOT_MISMATCH', 'Release activation plan roots do not match the apply target.');
  assert(releaseIdentity?.verified && releaseIdentity.version === plan.release.version && releaseIdentity.artifactDigest === plan.release.artifactDigest, 'RELEASE_ACTIVATION_RELEASE_MISMATCH', 'Release activation plan does not match the active candidate release.');
  const safeCommandId = safeSegment(commandId, 'commandId');
  const receiptFile = resolve(activationRoot(dataRoot), `${safeCommandId}.json`);
  await mkdir(activationRoot(dataRoot), { recursive: true });
  return withDirectoryLock(activationLock(dataRoot), async () => {
    const prior = await readJson(receiptFile, null);
    if (prior) {
      assert(prior.planDigest === plan.planDigest, 'COMMAND_ID_REUSED', 'Release activation command ID was reused with a different plan.');
      return { receipt: prior, reused: true };
    }
    const activePointer = await readActiveRelease(dataRoot, controlRoot);
    if (activePointer?.generationId === plan.generationId && activePointer.planDigest === plan.planDigest) {
      const runtimeRoot = assertHarnessWritePath(resolve(controlRoot, plan.runtime.relativeRoot), 'Immutable release runtime', controlRoot);
      await verifyReleaseManifest({ root: runtimeRoot, artifactDigest: plan.release.artifactDigest });
      if (activateInstallation) await activateHarnessInstallationRuntime({ controlRoot, runtimeRoot, now: () => activePointer.activatedAt ?? now() });
      const recoveredBody = { protocolVersion: '1.0', kind: 'release-activation-receipt', commandId: safeCommandId, planDigest: plan.planDigest, generationId: plan.generationId, release: plan.release, projectIds: plan.projects.map(project => project.id), committedAt: activePointer.activatedAt ?? now(), authorityDecision: structuredClone(authorityDecision), recovered: true };
      const recovered = { ...recoveredBody, receiptDigest: digestJson(recoveredBody) };
      await atomicWriteJson(receiptFile, recovered, { root: dataRoot });
      return { receipt: recovered, runtimeRoot, runtimeEntrypoint: resolve(runtimeRoot, plan.runtime.entrypoint), reused: true };
    }
    assert(activePointer?.generationId !== plan.generationId, 'RELEASE_ACTIVATION_ALREADY_ACTIVE', 'The requested release generation is already active.');
    const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot });
    const projectRegistry = new ProjectRegistry({ root: dataRoot, controlRoot });
    const currentExtensions = await extensionRegistry.list();
    assert(currentExtensions.revision === plan.expectedExtensionRevision, 'RELEASE_ACTIVATION_EXTENSION_REVISION_CONFLICT', 'Extension Registry changed after the activation plan was created.');
    const currentProjects = await projectRegistry.list();
    for (const expected of plan.projects) {
      const current = currentProjects.find(project => project.id === expected.id);
      assert(current?.revision === expected.expectedRevision && current.descriptorDigest === expected.expectedDescriptorDigest, 'RELEASE_ACTIVATION_PROJECT_REVISION_CONFLICT', `Project ${expected.id} changed after the activation plan was created.`);
    }
    const verifiedRelease = await verifyReleaseManifest({ root: controlRoot, artifactDigest: plan.release.artifactDigest });
    assert(verifiedRelease.version === plan.release.version, 'RELEASE_ACTIVATION_RELEASE_MISMATCH', 'Release activation source version does not match the plan.');
    const runtimeRoot = assertHarnessWritePath(resolve(controlRoot, plan.runtime.relativeRoot), 'Immutable release runtime', controlRoot);
    const runtimeManifestFile = resolve(runtimeRoot, 'release-manifest.json');
    const existingRuntimeManifest = await readJson(runtimeManifestFile, null);
    if (existingRuntimeManifest) {
      await verifyReleaseManifest({ root: runtimeRoot, artifactDigest: plan.release.artifactDigest });
    } else {
      const stagingRoot = assertHarnessWritePath(`${runtimeRoot}.staging-${safeCommandId}`, 'Immutable release runtime staging root', controlRoot);
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(stagingRoot, { recursive: true });
      try {
        const manifest = JSON.parse(await readFile(resolve(controlRoot, 'release-manifest.json'), 'utf8'));
        for (const item of manifest.files) {
          const target = resolve(stagingRoot, item.path);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(resolve(controlRoot, item.path), target);
        }
        for (const metadataFile of manifest.metadataFiles ?? ['release-manifest.json', 'sbom.spdx.json']) {
          await mkdir(dirname(resolve(stagingRoot, metadataFile)), { recursive: true });
          await copyFile(resolve(controlRoot, metadataFile), resolve(stagingRoot, metadataFile));
        }
        await verifyReleaseManifest({ root: stagingRoot, artifactDigest: plan.release.artifactDigest });
        await mkdir(dirname(runtimeRoot), { recursive: true });
        await rename(stagingRoot, runtimeRoot);
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    }
    const generationRoot = assertHarnessWritePath(resolve(dataRoot, 'registry', 'generations', plan.generationId), 'Release activation generation', controlRoot);
    await mkdir(resolve(generationRoot, 'projects'), { recursive: true });
    const at = now();
    const commands = structuredClone(currentExtensions.commands ?? {});
    const nextExtensions = plan.extensions.map(extension => ({ id: extension.id, version: extension.version, digest: extension.artifactDigest, entry: extension.entry, registeredAt: extension.registeredAt }));
    const extensionPayload = { operation: 'release-activation', planDigest: plan.planDigest, release: plan.release, extensions: nextExtensions };
    commands[`${safeCommandId}.extensions`] = { commandId: `${safeCommandId}.extensions`, operation: 'register', requestDigest: digestJson(extensionPayload), payloadDigest: digestJson(extensionPayload), result: { release: plan.release }, revision: currentExtensions.revision + 1, committedAt: at, authorityDecision: structuredClone(authorityDecision) };
    const nextExtensionRegistry = seal({ protocolVersion: '1.0', revision: currentExtensions.revision + 1, extensions: nextExtensions, commands }, 'registryDigest');
    await atomicWriteJson(resolve(generationRoot, 'extensions.json'), nextExtensionRegistry, { root: dataRoot });
    for (const expected of plan.projects) {
      const current = currentProjects.find(project => project.id === expected.id);
      const projectCommandId = `${safeCommandId}.project.${safeSegment(expected.id, 'projectId')}`;
      const projectCommands = structuredClone(current.commands ?? {});
      const projectPayload = { operation: 'release-activation', planDigest: plan.planDigest, release: plan.release, extensions: expected.nextExtensions };
      projectCommands[projectCommandId] = { commandId: projectCommandId, payloadDigest: digestJson(projectPayload), revision: current.revision + 1, committedAt: at, authorityDecision: structuredClone(authorityDecision) };
      const descriptor = { ...structuredClone(current), harness: structuredClone(expected.nextHarness), extensions: structuredClone(expected.nextExtensions), revision: current.revision + 1, updatedAt: at, commands: projectCommands };
      descriptor.descriptorDigest = digestJson(withoutKeys(descriptor, ['descriptorDigest']));
      await atomicWriteJson(resolve(generationRoot, 'projects', `${safeSegment(expected.id, 'projectId')}.json`), descriptor, { root: dataRoot });
    }
    const selectedIds = new Set(plan.projects.map(project => project.id));
    for (const current of currentProjects.filter(project => !selectedIds.has(project.id))) {
      await atomicWriteJson(resolve(generationRoot, 'projects', `${safeSegment(current.id, 'projectId')}.json`), current, { root: dataRoot });
    }
    const pointerBody = { protocolVersion: '1.0', kind: 'active-release', generationId: plan.generationId, runtimeRoot: plan.runtime.relativeRoot, runtimeEntrypoint: `${plan.runtime.relativeRoot}/${plan.runtime.entrypoint}`, release: plan.release, planDigest: plan.planDigest, activatedAt: at };
    const pointer = { ...pointerBody, pointerDigest: digestJson(pointerBody) };
    await atomicWriteJson(activeReleaseFile(dataRoot), pointer, { root: dataRoot });
    if (activateInstallation) await activateHarnessInstallationRuntime({ controlRoot, runtimeRoot, now: () => at });
    const receiptBody = { protocolVersion: '1.0', kind: 'release-activation-receipt', commandId: safeCommandId, planDigest: plan.planDigest, generationId: plan.generationId, release: plan.release, projectIds: plan.projects.map(project => project.id), committedAt: at, authorityDecision: structuredClone(authorityDecision) };
    const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
    await atomicWriteJson(receiptFile, receipt, { root: dataRoot });
    return { receipt, runtimeRoot, runtimeEntrypoint: resolve(runtimeRoot, plan.runtime.entrypoint), reused: false };
  }, { root: dataRoot });
};
