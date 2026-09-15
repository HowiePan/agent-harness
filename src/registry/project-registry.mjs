import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { safeSegment } from '../paths.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';
import { assertProjectDescriptorInput, assertProjectDescriptorRecord } from './project-contract.mjs';
import { resolveActiveRegistryRoot } from './active-generation.mjs';
import { activeReleaseFile } from './active-generation.mjs';

export class ProjectRegistry {
  constructor({ root, controlRoot, now = () => new Date().toISOString(), strictIdentity = true }) {
    this.root = assertHarnessWritePath(root, 'Project Registry root', controlRoot);
    this.legacyDirectory = resolve(this.root, 'registry', 'projects');
    this.now = now;
    this.strictIdentity = strictIdentity;
  }

  async directoryPath() { return resolve(await resolveActiveRegistryRoot(this.root, this.controlRoot), 'projects'); }
  async file(id) { return resolve(await this.directoryPath(), `${safeSegment(id, 'projectId')}.json`); }

  async register(input, { expectedRevision = 0, commandId, authorityDecision = null } = {}) {
    assert(!(await readJson(activeReleaseFile(this.root), null)), 'ACTIVE_RELEASE_IMMUTABLE', 'Active release generations are immutable; use release activation to update Project Descriptors.');
    assert(input.id && input.workspace?.root && isAbsolute(input.workspace.root), 'PROJECT_DESCRIPTOR_INVALID', 'Project Descriptor requires an ID and absolute workspace root.');
    const workspaceRoot = resolve(input.workspace.root);
    const dataRelative = relative(workspaceRoot, this.root);
    assert(dataRelative.startsWith('..') || isAbsolute(dataRelative), 'STATE_ROOT_INSIDE_WORKSPACE', 'Harness dataRoot must not be inside the business workspace.', { workspaceRoot, dataRoot: this.root });
    if (this.strictIdentity) assert(input.harness && /^\d+\.\d+\.\d+$/.test(input.harness.version ?? '') && /^[a-f0-9]{64}$/.test(input.harness.artifactDigest ?? ''), 'PROJECT_HARNESS_IDENTITY_REQUIRED', 'Production Project Descriptors require an exact Harness version and artifact digest.');
    else if (input.harness) assert(/^\d+\.\d+\.\d+$/.test(input.harness.version ?? '') && (!input.harness.artifactDigest || /^[a-f0-9]{64}$/.test(input.harness.artifactDigest)), 'PROJECT_HARNESS_IDENTITY_INVALID', 'Project Descriptor Harness identity requires a semantic version and optional SHA-256 artifact digest.');
    assert(Array.isArray(input.profiles) && input.profiles.length > 0, 'PROJECT_PROFILES_REQUIRED', 'Project Descriptor requires at least one Profile.');
    assert(['conversation-visible', 'headless'].includes(input.policy?.agentExecutionMode), 'PROJECT_AGENT_EXECUTION_MODE_REQUIRED', 'Project Descriptor must explicitly select conversation-visible or headless Agent execution.');
    assert(typeof input.policy?.defaultRuntimePlugin === 'string' && input.policy.defaultRuntimePlugin.length > 0, 'PROJECT_DEFAULT_RUNTIME_REQUIRED', 'Project Descriptor requires an explicit default Agent Runtime.');
    assert(Array.isArray(input.policy?.runtimePlugins) && input.policy.runtimePlugins.includes(input.policy.defaultRuntimePlugin), 'PROJECT_RUNTIME_ALLOWLIST_INVALID', 'Project Descriptor runtimePlugins must include its default Agent Runtime.');
    assert(typeof input.policy?.promptCodecPlugin === 'string' && input.policy.promptCodecPlugin.length > 0, 'PROJECT_PROMPT_CODEC_REQUIRED', 'Project Descriptor requires an explicit Prompt Codec.');
    assert(input.workspace.rootSelector === undefined || input.workspace.rootSelector === 'git-worktree', 'PROJECT_WORKSPACE_SELECTOR_INVALID', 'Project Descriptor workspace rootSelector must be git-worktree when present.');
    assert(Array.isArray(input.extensions ?? []), 'PROJECT_EXTENSIONS_INVALID', 'Project Descriptor extensions must be an array.');
    const extensionIds = new Set();
    for (const extension of input.extensions ?? []) {
      assert(extension?.id && /^[a-z0-9][a-z0-9.-]+$/.test(extension.id) && /^\d+\.\d+\.\d+$/.test(extension.version ?? ''), 'PROJECT_EXTENSION_INVALID', 'Every Project Extension requires a stable ID and semantic version.');
      if (this.strictIdentity) assert(/^[a-f0-9]{64}$/.test(extension.digest ?? ''), 'PROJECT_EXTENSION_DIGEST_REQUIRED', `Production Project Extension ${extension.id} requires an exact artifact digest.`);
      assert(!extension.digest || /^[a-f0-9]{64}$/.test(extension.digest), 'PROJECT_EXTENSION_DIGEST_INVALID', `Project Extension ${extension.id} digest must be SHA-256.`);
      assert(!extensionIds.has(extension.id), 'PROJECT_EXTENSION_DUPLICATE', `Project Descriptor repeats Extension ${extension.id}.`);
      extensionIds.add(extension.id);
    }
    assertProjectDescriptorInput(input, { strictIdentity: this.strictIdentity });
    assert(commandId, 'COMMAND_ID_REQUIRED', 'Project Registry writes require a command ID.');
    const directory = await this.directoryPath();
    await mkdir(directory, { recursive: true });
    const file = await this.file(input.id);
    return withDirectoryLock(`${file}.lock`, async () => {
      const current = await readJson(file, null);
      const payloadDigest = digestJson(input);
      const prior = current?.commands?.[commandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Project Registry command ID was reused with a different payload.');
        return current;
      }
      assert((current?.revision ?? 0) === expectedRevision, 'PROJECT_REVISION_CONFLICT', 'Project Descriptor revision changed.', { expected: expectedRevision, actual: current?.revision ?? 0 });
      if (current) {
        const priorHighImpact = digestJson({ harness: current.harness ?? null, workspace: current.workspace, profiles: current.profiles, extensions: current.extensions ?? [], policy: current.policy ?? {}, gateRecipes: current.gateRecipes ?? [], artifactProviders: current.artifactProviders ?? [] });
        const nextHighImpact = digestJson({ harness: input.harness ?? null, workspace: input.workspace, profiles: input.profiles, extensions: input.extensions ?? [], policy: input.policy ?? {}, gateRecipes: input.gateRecipes ?? [], artifactProviders: input.artifactProviders ?? [] });
        if (priorHighImpact !== nextHighImpact) assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'PROJECT_AUTHORITY_DECISION_REQUIRED', 'High-impact Project Descriptor changes require an approved Authority Decision.');
      }
      const at = this.now();
      const commands = structuredClone(current?.commands ?? {});
      commands[commandId] = { commandId, payloadDigest, revision: expectedRevision + 1, committedAt: at, authorityDecision: authorityDecision ? structuredClone(authorityDecision) : null };
      const descriptor = { ...structuredClone(input), protocolVersion: '1.0', revision: expectedRevision + 1, updatedAt: at, commands };
      descriptor.descriptorDigest = digestJson(withoutKeys(descriptor, ['descriptorDigest']));
      assertProjectDescriptorRecord(descriptor, { strictIdentity: this.strictIdentity });
      await atomicWriteJson(file, descriptor, { root: this.root });
      return descriptor;
    }, { root: this.root });
  }

  async get(id) {
    const descriptor = await readJson(await this.file(id));
    assert(descriptor.descriptorDigest === digestJson(withoutKeys(descriptor, ['descriptorDigest'])), 'PROJECT_DESCRIPTOR_DIGEST_MISMATCH', 'Project Descriptor digest mismatch.');
    assertProjectDescriptorRecord(descriptor, { strictIdentity: this.strictIdentity });
    return descriptor;
  }

  async list() {
    let names;
    try { names = await readdir(await this.directoryPath()); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(name => this.get(name.slice(0, -5))));
  }
}
