import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createDefectBundle, createIssueIntake, readIssueTriage, recordIssueIntake, recordIssueTriage, verifyDefectBundle, verifyIssueIntake } from '../src/index.mjs';

const digest = 'a'.repeat(64);
const input = {
  protocolVersion: '1.0',
  harness: { version: '1.0.0', artifactDigest: digest, commit: 'abc123' },
  extensions: [{ id: 'neutral-profile', version: '1.0.0' }],
  descriptorDigest: digest,
  command: { operation: 'run.start' },
  authorityRevision: 2,
  dispatchIds: ['dispatch-1'],
  evidenceRefs: [],
  expected: { status: 'completed' },
  actual: { status: 'blocked' },
  reproduction: { fixture: 'synthetic' },
  sanitization: { confirmed: true, removed: ['workspace path'] },
};

test('Defect Bundle is digest-bound and requires explicit sanitization', () => {
  const bundle = createDefectBundle(input);
  assert.match(bundle.bundleDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyDefectBundle(bundle), bundle);
  assert.throws(() => createDefectBundle({ ...input, sanitization: { confirmed: false } }), error => error.code === 'DEFECT_SANITIZATION_REQUIRED');
});

test('Defect Bundle rejects common secret and prompt fields', () => {
  assert.throws(() => createDefectBundle({ ...input, reproduction: { fixture: 'synthetic', accessToken: 'redacted' } }), error => error.code === 'DEFECT_SENSITIVE_FIELD_REJECTED');
});

const issueInput = {
  protocolVersion: '1.0',
  projectAlias: 'engine',
  project: { projectId: 'cardworld-engine', profileId: 'engine-delivery', extensionId: 'cardworld-engine-profile' },
  observedAt: '2026-09-13T12:00:00.000Z',
  summary: 'Bound data root cannot initialize Authority directories',
  severity: 'P1',
  environment: { controlRoot: 'F:\\agent-harness', dataRoot: 'F:\\agent-harness\\.agent-harness-data' },
  expected: { projectList: 'readable' },
  actual: { code: 'EPERM', path: 'F:\\agent-harness\\.agent-harness-data\\authority' },
  reproduction: { steps: ['Run doctor against the bound control and data roots.', 'Run project list against the same roots.'] },
  conversation: { source: 'current-thread', excerpts: [{ role: 'user', text: 'The release verifies, but project list fails while creating Authority.' }] },
  missingEvidence: ['Project Descriptor digest', 'Authority revision'],
  sanitization: { confirmed: true, removed: ['unrelated conversation'] },
};

test('Issue Intake is digest-bound and rejects recognizable credentials', () => {
  const intake = createIssueIntake(issueInput);
  assert.match(intake.intakeDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyIssueIntake(intake), intake);
  assert.throws(() => createIssueIntake({ ...issueInput, conversation: { source: 'current-thread', excerpts: [{ role: 'user', text: 'Authorization: Bearer abcdefghijklmnop' }] } }), error => error.code === 'ISSUE_INTAKE_SENSITIVE_CONTENT_REJECTED');
  const correlated = createIssueIntake({ ...issueInput, correlation: { category: 'deployment', failureCode: 'LIFECYCLE_NOT_READY', scope: 'cardworld-engine' } });
  assert.match(correlated.incidentFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(createIssueIntake({ ...issueInput, observedAt: '2026-09-14T12:00:00.000Z', correlation: correlated.correlation }).incidentFingerprint, correlated.incidentFingerprint);
});

test('Issue recording stays under controlRoot/issues and is command-idempotent', async t => {
  const controlRoot = resolve('.');
  const commandId = `test_issue_${process.pid}_${Date.now()}`;
  const first = await recordIssueIntake(issueInput, { controlRoot, commandId, now: () => '2026-09-13T12:05:00.000Z' });
  t.after(async () => {
    await rm(dirname(first.issueFile), { recursive: true, force: true });
    await rm(first.receiptFile, { force: true });
    await rmdir(dirname(first.receiptFile)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  });
  assert.equal(first.reused, false);
  assert.equal(first.issueFile.startsWith(resolve(controlRoot, 'issues')), true);
  assert.match(await readFile(first.issueFile, 'utf8'), /对话只作为问题输入，不是 Harness Authority/);
  const repeated = await recordIssueIntake(issueInput, { controlRoot, commandId });
  assert.equal(repeated.reused, true);
  await assert.rejects(() => recordIssueIntake({ ...issueInput, summary: 'Different input' }, { controlRoot, commandId }), error => error.code === 'COMMAND_ID_REUSED');
});

test('issue record CLI accepts stdin before Registry and Authority initialization', async t => {
  const controlRoot = resolve('.');
  const commandId = `test_issue_cli_${process.pid}_${Date.now()}`;
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve('bin', 'agent-harness.mjs'), 'issue', 'record', '--control-root', controlRoot, '--input', '-', '--command-id', commandId], { cwd: controlRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exitCode => resolveRun({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(issueInput));
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  t.after(async () => {
    await rm(dirname(output.receipt.issueFile), { recursive: true, force: true });
    await rm(output.receipt.receiptFile, { force: true });
    await rmdir(dirname(output.receipt.receiptFile)).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  });
  assert.equal(output.ok, true);
  assert.equal(output.receipt.issueFile.startsWith(resolve(controlRoot, 'issues')), true);
});

test('Issue Triage preserves immutable Intake while supporting revisioned relations and closure Evidence', async t => {
  const controlRoot = resolve('.');
  const recorded = await recordIssueIntake({ ...issueInput, observedAt: '2026-09-14T12:00:00.000Z' }, { controlRoot, commandId: `triage_intake_${process.pid}_${Date.now()}`, now: () => '2026-09-14T12:01:00.000Z' });
  t.after(async () => {
    await rm(dirname(recorded.issueFile), { recursive: true, force: true });
    await rm(recorded.receiptFile, { force: true });
  });
  const decision = { actor: 'project-owner', decision: 'approved' };
  const acceptedInput = { status: 'accepted', classification: 'deployment-incident', severity: 'P1', summary: 'Project lifecycle is not ready.', relations: [{ type: 'successor-of', target: 'AH-20260913-DA8CA73021DB' }], resolutionEvidence: [] };
  const accepted = await recordIssueTriage(recorded.issueId, acceptedInput, { controlRoot, expectedRevision: 0, commandId: 'triage-accept', authorityDecision: decision, now: () => '2026-09-14T12:02:00.000Z' });
  assert.equal(accepted.state.revision, 1);
  assert.deepEqual(await readIssueTriage(recorded.issueId, { controlRoot }), accepted.state);
  const reused = await recordIssueTriage(recorded.issueId, acceptedInput, { controlRoot, expectedRevision: 0, commandId: 'triage-accept', authorityDecision: decision });
  assert.equal(reused.reused, true);
  await assert.rejects(() => recordIssueTriage(recorded.issueId, { ...acceptedInput, status: 'closed' }, { controlRoot, expectedRevision: 1, commandId: 'triage-close-missing-evidence', authorityDecision: decision }), error => error.code === 'ISSUE_RESOLUTION_EVIDENCE_REQUIRED');
  const closed = await recordIssueTriage(recorded.issueId, { ...acceptedInput, status: 'closed', resolutionEvidence: ['receipt:bootstrap:abc'] }, { controlRoot, expectedRevision: 1, commandId: 'triage-close', authorityDecision: decision, now: () => '2026-09-14T12:03:00.000Z' });
  assert.equal(closed.state.disposition.status, 'closed');
});

test('PUB-008 sanitized consumer defect fixture remains independently reproducible', async () => {
  const bundle = JSON.parse(await readFile(new URL('../docs/acceptance/evidence/pub-008-cardworld-recovery-defect.json', import.meta.url), 'utf8'));
  assert.deepEqual(verifyDefectBundle(bundle), bundle);
  assert.equal(bundle.reproduction.fixture, 'synthetic-changing-source');
  assert.equal(bundle.sanitization.removed.includes('credentials'), true);
});
