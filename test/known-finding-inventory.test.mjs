import assert from 'node:assert/strict';
import test from 'node:test';
import { assertKnownFindingInventory, sealKnownFindingInventory } from '../src/platform/execution/known-finding-inventory.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { hasCurrentCleanQualityReview } from '../src/flow-kit/profiles/quality-loop.mjs';
import { validateBusinessResult } from '../src/platform/execution/result-contract.mjs';

const digest = character => character.repeat(64);
const snapshot = { digest: digest('a'), files: [{ path: 'docs/version.md', sha256: digest('b') }] };
const declaration = {
  version: '1.0', sources: [{ path: 'docs/version.md', sha256: digest('b') }],
  findings: [
    { id: 'ISSUE-1', severity: 'P1', sourcePath: 'docs/version.md', aliases: ['ISSUE-1-STALE'] },
    { id: 'ISSUE-2', severity: 'P2', sourcePath: 'docs/version.md' },
  ],
};
const inventory = sealKnownFindingInventory({ projectId: 'fixture', target: 'v1', declaration, snapshot });
const feature = { metadata: { qualityReview: true, knownFindingInventory: inventory } };
const result = ({ findings = [], knownFindingDispositions }) => ({ status: 'completed', summary: 'Reviewed pinned scope.', changedFiles: [], findings, knownFindingDispositions });
const finding = { id: 'ISSUE-1', severity: 'P1', summary: 'Still open.', evidence: ['docs/version.md:1'], affectedPaths: ['src/file.mjs'] };

test('completed quality review accounts for every canonical known Finding before acceptance', () => {
  const complete = result({ findings: [finding], knownFindingDispositions: [
    { id: 'ISSUE-1', disposition: 'open', evidence: ['docs/version.md:1'] },
    { id: 'ISSUE-2', disposition: 'not-reproduced', evidence: ['fresh check:2'] },
  ] });
  assert.deepEqual(validateBusinessResult(complete, { feature }), complete);
  for (const dispositions of [
    complete.knownFindingDispositions.slice(0, 1),
    [{ id: 'ISSUE-1-STALE', disposition: 'open', evidence: ['docs/version.md:1'] }, complete.knownFindingDispositions[1]],
    [complete.knownFindingDispositions[0], complete.knownFindingDispositions[0]],
  ]) assert.throws(() => validateBusinessResult(result({ findings: [finding], knownFindingDispositions: dispositions }), { feature }), error => error.code === 'QUALITY_FINDING_INVENTORY_INCOMPLETE');
  assert.throws(() => validateBusinessResult(result({ findings: [], knownFindingDispositions: complete.knownFindingDispositions }), { feature }), error => error.code === 'QUALITY_FINDING_INVENTORY_INCOMPLETE');
});

test('known Finding inventory rejects a changed source before planning', () => {
  assert.throws(() => sealKnownFindingInventory({ projectId: 'fixture', target: 'v1', declaration, snapshot: { ...snapshot, files: [{ path: 'docs/version.md', sha256: digest('c') }] } }), error => error.code === 'QUALITY_FINDING_INVENTORY_SOURCE_DRIFT');
});

test('inventory verification rejects a redigested forged item', () => {
  const forged = structuredClone(inventory);
  forged.findings[0].sourcePath = '../outside.md';
  forged.inventoryDigest = digestJson(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== 'inventoryDigest')));
  assert.throws(() => assertKnownFindingInventory(forged), error => error.code === 'QUALITY_FINDING_INVENTORY_ITEM_INVALID');
});

test('nine pinned legacy issues each block an incomplete review', () => {
  const ids = [...Array.from({ length: 6 }, (_, index) => `R008-FSW-00${index + 1}`), 'V384-R06', 'V384-R07', 'V384-R08'];
  const nine = sealKnownFindingInventory({
    projectId: 'fixture', target: 'V3.8.4', snapshot,
    declaration: { version: '1.0', sources: declaration.sources, findings: ids.map(id => ({ id, severity: id.startsWith('R008') ? 'P1' : 'P2', sourcePath: 'docs/version.md' })) },
  });
  const reviewFeature = { metadata: { qualityReview: true, knownFindingInventory: nine } };
  const dispositions = ids.map(id => ({ id, disposition: 'not-reproduced', evidence: [`fresh check for ${id}`] }));
  validateBusinessResult(result({ knownFindingDispositions: dispositions }), { feature: reviewFeature });
  for (const omitted of ids) assert.throws(
    () => validateBusinessResult(result({ knownFindingDispositions: dispositions.filter(item => item.id !== omitted) }), { feature: reviewFeature }),
    error => error.code === 'QUALITY_FINDING_INVENTORY_INCOMPLETE' && error.details?.missing?.includes(omitted),
  );
});

test('an Engine quality Run cannot close from a legacy review lacking the inventory', () => {
  const state = {
    metadata: { commandIntent: { action: 'quality' } }, sourceDigest: digest('a'), findings: [],
    features: [{ id: 'quality/V3.8.4', state: 'completed', metadata: { qualityReview: true, qualityRoot: 'engine:V3.8.4' } }],
    submissions: [{ featureId: 'quality/V3.8.4', outputSourceDigest: digest('a'), result: { findings: [] } }],
  };
  assert.equal(hasCurrentCleanQualityReview(state), false);
});
