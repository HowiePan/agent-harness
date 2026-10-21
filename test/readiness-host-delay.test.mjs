import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyExecutionReadinessReport } from '../src/application/execution-readiness.mjs';
import { runLineageResolutionDigest } from '../src/application/lineage.mjs';
import { makeFixture } from './test-support.mjs';
import { projectDescriptorInput } from '../src/platform/registry/project-contract.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';

const readinessFixture = async t => {
  const engine = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const fixture = await makeFixture({ extensions: [engine], releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true } }); t.after(fixture.cleanup);
  await mkdir(resolve(fixture.workspace, '.git'));
  const project = await fixture.harness.projectRegistry.get(fixture.projectId);
  await fixture.harness.projectRegistry.register({ ...projectDescriptorInput(project), profiles: ['engine-delivery'],
    extensions: fixture.harness.extensionSet.installed.map(({ id, version, digest }) => ({ id, version, ...(digest ? { digest } : {}) })) },
  { expectedRevision: project.revision, commandId: 'bind-readiness-extension', authorityDecision: { actor: 'test-user', decision: 'approved' } });
  return fixture;
};

test('readiness validity starts after slow checks and lineage is freshly resolved without extending an old report', async t => {
  const fixture = await readinessFixture(t);
  const { harness } = fixture;
  const plan = await harness.createLifecyclePlan({ projectId: fixture.projectId, action: 'quality', target: 'V-next',
    arguments: ['review-only'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  let clock = Date.now(); const initial = clock;
  harness.kernel.now = () => new Date(clock).toISOString();
  const get = harness.projectRegistry.get.bind(harness.projectRegistry);
  harness.projectRegistry.get = async id => { clock += 120000; return get(id); };
  const report = await harness.createExecutionReadinessReport(plan, { ttlMs: 60000 });
  assert.ok(Date.parse(report.createdAt) >= initial + 120000);
  assert.equal(Date.parse(report.expiresAt) - Date.parse(report.createdAt), 60000);
  assert.equal(report.lineageResolution.resolutionDigest, runLineageResolutionDigest(report.lineageResolution));
  assert.ok(Date.parse(report.lineageResolution.expiresAt) > clock);
  verifyExecutionReadinessReport(report, { plan, now: harness.kernel.now, requireReady: false });
  clock = Date.parse(report.expiresAt);
  assert.throws(() => verifyExecutionReadinessReport(report, { plan, now: harness.kernel.now, requireReady: false }), { code: 'EXECUTION_READINESS_EXPIRED' });
});

test('late source changes still block a newly issued readiness report', async t => {
  const fixture = await readinessFixture(t);
  const { harness } = fixture;
  const plan = await harness.createLifecyclePlan({ projectId: fixture.projectId, action: 'quality', target: 'V-next',
    arguments: ['review-only'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  const get = harness.projectRegistry.get.bind(harness.projectRegistry); let calls = 0;
  harness.projectRegistry.get = async id => {
    if (++calls === 2) await writeFile(resolve(fixture.workspace, 'README.md'), 'changed while observing the Host');
    return get(id);
  };
  const report = await harness.createExecutionReadinessReport(plan);
  assert.equal(report.executionReady, false);
  assert.equal(report.checks.find(check => check.id === 'workspace-source').ready, false);
});
