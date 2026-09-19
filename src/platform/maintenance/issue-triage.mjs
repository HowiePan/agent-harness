import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertJsonSchema } from '../../common/json-schema.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../../kernel/atomic-io.mjs';
import { safeSegment } from '../../common/paths.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../../common/write-boundary.mjs';
import { verifyIssueIntake } from './issue-intake.mjs';

const inputSchema = JSON.parse(readFileSync(new URL('../../../schemas/issue-triage-input.schema.json', import.meta.url), 'utf8'));
const stateSchema = JSON.parse(readFileSync(new URL('../../../schemas/issue-triage-state.schema.json', import.meta.url), 'utf8'));
const schemas = new Map([['issue-triage-input.schema.json', inputSchema]]);

const verifyState = state => {
  assertJsonSchema(state, stateSchema, { schemas, code: 'ISSUE_TRIAGE_STATE_INVALID', label: 'Issue Triage state' });
  assert(state.triageDigest === digestJson(withoutKeys(state, ['triageDigest'])), 'ISSUE_TRIAGE_DIGEST_MISMATCH', 'Issue Triage state digest mismatch.');
  return state;
};

export const validateIssueTriageInput = input => {
  assertJsonSchema(input, inputSchema, { code: 'ISSUE_TRIAGE_INPUT_INVALID', label: 'Issue Triage input' });
  if (input.status === 'duplicate') assert(input.relations.some(item => item.type === 'duplicate-of' && /^AH-/.test(item.target)), 'ISSUE_DUPLICATE_TARGET_REQUIRED', 'Duplicate disposition requires a duplicate-of Issue relation.');
  if (['resolved', 'closed'].includes(input.status)) assert(input.resolutionEvidence.length > 0, 'ISSUE_RESOLUTION_EVIDENCE_REQUIRED', 'Resolved or closed Issue disposition requires resolution Evidence.');
  return structuredClone(input);
};

export const readIssueTriage = async (issueIdInput, { controlRoot: controlRootInput } = {}) => {
  const issueId = safeSegment(issueIdInput, 'issueId');
  assert(/^AH-[0-9]{8}-[A-F0-9]{12}$/.test(issueId), 'ISSUE_ID_INVALID', 'Issue ID is invalid.');
  const controlRoot = harnessControlRoot(controlRootInput);
  const issueDirectory = assertHarnessWritePath(resolve(controlRoot, 'issues', issueId), 'Issue directory', controlRoot);
  verifyIssueIntake(await readJson(resolve(issueDirectory, 'intake.json')));
  const state = await readJson(resolve(issueDirectory, 'triage.json'), null);
  return state ? verifyState(state) : null;
};

export const listIssueRecords = async ({ controlRoot: controlRootInput } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const issueRoot = assertHarnessWritePath(resolve(controlRoot, 'issues'), 'Issue register root', controlRoot);
  let entries;
  try { entries = await readdir(issueRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const entry of entries.filter(item => item.isDirectory() && /^AH-[0-9]{8}-[A-F0-9]{12}$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const intake = verifyIssueIntake(await readJson(resolve(issueRoot, entry.name, 'intake.json')));
    const triage = await readIssueTriage(entry.name, { controlRoot });
    records.push({ issueId: entry.name, observedAt: intake.observedAt, summary: intake.summary, severity: intake.severity, incidentFingerprint: intake.incidentFingerprint ?? null, triage });
  }
  return records;
};

export const recordIssueTriage = async (issueIdInput, input, { controlRoot: controlRootInput, expectedRevision = 0, commandId, authorityDecision, now = () => new Date().toISOString() } = {}) => {
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Issue triage requires a command ID.');
  assert(Number.isInteger(expectedRevision) && expectedRevision >= 0, 'EXPECTED_REVISION_REQUIRED', 'Issue triage requires a non-negative expected revision.');
  assert(authorityDecision?.actor && authorityDecision?.decision === 'approved', 'ISSUE_TRIAGE_AUTHORITY_DECISION_REQUIRED', 'Issue triage requires an approved Authority Decision.');
  const issueId = safeSegment(issueIdInput, 'issueId');
  assert(/^AH-[0-9]{8}-[A-F0-9]{12}$/.test(issueId), 'ISSUE_ID_INVALID', 'Issue ID is invalid.');
  const safeCommandId = safeSegment(commandId, 'commandId');
  const disposition = validateIssueTriageInput(input);
  const controlRoot = harnessControlRoot(controlRootInput);
  const issueDirectory = assertHarnessWritePath(resolve(controlRoot, 'issues', issueId), 'Issue directory', controlRoot);
  verifyIssueIntake(await readJson(resolve(issueDirectory, 'intake.json')));
  const file = assertHarnessWritePath(resolve(issueDirectory, 'triage.json'), 'Issue Triage state', controlRoot);
  const payloadDigest = digestJson(disposition);
  return withDirectoryLock(`${file}.lock`, async () => {
    const current = await readJson(file, null);
    if (current) verifyState(current);
    const prior = current?.commands?.[safeCommandId];
    if (prior) {
      assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Issue triage command ID was reused with a different disposition.');
      return { state: current, receipt: prior, reused: true };
    }
    assert((current?.revision ?? 0) === expectedRevision, 'ISSUE_TRIAGE_REVISION_CONFLICT', 'Issue Triage revision changed.', { expected: expectedRevision, actual: current?.revision ?? 0 });
    const revision = expectedRevision + 1;
    const committedAt = now();
    const receipt = { commandId: safeCommandId, payloadDigest, revision, committedAt, authorityDecision: structuredClone(authorityDecision) };
    const body = { protocolVersion: '1.0', issueId, revision, disposition, commands: { ...(current?.commands ?? {}), [safeCommandId]: receipt }, updatedAt: committedAt };
    const state = { ...body, triageDigest: digestJson(body) };
    verifyState(state);
    await atomicWriteJson(file, state, { root: controlRoot });
    return { state, receipt, reused: false };
  }, { root: controlRoot });
};
