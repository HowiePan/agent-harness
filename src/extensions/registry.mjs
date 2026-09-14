import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { assertNoLinkPath } from '../paths.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';
import { extensionIdentity, inspectExtensionArtifact, loadExtensionPack, resolveExtensionModule } from './contract.mjs';
import { assertJsonSchema } from '../json-schema.mjs';
import { resolveActiveRegistryRoot } from '../registry/active-generation.mjs';
import { activeReleaseFile } from '../registry/active-generation.mjs';

const seal = value => ({ ...value, registryDigest: digestJson(value) });
const emptyRegistry = () => seal({ protocolVersion: '1.0', revision: 0, extensions: [], commands: {} });
const registrySchema = JSON.parse(readFileSync(new URL('../../schemas/extension-installation.schema.json', import.meta.url), 'utf8'));

export class ExtensionRegistry {
  constructor({ dataRoot, controlRoot, now = () => new Date().toISOString() }) {
    this.controlRoot = resolve(controlRoot);
    this.dataRoot = assertHarnessWritePath(dataRoot, 'Extension Registry data root', this.controlRoot);
    this.legacyFile = resolve(this.dataRoot, 'registry', 'extensions.json');
    this.lock = `${this.legacyFile}.lock`;
    this.now = now;
  }

  async filePath() { return resolve(await resolveActiveRegistryRoot(this.dataRoot, this.controlRoot), 'extensions.json'); }

  async list() {
    const registry = await readJson(await this.filePath(), emptyRegistry());
    assertJsonSchema(registry, registrySchema, { code: 'EXTENSION_REGISTRY_SCHEMA_INVALID', label: 'Extension Registry' });
    assert(registry.registryDigest === digestJson(withoutKeys(registry, ['registryDigest'])), 'EXTENSION_REGISTRY_DIGEST_MISMATCH', 'Extension Registry digest mismatch.');
    return registry;
  }

  async loadInstalled() {
    const current = await this.list();
    const packs = [];
    for (const receipt of current.extensions) {
      const entry = assertNoLinkPath(this.controlRoot, resolve(this.controlRoot, receipt.entry), 'Registered Extension entrypoint');
      const pack = await loadExtensionPack(entry, { controlRoot: this.controlRoot, expectedDigest: receipt.digest, requireArtifactManifest: true });
      assert(pack.id === receipt.id && pack.version === receipt.version, 'EXTENSION_INSTALLATION_IDENTITY_MISMATCH', `Registered Extension ${receipt.id} no longer matches its installation receipt.`);
      packs.push(pack);
    }
    return packs;
  }

  async loadOne(id) {
    const current = await this.list();
    const receipt = current.extensions.find(item => item.id === id);
    assert(receipt, 'EXTENSION_NOT_REGISTERED', `Extension is not registered: ${id}`);
    const entry = assertNoLinkPath(this.controlRoot, resolve(this.controlRoot, receipt.entry), 'Registered Extension entrypoint');
    const pack = await loadExtensionPack(entry, { controlRoot: this.controlRoot, expectedDigest: receipt.digest, requireArtifactManifest: true });
    assert(pack.id === receipt.id && pack.version === receipt.version, 'EXTENSION_INSTALLATION_IDENTITY_MISMATCH', `Registered Extension ${receipt.id} no longer matches its installation receipt.`);
    return pack;
  }

  async loadOneArtifact(id) {
    const current = await this.list();
    const receipt = current.extensions.find(item => item.id === id);
    assert(receipt, 'EXTENSION_NOT_REGISTERED', `Extension is not registered: ${id}`);
    const entry = assertNoLinkPath(this.controlRoot, resolve(this.controlRoot, receipt.entry), 'Registered Extension entrypoint');
    const artifact = await inspectExtensionArtifact(entry, { controlRoot: this.controlRoot, expectedDigest: receipt.digest, requireArtifactManifest: true });
    return { receipt: structuredClone(receipt), artifact };
  }

  async verifyInstalled() {
    const current = await this.list();
    const verified = [];
    for (const receipt of current.extensions) {
      const entry = assertNoLinkPath(this.controlRoot, resolve(this.controlRoot, receipt.entry), 'Registered Extension entrypoint');
      await inspectExtensionArtifact(entry, { controlRoot: this.controlRoot, expectedDigest: receipt.digest, requireArtifactManifest: true });
      verified.push(structuredClone(receipt));
    }
    return { ...current, extensions: verified };
  }

  async register(moduleSpecifier, { cwd = process.cwd(), expectedRevision, commandId, authorityDecision } = {}) {
    assert(commandId, 'COMMAND_ID_REQUIRED', 'Extension Registry writes require a command ID.');
    const resolvedPath = assertNoLinkPath(this.controlRoot, resolveExtensionModule(moduleSpecifier, { cwd }), 'Extension entrypoint');
    const requestDigest = digestJson({ operation: 'register', entry: relative(this.controlRoot, resolvedPath).replaceAll('\\', '/') });
    const preliminary = await this.list();
    const existingCommand = preliminary.commands?.[commandId];
    if (existingCommand) {
      assert(existingCommand.requestDigest === requestDigest, 'COMMAND_ID_REUSED', 'Extension Registry command ID was reused with a different request.');
      return structuredClone(existingCommand.result);
    }
    assert(!(await readJson(activeReleaseFile(this.dataRoot), null)), 'ACTIVE_RELEASE_IMMUTABLE', 'Active release generations are immutable; use release activation to update trusted Extensions.');
    assert(Number.isInteger(expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'Extension Registry writes require a numeric expected revision.');
    assert(preliminary.revision === expectedRevision, 'EXTENSION_REGISTRY_REVISION_CONFLICT', 'Extension Registry revision changed.', { expected: expectedRevision, actual: preliminary.revision });
    assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'EXTENSION_AUTHORITY_DECISION_REQUIRED', 'Installing or updating trusted Extension code requires an approved Authority Decision.');
    const pack = await loadExtensionPack(resolvedPath, { controlRoot: this.controlRoot, requireArtifactManifest: true });
    const payloadDigest = digestJson({ operation: 'register', id: pack.id, version: pack.version, digest: pack.digest, entry: relative(this.controlRoot, resolvedPath).replaceAll('\\', '/') });
    await mkdir(this.dataRoot, { recursive: true });
    assertHarnessWritePath(this.dataRoot, 'Extension Registry data root', this.controlRoot);
    return withDirectoryLock(this.lock, async () => {
      const current = await this.list();
      const priorCommand = current.commands?.[commandId];
      if (priorCommand) {
        assert(priorCommand.requestDigest === requestDigest, 'COMMAND_ID_REUSED', 'Extension Registry command ID was reused with a different request.');
        return structuredClone(priorCommand.result);
      }
      assert(Number.isInteger(expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'Extension Registry writes require a numeric expected revision.');
      assert(current.revision === expectedRevision, 'EXTENSION_REGISTRY_REVISION_CONFLICT', 'Extension Registry revision changed.', { expected: expectedRevision, actual: current.revision });
      assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'EXTENSION_AUTHORITY_DECISION_REQUIRED', 'Installing or updating trusted Extension code requires an approved Authority Decision.');
      const prior = current.extensions.find(item => item.id === pack.id);
      const receipt = {
        ...extensionIdentity(pack),
        entry: relative(this.controlRoot, resolvedPath).replaceAll('\\', '/'),
        registeredAt: prior?.registeredAt ?? this.now(),
      };
      const extensions = [...current.extensions.filter(item => item.id !== pack.id), receipt].sort((a, b) => a.id.localeCompare(b.id));
      const commands = structuredClone(current.commands ?? {});
      commands[commandId] = { commandId, operation: 'register', requestDigest, payloadDigest, result: receipt, revision: current.revision + 1, committedAt: this.now(), authorityDecision: structuredClone(authorityDecision) };
      const next = seal({ protocolVersion: '1.0', revision: current.revision + 1, extensions, commands });
      assertJsonSchema(next, registrySchema, { code: 'EXTENSION_REGISTRY_SCHEMA_INVALID', label: 'Extension Registry' });
      const file = await this.filePath();
      await mkdir(resolve(file, '..'), { recursive: true });
      await atomicWriteJson(file, next, { root: this.dataRoot });
      return receipt;
    }, { root: this.dataRoot });
  }

  async remove(id, { expectedRevision, commandId, authorityDecision } = {}) {
    assert(commandId, 'COMMAND_ID_REQUIRED', 'Extension Registry writes require a command ID.');
    assert(!(await readJson(activeReleaseFile(this.dataRoot), null)), 'ACTIVE_RELEASE_IMMUTABLE', 'Active release generations are immutable; use release activation to remove trusted Extensions.');
    const payloadDigest = digestJson({ operation: 'remove', id });
    await mkdir(this.dataRoot, { recursive: true });
    assertHarnessWritePath(this.dataRoot, 'Extension Registry data root', this.controlRoot);
    return withDirectoryLock(this.lock, async () => {
      const current = await this.list();
      const priorCommand = current.commands?.[commandId];
      if (priorCommand) {
        assert(priorCommand.requestDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Extension Registry command ID was reused with a different request.');
        return structuredClone(priorCommand.result);
      }
      assert(Number.isInteger(expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'Extension Registry writes require a numeric expected revision.');
      assert(current.revision === expectedRevision, 'EXTENSION_REGISTRY_REVISION_CONFLICT', 'Extension Registry revision changed.', { expected: expectedRevision, actual: current.revision });
      assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'EXTENSION_AUTHORITY_DECISION_REQUIRED', 'Removing trusted Extension code requires an approved Authority Decision.');
      const existing = current.extensions.find(item => item.id === id);
      assert(existing, 'EXTENSION_NOT_REGISTERED', `Extension is not registered: ${id}`);
      const commands = structuredClone(current.commands ?? {});
      commands[commandId] = { commandId, operation: 'remove', requestDigest: payloadDigest, payloadDigest, result: existing, revision: current.revision + 1, committedAt: this.now(), authorityDecision: structuredClone(authorityDecision) };
      const next = seal({ protocolVersion: '1.0', revision: current.revision + 1, extensions: current.extensions.filter(item => item.id !== id), commands });
      assertJsonSchema(next, registrySchema, { code: 'EXTENSION_REGISTRY_SCHEMA_INVALID', label: 'Extension Registry' });
      await atomicWriteJson(await this.filePath(), next, { root: this.dataRoot });
      return existing;
    }, { root: this.dataRoot });
  }
}
