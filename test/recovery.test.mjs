import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CardWorldLegacyImporter } from '../src/recovery/cardworld-importer.mjs';
import { CollectionLegacyImporter } from '../src/recovery/collection-importer.mjs';
import { extensionPack as legacyCompatibilityExtension } from '../src/extensions/legacy-compat.mjs';
import { makeFixture, startRun } from './test-support.mjs';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy');

test('CardWorld importer preserves frozen legacy facts but invalidates transport', async () => {
  const root = resolve(fixtures, 'cardworld');
  const report = await new CardWorldLegacyImporter().inventory({ legacyRoot: root });
  assert.ok(report.assessmentDigest);
  assert.equal(report.fileCount, 3);
  assert.equal(report.sourceDigest, 'f83038261585fd878d07ca3eb9799aa140bce1a188fe8163215a1939f4caaaf5');
  assert.ok(report.facts.some(fact => fact.disposition === 'invalid' && fact.id.endsWith('#leases')));
  assert.ok(report.facts.some(fact => fact.disposition === 'stale-revalidate'));
});

test('Collection importer recognizes frozen Round 0.2 and report 0.4 without promoting completion', async () => {
  const root = resolve(fixtures, 'collection');
  const report = await new CollectionLegacyImporter().inventory({ legacyRoot: root });
  assert.equal(report.fileCount, 2);
  assert.equal(report.sourceDigest, 'f2d85a6964634860c60d4a03a306c1dc9c38ca56fb2c477febd9a30f3ebed7b5');
  assert.equal(report.facts.filter(fact => fact.id.endsWith('#schema') && fact.disposition === 'legacy-only').length, 2);
  assert.ok(report.facts.some(fact => fact.id.endsWith('#completed') && fact.disposition === 'stale-revalidate'));
  assert.ok(report.facts.some(fact => fact.id.endsWith('#leases') && fact.disposition === 'invalid'));
});

test('recovery plan is read-only, digest-bound, and defaults every Feature to revalidation', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const before = await startRun(fixture);
  const plan = await fixture.harness.recovery.plan({ importerId: 'cardworld-t1-t2-importer', legacyRoot: resolve(fixtures, 'cardworld'), projectId: fixture.projectId, runId: 'run' });
  const after = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  assert.equal(plan.currentAuthorityDigest, before.authorityDigest);
  assert.equal(plan.proposedEpoch, before.epoch + 1);
  assert.deepEqual(plan.dispositions, { one: 'stale-revalidate' });
  assert.equal(after.authorityDigest, before.authorityDigest);
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
});
