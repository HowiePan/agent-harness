import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/canonical.mjs';
import { extensionPack as legacyCompatibilityExtension } from '../src/extensions/legacy-compat.mjs';
import { CardWorldLegacyImporter } from '../src/recovery/cardworld-importer.mjs';
import { createRecoveryCapsule } from '../src/recovery/capsule.mjs';
import { makeFixture, startRun } from './test-support.mjs';

const rewriteJson = async (file, mutate) => {
  const value = JSON.parse(await readFile(file, 'utf8'));
  mutate(value);
  await writeFile(file, JSON.stringify(value));
};

const capsuleFixture = async (fixture, id) => {
  const legacyRoot = resolve(fixture.root, `legacy-${id}`);
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'state.json'), JSON.stringify({ status: 'incomplete' }));
  return fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: id, commandId: `create-${id}` });
};

test('Recovery Capsule preserves state with digests and no executable content', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'legacy-state');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'active-protocol.json'), JSON.stringify({ protocol: 'T2', leases: [{ id: 'old' }], status: 'completed' }));
  await startRun(fixture);
  const created = await fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: 'engine-state', commandId: 'capsule-create' });
  assert.equal(created.manifest.executableContent, false);
  assert.equal(created.manifest.retention, 'user-controlled');
  const verified = await fixture.harness.recovery.verifyCapsule(created.root, { projectId: fixture.projectId, runId: 'run' });
  assert.equal(verified.manifest.manifestDigest, created.manifest.manifestDigest);
  assert.equal(verified.manifest.sourceDigest, created.manifest.sourceDigest);
  assert.match(verified.verification.verificationRef, /^evidence:/);
  await assert.rejects(() => access(resolve(fixture.dataRoot, 'tmp')), error => error.code === 'ENOENT');
});

test('Recovery Capsule rejects source and binary files', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'legacy-with-code');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'state.json'), '{}');
  await writeFile(resolve(legacyRoot, 'old-harness.js'), 'throw new Error();');
  await assert.rejects(() => fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: 'rejected', commandId: 'capsule-rejected' }), error => error.code === 'RECOVERY_CAPSULE_EXECUTABLE_REJECTED');
});

test('Recovery Capsule rejects symlinks and Windows junctions instead of omitting them', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'legacy-with-link');
  const target = resolve(fixture.root, 'linked-state');
  await mkdir(legacyRoot, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(resolve(target, 'state.json'), '{}');
  await symlink(target, resolve(legacyRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: 'linked', commandId: 'capsule-linked' }), error => error.code === 'RECOVERY_LINK_FORBIDDEN');
});

test('Recovery Capsule detects a source mutation during staging', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'legacy-changing');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'state.json'), '{}');
  const base = new CardWorldLegacyImporter();
  const importer = {
    id: base.id,
    version: base.version,
    async inventory(input) {
      const assessment = await base.inventory(input);
      await writeFile(resolve(legacyRoot, 'changed.json'), '{}');
      return assessment;
    },
  };
  await assert.rejects(() => createRecoveryCapsule({ legacyRoot, dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot, importer, capsuleId: 'changing', commandId: 'capsule-changing' }), error => error.code === 'RECOVERY_CAPSULE_SOURCE_CHANGED');
});

test('Recovery Capsule verification rejects unknown manifest fields', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const capsule = await capsuleFixture(fixture, 'unknown-manifest');
  await rewriteJson(resolve(capsule.root, 'capsule.json'), manifest => {
    manifest.untrusted = true;
    const { manifestDigest, ...body } = manifest;
    manifest.manifestDigest = digestJson(body);
  });
  await assert.rejects(() => fixture.harness.recovery.verifyCapsule(capsule.root, { projectId: fixture.projectId, runId: 'run' }), error => error.code === 'RECOVERY_CAPSULE_MANIFEST_SCHEMA_INVALID');
});

test('Recovery Capsule verification recomputes assessment and rejects unknown fields', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const capsule = await capsuleFixture(fixture, 'assessment-tamper');
  await rewriteJson(resolve(capsule.root, 'assessment.json'), assessment => {
    assessment.untrusted = true;
    const { assessmentDigest, ...body } = assessment;
    assessment.assessmentDigest = digestJson(body);
  });
  await assert.rejects(() => fixture.harness.recovery.verifyCapsule(capsule.root, { projectId: fixture.projectId, runId: 'run' }), error => error.code === 'RECOVERY_CAPSULE_ASSESSMENT_SCHEMA_INVALID');
});

test('Recovery Capsule verification rejects payload and byte-count tampering', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const payloadCapsule = await capsuleFixture(fixture, 'payload-tamper');
  await writeFile(resolve(payloadCapsule.payloadRoot, 'state.json'), '{"changed":true}');
  await assert.rejects(() => fixture.harness.recovery.verifyCapsule(payloadCapsule.root, { projectId: fixture.projectId, runId: 'run' }), error => ['RECOVERY_CAPSULE_FILE_MANIFEST_MISMATCH', 'RECOVERY_CAPSULE_SOURCE_MISMATCH'].includes(error.code));

  const byteCapsule = await capsuleFixture(fixture, 'byte-tamper');
  await rewriteJson(resolve(byteCapsule.root, 'capsule.json'), manifest => {
    manifest.totalBytes += 1;
    const { manifestDigest, ...body } = manifest;
    manifest.manifestDigest = digestJson(body);
  });
  await assert.rejects(() => fixture.harness.recovery.verifyCapsule(byteCapsule.root, { projectId: fixture.projectId, runId: 'run' }), error => error.code === 'RECOVERY_CAPSULE_TOTAL_BYTES_MISMATCH');
});
