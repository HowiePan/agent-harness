import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from './canonical.mjs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';
import { safeSegment } from './paths.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from './kernel/atomic-io.mjs';
import { leaseHealth } from './kernel/kernel.mjs';
import { assertHarnessWritePath } from './write-boundary.mjs';

const resolutionSchema = JSON.parse(readFileSync(new URL('../schemas/run-lineage-resolution.schema.json', import.meta.url), 'utf8'));
const lineageSchema = JSON.parse(readFileSync(new URL('../schemas/run-lineage.schema.json', import.meta.url), 'utf8'));
const activeLease = lease => lease.status === 'active';
const activeDispatch = dispatch => ['requested', 'assigned'].includes(dispatch.status);

export const runLineageResolutionDigest = resolution => digestJson(withoutKeys(resolution, ['resolutionDigest']));
export const runLineageAuthorityDigest = lineage => digestJson(withoutKeys(lineage, ['authorityDigest']));

export const validateRunLineageResolution = input => {
  assertJsonSchema(input, resolutionSchema, { code: 'RUN_LINEAGE_RESOLUTION_INVALID', label: 'Run Lineage Resolution' });
  assert(input.resolutionDigest === runLineageResolutionDigest(input), 'RUN_LINEAGE_RESOLUTION_DIGEST_MISMATCH', 'Run Lineage Resolution digest does not match its contents.');
  return structuredClone(input);
};

export const validateRunLineage = input => {
  assertJsonSchema(input, lineageSchema, { code: 'RUN_LINEAGE_INVALID', label: 'Run Lineage Authority' });
  assert(input.authorityDigest === runLineageAuthorityDigest(input), 'RUN_LINEAGE_AUTHORITY_DIGEST_MISMATCH', 'Run Lineage Authority digest does not match its contents.');
  return structuredClone(input);
};

const candidateFor = (state, now) => {
  const activeLeases = state.leases.filter(activeLease);
  const health = leaseHealth(state, Date.parse(now));
  return {
    runId: state.runId,
    revision: state.revision,
    authorityDigest: state.authorityDigest,
    status: state.status,
    sourceDigest: state.sourceDigest,
    planDigest: state.metadata?.lifecyclePlanDigest ?? null,
    activeLeaseCount: activeLeases.length,
    expiredLeaseCount: health.filter(item => item.hardExpired).length,
    activeDispatchCount: state.dispatches.filter(activeDispatch).length,
    updatedAt: state.updatedAt,
  };
};

const belongsToLogicalTask = (state, plan) => {
  if (state.metadata?.logicalTaskKey) return state.metadata.logicalTaskKey === plan.logicalTaskKey;
  const intent = state.metadata?.commandIntent;
  return intent?.action === plan.intent.action
    && intent?.target === plan.intent.target
    && (!intent?.preset || intent.preset === plan.intent.preset)
    && state.profile?.id === plan.run.profileId;
};

const sealResolution = body => validateRunLineageResolution({ ...body, resolutionDigest: runLineageResolutionDigest(body) });

export const resolveRunLineage = ({ plan, states, currentLineage = null, policy = {}, now = () => new Date().toISOString(), ttlMs = 60000 }) => {
  const createdAt = typeof now === 'function' ? now() : now;
  const candidates = states
    .filter(state => !['superseded'].includes(state.status) && belongsToLogicalTask(state, plan))
    .map(state => candidateFor(state, createdAt))
    .sort((left, right) => left.runId.localeCompare(right.runId));
  const expectedRevisions = Object.fromEntries(candidates.map(candidate => [candidate.runId, candidate.revision]));
  const exact = candidates.find(candidate => candidate.runId === plan.run.runId && candidate.planDigest === plan.planDigest);
  let action = 'start';
  let reasonCode = 'NO_EXISTING_LOGICAL_RUN';
  let selectedRunId = plan.run.runId;
  let blockers = [];

  const liveIncompatible = candidates.filter(candidate => candidate.runId !== exact?.runId && candidate.activeLeaseCount > candidate.expiredLeaseCount);
  if (liveIncompatible.length) {
    action = 'block';
    selectedRunId = null;
    reasonCode = 'INCOMPATIBLE_LIVE_LEASE';
    blockers = liveIncompatible.map(candidate => ({ code: 'INCOMPATIBLE_LIVE_LEASE', message: `Run ${candidate.runId} has a live Lease under an incompatible lifecycle plan.`, runId: candidate.runId }));
  } else if (exact) {
    selectedRunId = exact.runId;
    if (exact.status === 'closed') {
      action = 'return-closed';
      reasonCode = 'EXACT_PLAN_ALREADY_CLOSED';
    } else if (exact.activeLeaseCount > 0 && exact.expiredLeaseCount < exact.activeLeaseCount && plan.run.agentExecutionMode === 'conversation-visible') {
      action = 'reattach';
      reasonCode = 'EXACT_PLAN_ACTIVE_LEASE';
    } else if (exact.activeLeaseCount > 0 || exact.activeDispatchCount > 0) {
      action = 'ordinary-resume';
      reasonCode = 'EXACT_PLAN_STALE_TRANSPORT';
    } else {
      action = 'continue';
      reasonCode = 'EXACT_PLAN_RESUMABLE';
    }
  } else {
    if (candidates.length) {
      action = 'supersede-and-start';
      reasonCode = 'INCOMPATIBLE_RUNS_SAFE_TO_SUPERSEDE';
    }
  }

  if (action === 'ordinary-resume' && policy.automaticOrdinaryResume === false) {
    action = 'block';
    selectedRunId = null;
    reasonCode = 'ORDINARY_RESUME_POLICY_DENIED';
    blockers = [{ code: reasonCode, message: 'Project recovery policy denies automatic ordinary resume.' }];
  } else if (['reattach', 'supersede-and-start'].includes(action) && policy.automaticLineageResolution === false) {
    action = 'block';
    selectedRunId = null;
    reasonCode = 'AUTOMATIC_LINEAGE_POLICY_DENIED';
    blockers = [{ code: reasonCode, message: 'Project recovery policy denies automatic Run lineage resolution.' }];
  }

  const body = {
    protocolVersion: '1.0',
    kind: 'run-lineage-resolution',
    projectId: plan.project.id,
    logicalTaskKey: plan.logicalTaskKey,
    planDigest: plan.planDigest,
    plannedRunId: plan.run.runId,
    selectedRunId,
    lineageRevision: currentLineage?.revision ?? 0,
    activeLineageRunId: currentLineage?.activeRunId ?? null,
    action,
    reasonCode,
    candidates,
    expectedRevisions,
    ...(blockers.length ? { blockers } : {}),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
  };
  return sealResolution(body);
};

export const verifyRunLineageResolution = (input, { plan, states, currentLineage = null, now = () => new Date().toISOString() }) => {
  const resolution = validateRunLineageResolution(input);
  assert(resolution.projectId === plan.project.id && resolution.logicalTaskKey === plan.logicalTaskKey && resolution.planDigest === plan.planDigest && resolution.plannedRunId === plan.run.runId, 'RUN_LINEAGE_RESOLUTION_PLAN_MISMATCH', 'Run Lineage Resolution belongs to another Lifecycle Plan.');
  assert(Date.parse(resolution.expiresAt) > Date.parse(typeof now === 'function' ? now() : now), 'RUN_LINEAGE_RESOLUTION_EXPIRED', 'Run Lineage Resolution has expired.');
  assert(resolution.lineageRevision === (currentLineage?.revision ?? 0) && resolution.activeLineageRunId === (currentLineage?.activeRunId ?? null), 'RUN_LINEAGE_RESOLUTION_STALE', 'Run Lineage Authority changed after lineage resolution.');
  const current = new Map(states.map(state => [state.runId, state]));
  const currentCandidateIds = states.filter(state => state.status !== 'superseded' && belongsToLogicalTask(state, plan)).map(state => state.runId).sort();
  assert(digestJson(currentCandidateIds) === digestJson(resolution.candidates.map(candidate => candidate.runId).sort()), 'RUN_LINEAGE_RESOLUTION_STALE', 'The logical Run candidate set changed after lineage resolution.');
  for (const candidate of resolution.candidates) {
    const state = current.get(candidate.runId);
    assert(state && state.revision === candidate.revision && state.authorityDigest === candidate.authorityDigest, 'RUN_LINEAGE_RESOLUTION_STALE', 'Run Authority changed after lineage resolution.', { runId: candidate.runId });
  }
  return resolution;
};

export class RunLineageStore {
  constructor({ root, controlRoot, now = () => new Date().toISOString() }) {
    this.root = assertHarnessWritePath(root, 'Run lineage root', controlRoot);
    this.controlRoot = controlRoot;
    this.now = now;
  }

  file(projectId, logicalTaskKey) {
    return resolve(this.root, 'lineages', safeSegment(projectId, 'projectId'), `${safeSegment(logicalTaskKey, 'logicalTaskKey')}.json`);
  }

  async read(projectId, logicalTaskKey, { required = false } = {}) {
    const value = await readJson(this.file(projectId, logicalTaskKey), null);
    if (!value && required) assert(false, 'RUN_LINEAGE_NOT_FOUND', 'Run Lineage Authority was not found.');
    return value ? validateRunLineage(value) : null;
  }

  async activate({ projectId, logicalTaskKey, activeRunId, planDigest, resolutionDigest }, { expectedRevision = 0, commandId }) {
    assert(commandId, 'COMMAND_ID_REQUIRED', 'Run lineage activation requires a command ID.');
    const file = this.file(projectId, logicalTaskKey);
    return withDirectoryLock(`${file}.lock`, async () => {
      const current = await this.read(projectId, logicalTaskKey);
      const payload = { projectId, logicalTaskKey, activeRunId, planDigest, resolutionDigest };
      const payloadDigest = digestJson(payload);
      const prior = current?.commands?.[commandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'The lineage command ID was reused with different input.');
        return { lineage: current, receipt: prior, reused: true };
      }
      assert((current?.revision ?? 0) === expectedRevision, 'RUN_LINEAGE_REVISION_CONFLICT', 'Run Lineage Authority changed before activation.', { expected: expectedRevision, actual: current?.revision ?? 0 });
      const at = this.now();
      const revision = expectedRevision + 1;
      const history = [...(current?.history ?? [])];
      if (current?.activeRunId && current.activeRunId !== activeRunId) history.push({ runId: current.activeRunId, planDigest: current.planDigest, supersededAt: at, resolutionDigest });
      const receipt = { commandId, payloadDigest, revision, committedAt: at, result: { activeRunId, planDigest, resolutionDigest } };
      const body = {
        protocolVersion: '1.0', kind: 'run-lineage', projectId, logicalTaskKey, revision, activeRunId, planDigest, resolutionDigest,
        history, commands: { ...(current?.commands ?? {}), [commandId]: receipt }, createdAt: current?.createdAt ?? at, updatedAt: at,
      };
      const lineage = validateRunLineage({ ...body, authorityDigest: runLineageAuthorityDigest(body) });
      await atomicWriteJson(file, lineage, { root: this.root });
      return { lineage, receipt, reused: false };
    }, { root: this.root });
  }

  async assertActive(projectId, logicalTaskKey, runId) {
    const lineage = await this.read(projectId, logicalTaskKey, { required: true });
    assert(lineage.activeRunId === runId, 'RUN_LINEAGE_NOT_ACTIVE', `Run ${runId} is not the active Run for its logical task.`, { activeRunId: lineage.activeRunId });
    return lineage;
  }
}
