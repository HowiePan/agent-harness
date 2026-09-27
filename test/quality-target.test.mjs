import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { assertQualityInventorySnapshot, createQualityInventorySnapshot, createQualityRepairInventorySnapshot, deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';

const digest = value => value.repeat(64).slice(0, 64);
const run = ({ runId, revision, sourceDigest, findings = [], submissions = [], status = 'closed', target = 'V3.8.5', updatedAt = `2026-09-21T00:00:0${revision}.000Z` }) => {
  const body = {
    protocolVersion: '1.0', projectId: 'cardworld-engine', runId, revision, sourceDigest, status,
    createdAt: updatedAt, updatedAt,
    metadata: { workflow: { id: 'engine-delivery' }, commandIntent: { workflowId: 'engine-delivery', target } },
    features: [{ id: 'quality', state: 'completed' }], findings, submissions,
  };
  return { ...body, authorityDigest: digestJson(body) };
};

test('an unconfigured version starts with a valid empty Quality Target and inventory', () => {
  const target = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.5', sourceDigest: digest('a') });
  const inventory = createQualityInventorySnapshot(target);
  assert.equal(target.revision, 0);
  assert.deepEqual(target.findings, []);
  assert.equal(inventory.version, '2.0');
  assert.deepEqual(inventory.findings, []);
  assert.equal(assertQualityInventorySnapshot(inventory).inventoryDigest, inventory.inventoryDigest);
});

test('terminal Run Authority states form one cross-Run target ledger', () => {
  const first = run({
    runId: 'v3-8-5-quality-1', revision: 5, sourceDigest: digest('a'),
    findings: [{ id: 'V385-Q01', severity: 'P1', summary: 'Observed defect', source: 'review', status: 'open', evidenceRefs: ['sha256:first'], resolutionEvidenceRefs: [] }],
  });
  const second = run({
    runId: 'v3-8-5-quality-2', revision: 7, sourceDigest: digest('b'),
    findings: [{ id: 'V385-Q01', severity: 'P1', summary: 'Observed defect', source: 'review', status: 'resolved', evidenceRefs: ['sha256:first'], resolutionEvidenceRefs: ['sha256:repair'] }],
  });
  const target = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.5', sourceDigest: digest('c'), runs: [second, first] });
  const inventory = createQualityInventorySnapshot(target);
  assert.equal(target.revision, 12);
  assert.deepEqual(target.runs.map(item => item.runId), ['v3-8-5-quality-1', 'v3-8-5-quality-2']);
  assert.equal(target.findings[0].status, 'resolved');
  assert.deepEqual(target.findings[0].resolutionEvidenceRefs, ['sha256:repair']);
  assert.equal(inventory.sourceDigest, digest('c'));
  assert.equal(inventory.findings[0].id, 'V385-Q01');
});

test('active incomplete Runs do not make a lifecycle plan drift while completed review results do', () => {
  const active = run({ runId: 'active', revision: 3, sourceDigest: digest('a'), status: 'running' });
  active.features[0].state = 'pending';
  const completed = run({ runId: 'completed-review', revision: 4, sourceDigest: digest('b'), findings: [{ id: 'V385-Q02', severity: 'P2', summary: 'Completed review finding', status: 'open', evidenceRefs: ['sha256:evidence'], resolutionEvidenceRefs: [] }] });
  const before = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.5', sourceDigest: digest('c'), runs: [active] });
  const after = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.5', sourceDigest: digest('c'), runs: [active, completed] });
  assert.equal(before.revision, 0);
  assert.equal(after.revision, 4);
  assert.deepEqual(after.findings.map(item => item.id), ['V385-Q02']);
});

test('repair inventory follows final Run findings after an interrupted recheck', () => {
  const prior = run({
    runId: 'interrupted-quality', revision: 15, sourceDigest: digest('a'), status: 'superseded',
    findings: [
      { id: 'REOPENED', severity: 'P2', summary: 'Recheck confirmed the defect', status: 'open', affectedPaths: ['src/replay.rs'], evidence: ['fresh recheck'], evidenceRefs: ['sha256:review'], resolutionEvidenceRefs: [] },
      { id: 'FIXED', severity: 'P1', summary: 'Repair verified', status: 'resolved', affectedPaths: ['src/table.rs'], evidence: ['original review'], evidenceRefs: ['sha256:review'], resolutionEvidenceRefs: ['sha256:repair'] },
    ],
    submissions: [
      { featureId: 'review', result: { status: 'completed', knownFindingDispositions: [{ id: 'REOPENED', disposition: 'not-reproduced', evidence: ['earlier check'] }, { id: 'FIXED', disposition: 'open', evidence: ['earlier check'] }] }, evidenceRefs: ['sha256:earlier'], submittedAt: '2026-09-20T00:00:00.000Z' },
      { featureId: 'recheck', result: { status: 'blocked', knownFindingDispositions: [{ id: 'REOPENED', disposition: 'not-reproduced', evidence: ['incomplete check'] }] }, evidenceRefs: ['sha256:blocked'], submittedAt: '2026-09-21T00:00:00.000Z' },
    ],
  });
  prior.features = [
    { id: 'review', state: 'completed', metadata: { qualityReview: true } },
    { id: 'recheck', state: 'blocked', metadata: { qualityReview: true } },
  ];
  const current = run({ runId: 'new-abandoned-run', revision: 2, sourceDigest: digest('b'), status: 'running' });
  current.features[0].state = 'dispatched';
  const target = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.5', sourceDigest: digest('c'), runs: [prior, current], includeNonterminal: true });
  assert.deepEqual(target.findings.map(item => [item.id, item.status]), [['FIXED', 'resolved'], ['REOPENED', 'open']]);
  assert.deepEqual(createQualityRepairInventorySnapshot(target).findings.map(item => item.id), ['REOPENED']);
});

test('legacy Project inventory is an auditable migration seed, not runtime configuration truth', () => {
  const legacyInventory = {
    version: '1.0', projectId: 'cardworld-engine', target: 'V3.8.4', sourceDigest: digest('a'),
    sources: [{ path: 'docs/version.md', sha256: digest('b') }],
    findings: [{ id: 'V384-OLD', severity: 'P2', sourcePath: 'docs/version.md', aliases: [] }],
  };
  legacyInventory.inventoryDigest = digestJson({ ...legacyInventory });
  const target = deriveQualityTargetSnapshot({ projectId: 'cardworld-engine', workflowId: 'engine-delivery', target: 'V3.8.4', sourceDigest: digest('c'), legacyInventory });
  assert.equal(target.revision, 1);
  assert.equal(target.migration.inventoryDigest, legacyInventory.inventoryDigest);
  assert.equal(target.findings[0].source, 'legacy-project-descriptor');
  assert.equal(target.findings[0].status, 'open');
});
