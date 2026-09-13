import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extensionPack as legacyCompatibilityExtension } from '../src/extensions/legacy-compat.mjs';
import { makeFixture } from './test-support.mjs';

test('Recovery Capsule preserves state with digests and no executable content', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'legacy-state');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'active-protocol.json'), JSON.stringify({ protocol: 'T2', leases: [{ id: 'old' }], status: 'completed' }));
  const created = await fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: 'engine-state', commandId: 'capsule-create' });
  assert.equal(created.manifest.executableContent, false);
  assert.equal(created.manifest.retention, 'user-controlled');
  const verified = await fixture.harness.recovery.verifyCapsule(created.root);
  assert.equal(verified.manifest.manifestDigest, created.manifest.manifestDigest);
  assert.equal(verified.manifest.sourceDigest, created.manifest.sourceDigest);
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
