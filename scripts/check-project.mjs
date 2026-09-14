import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '../src/plugins/contracts.mjs';
import { digestJson } from '../src/canonical.mjs';
import { assertSchemaDefinition, validateJsonSchema } from '../src/json-schema.mjs';
import { createCardWorldProjectDescriptor } from '../src/consumers/cardworld-engine.mjs';
import { createTabletopCollectionProjectDescriptor } from '../src/consumers/tabletop-collection.mjs';
import { validateReleaseVersionContract } from './release-version-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const errors = [];
const schemas = new Map();
if (packageJson.version !== '1.0.0') errors.push('package version must be 1.0.0');
if (packageJson.license !== 'UNLICENSED') errors.push('package license must match the owner-approved all-rights-reserved policy');
if (!packageJson.releaseMetadata?.createdAt || Number.isNaN(Date.parse(packageJson.releaseMetadata.createdAt))) errors.push('package release metadata requires a deterministic createdAt timestamp');
if (Object.keys(packageJson.dependencies ?? {}).length) errors.push('runtime dependencies are not allowed in the reference package');
for (const target of Object.values(packageJson.exports)) {
  const checkTarget = target.includes('*') ? target.slice(0, target.indexOf('*')) : target;
  try { await access(resolve(root, checkTarget)); } catch { errors.push(`missing export target: ${target}`); }
}
try { await access(resolve(root, packageJson.bin['agent-harness'])); } catch { errors.push('missing CLI target'); }
for (const name of await readdir(resolve(root, 'schemas'))) {
  if (!name.endsWith('.json')) continue;
  try {
    const schema = JSON.parse(await readFile(resolve(root, 'schemas', name), 'utf8'));
    assertSchemaDefinition(schema);
    schemas.set(name, schema);
  } catch (error) { errors.push(`invalid JSON Schema: schemas/${name}: ${error.code ?? error.message}`); }
}
for (const [name, schema] of schemas) {
  const visitReferences = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && !value.$ref.startsWith('#')) {
      const referenced = value.$ref.split('#')[0];
      if (!schemas.has(referenced)) errors.push(`unresolved JSON Schema reference: schemas/${name} -> ${value.$ref}`);
    }
    for (const child of Object.values(value)) visitReferences(child);
  };
  visitReferences(schema);
}
for (const directory of ['profiles', 'plugins']) {
  for (const name of await readdir(resolve(root, directory))) {
    if (!name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await readFile(resolve(root, directory, name), 'utf8'));
      if (directory === 'plugins') {
        validatePluginManifest(value);
        const schemaResult = validateJsonSchema(value, schemas.get('plugin-manifest.schema.json'), { schemas });
        if (!schemaResult.valid) errors.push(`plugin manifest violates Schema: plugins/${name}: ${schemaResult.errors.join('; ')}`);
        if (!value.entry) errors.push(`plugin manifest has no entry: plugins/${name}`);
        else try { await access(resolve(root, directory, value.entry)); } catch { errors.push(`plugin manifest entry is missing: plugins/${name} -> ${value.entry}`); }
      }
    } catch (error) { errors.push(`invalid JSON/contract: ${directory}/${name}: ${error.code ?? error.message}`); }
  }
}

const exactDigest = 'a'.repeat(64);
const descriptorInputs = [
  ['engine-project-input.json', createCardWorldProjectDescriptor],
  ['collection-project-input.json', createTabletopCollectionProjectDescriptor],
];
for (const [name, createDescriptor] of descriptorInputs) {
  try {
    const recipe = JSON.parse(await readFile(resolve(root, 'examples', name), 'utf8'));
    const draft = createDescriptor(recipe);
    const input = {
      ...draft,
      harness: { version: packageJson.version, artifactDigest: exactDigest },
      extensions: (draft.extensions ?? []).map(extension => ({ ...extension, digest: exactDigest })),
    };
    const inputResult = validateJsonSchema(input, schemas.get('project-descriptor-input.schema.json'), { schemas });
    if (!inputResult.valid) errors.push(`generated Project Descriptor input violates Schema: examples/${name}: ${inputResult.errors.join('; ')}`);
    const committedAt = '2026-01-01T00:00:00.000Z';
    const command = { commandId: 'schema-round-trip', payloadDigest: digestJson(input), revision: 1, committedAt, authorityDecision: null };
    const recordBody = { ...input, protocolVersion: '1.0', revision: 1, updatedAt: committedAt, commands: { 'schema-round-trip': command } };
    const record = { ...recordBody, descriptorDigest: digestJson(recordBody) };
    const recordResult = validateJsonSchema(record, schemas.get('project-descriptor.schema.json'), { schemas });
    if (!recordResult.valid) errors.push(`persisted Project Descriptor violates Schema: examples/${name}: ${recordResult.errors.join('; ')}`);
  } catch (error) { errors.push(`invalid Project Descriptor example: examples/${name}: ${error.code ?? error.message}`); }
}
const emptyExtensionRegistryBody = { protocolVersion: '1.0', revision: 0, extensions: [], commands: {} };
const emptyExtensionRegistry = { ...emptyExtensionRegistryBody, registryDigest: digestJson(emptyExtensionRegistryBody) };
const extensionRegistryResult = validateJsonSchema(emptyExtensionRegistry, schemas.get('extension-installation.schema.json'), { schemas });
if (!extensionRegistryResult.valid) errors.push(`Extension Registry baseline violates Schema: ${extensionRegistryResult.errors.join('; ')}`);
const extensionFiles = [{ path: 'extension.mjs', sha256: exactDigest, size: 1 }];
const extensionArtifact = { protocolVersion: '1.0', id: 'schema-probe', version: packageJson.version, entry: 'extension.mjs', files: extensionFiles, artifactDigest: digestJson(extensionFiles) };
const extensionArtifactResult = validateJsonSchema(extensionArtifact, schemas.get('extension-artifact.schema.json'), { schemas });
if (!extensionArtifactResult.valid) errors.push(`Extension artifact baseline violates Schema: ${extensionArtifactResult.errors.join('; ')}`);
const banned = /CardWorld|Collection|\bGame\b|\bBatch\b|Codex|Rust|WASM/;
const bannedWriteRoots = /(?:node:os|os\.tmpdir|homedir\(|LOCALAPPDATA|USERPROFILE)/;
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name.endsWith('.mjs')) {
      const text = await readFile(file, 'utf8');
      if (banned.test(text)) errors.push(`business/provider term leaked into Kernel: ${file.slice(root.length + 1)}`);
    }
  }
};
await walk(resolve(root, 'src', 'kernel'));
for (const file of [resolve(root, 'src', 'index.mjs'), resolve(root, 'src', 'app', 'harness.mjs'), resolve(root, 'src', 'cli.mjs'), resolve(root, 'src', 'plugins', 'index.mjs'), resolve(root, 'src', 'profiles', 'index.mjs'), resolve(root, 'src', 'recovery', 'index.mjs')]) {
  const text = await readFile(file, 'utf8');
  if (banned.test(text)) errors.push(`business/provider term leaked into default composition: ${file.slice(root.length + 1)}`);
}
const auditWriteRoots = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await auditWriteRoots(file);
    else if (entry.name.endsWith('.mjs') && bannedWriteRoots.test(await readFile(file, 'utf8'))) errors.push(`system/user write root reference: ${file.slice(root.length + 1)}`);
  }
};
await auditWriteRoots(resolve(root, 'src'));
const npmConfig = await readFile(resolve(root, '.npmrc'), 'utf8');
if (!npmConfig.includes('cache=.agent-harness-cache/npm') || !npmConfig.includes('logs-dir=.tmp/npm-logs') || !npmConfig.includes('logs-max=0')) errors.push('npm cache/log paths must stay project-local with transient logs disabled');
const license = await readFile(resolve(root, 'LICENSE'), 'utf8');
if (!license.startsWith('Copyright (c) 2026 Agent Harness contributors. All rights reserved.\n') || !license.includes('No license is\ngranted')) errors.push('LICENSE does not match the owner-approved all-rights-reserved notice');
const codexPluginRoot = resolve(root, 'integrations', 'codex', 'agent-harness-codex');
const codexPlugin = JSON.parse(await readFile(resolve(codexPluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
errors.push(...validateReleaseVersionContract({ packageJson, codexPlugin }));
if (codexPlugin.name !== 'agent-harness-codex' || codexPlugin.skills !== './skills/') errors.push('Codex integration plugin manifest is not bound to this Harness release');
const skillsRoot = resolve(codexPluginRoot, 'skills');
for (const name of await readdir(skillsRoot)) {
  const skill = await readFile(resolve(skillsRoot, name, 'SKILL.md'), 'utf8');
  if (!skill.startsWith('---\n') || !skill.includes(`name: ${name}\n`) || !skill.includes('\ndescription: ')) errors.push(`invalid Skill entrypoint: integrations/codex/agent-harness-codex/skills/${name}/SKILL.md`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, version: packageJson.version, checked: ['exports', 'schema-definitions', 'schema-references', 'descriptor-inputs', 'descriptor-registry-round-trip', 'profiles', 'plugins', 'extensions', 'skills', 'kernel-boundary', 'default-composition', 'write-boundary', 'zero-runtime-dependencies'] }, null, 2));
