import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../../../common/canonical.mjs';
import { assert } from '../../../common/errors.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../../../kernel/atomic-io.mjs';
import { safeSegment } from '../../../common/paths.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../../../common/write-boundary.mjs';
import { verifySourceManifest } from '../../workflow/source-manifest.mjs';

const scopeKinds = new Set(['common', 'project', 'workflow', 'source', 'session']);
const sha = /^[a-f0-9]{64}$/;
const sensitive = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,})/i;

export const defineMemorySpace = input => {
  assert(scopeKinds.has(input?.scope) && input.domainId && input.projectId, 'MEMORY_SPACE_INVALID', 'Memory Space requires a scope, domain, and Project.');
  if (['workflow', 'source', 'session'].includes(input.scope)) assert(input.workflowId, 'MEMORY_WORKFLOW_REQUIRED', 'This Memory Space requires a Workflow ID.');
  if (input.scope === 'source') assert(input.sourceId, 'MEMORY_SOURCE_REQUIRED', 'Source memory requires a Source ID.');
  if (input.scope === 'session') assert(input.sessionId, 'MEMORY_SESSION_REQUIRED', 'Session memory requires a session ID.');
  const memberProjectIds = input.scope === 'common' ? [...new Set(input.memberProjectIds ?? [input.projectId])].sort() : [input.projectId];
  assert(memberProjectIds.includes(input.projectId), 'MEMORY_SPACE_OWNER_INVALID', 'Memory Space owner must be a member.');
  const body = { scope: input.scope, domainId: input.domainId, projectId: input.projectId, ...(input.scope === 'common' && memberProjectIds.length > 1 ? { memberProjectIds } : {}), workflowId: input.workflowId ?? null, sourceId: input.sourceId ?? null, sessionId: input.sessionId ?? null };
  return { ...body, spaceId: digestJson(body) };
};

const sourceMap = manifest => new Map((manifest?.sources ?? []).flatMap(source => source.files.map(file => [`${source.sourceId}/${file.path}`, file.sha256])));
const validRecord = record => {
  assert(record?.topic && record?.claim && ['fact', 'inference', 'decision', 'negative'].includes(record.kind), 'MEMORY_RECORD_INVALID', 'Memory record requires a typed claim and topic.');
  assert(Array.isArray(record.dependencies) && record.dependencies.every(item => item.sourceId && item.path && sha.test(item.contentDigest ?? '')), 'MEMORY_DEPENDENCY_INVALID', 'Memory record requires exact source dependencies.');
  assert(record.evidenceRef || record.kind === 'negative', 'MEMORY_EVIDENCE_REQUIRED', 'Persistent memory requires an Evidence reference.');
  if (record.coverageSourceIds !== undefined) assert(Array.isArray(record.coverageSourceIds) && record.coverageSourceIds.length > 0 && record.coverageSourceIds.every(id => typeof id === 'string' && id.length > 0) && new Set(record.coverageSourceIds).size === record.coverageSourceIds.length && sha.test(record.coverageDigest ?? ''), 'MEMORY_COVERAGE_INVALID', 'Coverage must list unique Source IDs and the exact Source Set digest.');
  return record;
};

export class MemoryStore {
  constructor({ controlRoot: controlRootInput, root, authorityStore = null, now = () => new Date().toISOString() }) {
    this.controlRoot = harnessControlRoot(controlRootInput);
    this.root = assertHarnessWritePath(root ?? resolve(this.controlRoot, 'memory'), 'Memory root', this.controlRoot);
    this.authorityStore = authorityStore;
    this.now = now;
  }

  file(space) { return assertHarnessWritePath(resolve(this.root, `${safeSegment(space.spaceId, 'memorySpace')}.json`), 'Memory Space', this.controlRoot); }
  effectFile(commandId) { return assertHarnessWritePath(resolve(this.root, 'effects', `${safeSegment(commandId, 'commandId')}.json`), 'Memory effect', this.controlRoot); }
  async read(spaceInput) {
    const space = defineMemorySpace(spaceInput);
    const empty = { schemaVersion: '1.0', space, revision: 0, records: [], commands: {} };
    const state = await readJson(this.file(space), null);
    if (!state) return { ...empty, documentDigest: digestJson(empty) };
    assert(state.space?.spaceId === space.spaceId && state.documentDigest === digestJson(withoutKeys(state, ['documentDigest'])), 'MEMORY_STORE_DIGEST_MISMATCH', 'Memory Space content digest is invalid.');
    return state;
  }

  async propose({ space: spaceInput, record: recordInput, commandId, expectedRevision }) {
    const space = defineMemorySpace(spaceInput);
    const record = validRecord(structuredClone(recordInput));
    assert(record.kind !== 'negative', 'MEMORY_NEGATIVE_SCOPE_INVALID', 'Use rejectAnswer for temporary negative memory.');
    assert(record.dependencies.length > 0, 'MEMORY_DEPENDENCY_REQUIRED', 'Persistent claims require exact source dependencies.');
    const recordId = digestJson({ spaceId: space.spaceId, kind: record.kind, topic: record.topic, claim: record.claim, dependencies: record.dependencies, ...(record.coverageSourceIds ? { coverageSourceIds: [...record.coverageSourceIds].sort(), coverageDigest: record.coverageDigest } : {}) });
    return this.#write(space, { commandId, expectedRevision, payload: { operation: 'propose', recordId, record } }, state => {
      const existing = state.records.find(item => item.recordId === recordId);
      assert(!existing, 'MEMORY_RECORD_DUPLICATE', 'The same memory claim already exists.');
      const conflictWith = state.records.filter(item => item.topic === record.topic && item.kind === record.kind && item.claim !== record.claim && item.status === 'verified').map(item => item.recordId);
      state.records.push({ ...record, recordId, status: conflictWith.length ? 'conflict-review' : 'candidate', conflictWith, createdAt: this.now(), verifiedAt: null, revokedAt: null });
      return { recordId, conflictWith };
    });
  }

  async stageFromSubmission({ space: spaceInput, projectId, runId, submissionId, commandId, expectedRevision }) {
    assert(this.authorityStore, 'MEMORY_AUTHORITY_REQUIRED', 'Staging requires an Authority Store.');
    const space = defineMemorySpace(spaceInput);
    assert((space.memberProjectIds ?? [space.projectId]).includes(projectId), 'MEMORY_PROJECT_MISMATCH', 'Submission Project is not a Memory Space member.');
    const state = await this.authorityStore.read(projectId, runId);
    const submission = state.submissions.find(item => item.submissionId === submissionId && !item.supersededAt && item.result?.status === 'completed');
    assert(submission?.evidenceRefs?.length, 'MEMORY_SUBMISSION_INVALID', 'Staging requires a completed evidenced Submission.');
    const output = submission.result.outputs?.knowledge;
    assert(output?.schemaId === 'memory-candidates-v1' && Array.isArray(output.value?.records) && output.value.records.length > 0 && output.value.records.length <= 20, 'MEMORY_CANDIDATES_INVALID', 'Submission must contain 1-20 typed memory candidates.');
    const records = output.value.records.map(candidate => validRecord({ ...structuredClone(candidate), evidenceRef: submission.evidenceRefs[0] }));
    return this.#write(space, { commandId, expectedRevision, payload: { operation: 'stage', projectId, runId, submissionId, records } }, target => {
      const recordIds = [];
      for (const record of records) {
        const recordId = digestJson({ spaceId: space.spaceId, kind: record.kind, topic: record.topic, claim: record.claim, dependencies: record.dependencies, ...(record.coverageSourceIds ? { coverageSourceIds: [...record.coverageSourceIds].sort(), coverageDigest: record.coverageDigest } : {}) });
        const imported = target.records.find(item => item.recordId === recordId && item.status === 'imported-unverified');
        if (imported) {
          Object.assign(imported, record, { status: 'candidate', createdAt: this.now(), verifiedAt: null, revokedAt: null });
        } else if (!target.records.some(item => item.recordId === recordId)) {
          const conflictWith = target.records.filter(item => item.topic === record.topic && item.kind === record.kind && item.claim !== record.claim && item.status === 'verified').map(item => item.recordId);
          target.records.push({ ...record, recordId, status: conflictWith.length ? 'conflict-review' : 'candidate', conflictWith, createdAt: this.now(), verifiedAt: null, revokedAt: null });
        }
        recordIds.push(recordId);
      }
      return { recordIds };
    });
  }

  async promote({ space: spaceInput, recordId, projectId, runId, submissionId, commandId, expectedRevision, verifier }) {
    assert(this.authorityStore, 'MEMORY_AUTHORITY_REQUIRED', 'Memory promotion requires an Authority Store.');
    const state = await this.authorityStore.read(projectId, runId);
    const submission = state.submissions.find(item => item.submissionId === submissionId && !item.supersededAt && item.result?.status === 'completed');
    assert(submission, 'MEMORY_SUBMISSION_INVALID', 'Promotion requires a completed active Submission.');
    assert(verifier?.kind === 'deterministic' || verifier?.kind === 'user-confirmed', 'MEMORY_VERIFICATION_REQUIRED', 'Promotion requires deterministic or user verification.');
    const space = defineMemorySpace(spaceInput);
    assert((space.memberProjectIds ?? [space.projectId]).includes(projectId), 'MEMORY_PROJECT_MISMATCH', 'Submission Project is not a Memory Space member.');
    const candidate = (await this.read(space)).records.find(item => item.recordId === recordId);
    if (candidate?.status === 'conflict-review') assert(verifier.kind === 'user-confirmed' && ['supersede', 'keep-both'].includes(verifier.resolution), 'MEMORY_CONFLICT_DECISION_REQUIRED', 'Conflicting knowledge requires a user resolution.');
    const effect = { schemaVersion: '1.0', operation: 'memory.promote', space, recordId, projectId, runId, submissionId, verifier, commandId, expectedRevision };
    const effectFile = this.effectFile(commandId);
    const previousEffect = await readJson(effectFile, null);
    assert(!previousEffect || previousEffect.effectDigest === digestJson(effect), 'COMMAND_ID_REUSED', 'Memory promotion command ID was reused.');
    if (!previousEffect) await atomicWriteJson(effectFile, { ...effect, effectDigest: digestJson(effect), status: 'pending' }, { root: this.controlRoot });
    const committed = await this.#write(space, { commandId, expectedRevision, payload: effect }, target => {
      const record = target.records.find(item => item.recordId === recordId && ['candidate', 'conflict-review'].includes(item.status));
      assert(record, 'MEMORY_CANDIDATE_REQUIRED', 'Promotion requires a candidate record.');
      assert(submission.evidenceRefs.includes(record.evidenceRef), 'MEMORY_EVIDENCE_MISMATCH', 'Candidate evidence must belong to the submitted result.');
      if (record.status === 'conflict-review') {
        assert(verifier.kind === 'user-confirmed' && ['supersede', 'keep-both'].includes(verifier.resolution), 'MEMORY_CONFLICT_DECISION_REQUIRED', 'Conflicting knowledge requires a user resolution.');
        if (verifier.resolution === 'supersede') for (const conflictId of record.conflictWith) {
          const prior = target.records.find(item => item.recordId === conflictId && item.status === 'verified');
          if (prior) { prior.status = 'revoked'; prior.revokedAt = this.now(); prior.revocationReason = `superseded-by:${recordId}`; }
        }
      }
      record.status = 'verified';
      record.verifiedAt = this.now();
      record.verification = { projectId, runId, submissionId, verifier: structuredClone(verifier) };
      return { recordId, status: 'verified' };
    });
    await atomicWriteJson(effectFile, { ...effect, effectDigest: digestJson(effect), status: 'committed', receipt: committed.result }, { root: this.controlRoot });
    return committed;
  }

  async recoverPendingPromotions() {
    let files;
    try { files = await readdir(resolve(this.root, 'effects')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const receipts = [];
    for (const file of files.filter(name => name.endsWith('.json')).sort()) {
      const effect = await readJson(resolve(this.root, 'effects', file));
      if (effect.status !== 'pending') continue;
      const { space, recordId, projectId, runId, submissionId, commandId, expectedRevision, verifier } = effect;
      receipts.push(await this.promote({ space, recordId, projectId, runId, submissionId, commandId, expectedRevision, verifier }));
    }
    return receipts;
  }

  async revoke({ space: spaceInput, recordId, reason, commandId, expectedRevision }) {
    const space = defineMemorySpace(spaceInput);
    assert(reason, 'MEMORY_REVOKE_REASON_REQUIRED', 'Revocation requires a reason.');
    return this.#write(space, { commandId, expectedRevision, payload: { operation: 'revoke', recordId, reason } }, state => {
      const record = state.records.find(item => item.recordId === recordId && item.status === 'verified');
      assert(record, 'MEMORY_VERIFIED_RECORD_REQUIRED', 'Revocation requires a verified record.');
      record.status = 'revoked'; record.revokedAt = this.now(); record.revocationReason = reason;
      return { recordId, status: 'revoked' };
    });
  }

  async rejectAnswer({ space: spaceInput, claimFingerprint, reason, expiresAt, commandId, expectedRevision }) {
    const space = defineMemorySpace(spaceInput);
    assert(space.scope === 'session' && sha.test(claimFingerprint ?? '') && Date.parse(expiresAt) > Date.parse(this.now()), 'MEMORY_NEGATIVE_INVALID', 'Temporary negative memory requires a session, claim fingerprint, and future expiry.');
    return this.#write(space, { commandId, expectedRevision, payload: { operation: 'reject', claimFingerprint, reason, expiresAt } }, state => {
      const recordId = digestJson({ spaceId: space.spaceId, claimFingerprint });
      if (!state.records.some(item => item.recordId === recordId)) state.records.push({ recordId, kind: 'negative', topic: claimFingerprint, claim: reason, dependencies: [], status: 'verified', expiresAt, createdAt: this.now() });
      return { recordId };
    });
  }

  async exportVerified({ space: spaceInput, exportRoot, recordIds }) {
    const space = defineMemorySpace(spaceInput);
    assert(space.scope !== 'session', 'MEMORY_SESSION_EXPORT_DENIED', 'Session memory cannot be exported.');
    assert(Array.isArray(recordIds) && recordIds.length > 0 && new Set(recordIds).size === recordIds.length, 'MEMORY_EXPORT_SELECTION_INVALID', 'Export requires explicit unique record IDs.');
    const state = await this.read(space);
    const records = recordIds.map(id => {
      const record = state.records.find(item => item.recordId === id && item.status === 'verified' && item.visibility === 'shared');
      assert(record, 'MEMORY_EXPORT_RECORD_DENIED', `Record ${id} is not verified and explicitly shareable.`);
      assert(!sensitive.test(JSON.stringify(record)), 'MEMORY_EXPORT_SENSITIVE_CONTENT', 'Shareable memory contains recognizable credential material.');
      return { recordId: record.recordId, kind: record.kind, topic: record.topic, claim: record.claim, dependencies: structuredClone(record.dependencies), ...(record.coverageSourceIds ? { coverageSourceIds: structuredClone(record.coverageSourceIds), coverageDigest: record.coverageDigest } : {}), origin: { spaceId: space.spaceId, projectId: record.verification?.projectId ?? space.projectId, workflowId: space.workflowId, evidenceDigest: digestJson(record.evidenceRef) } };
    });
    const body = { schemaVersion: '1.0', space, records, sourceRevision: state.revision };
    const bundle = { ...body, bundleDigest: digestJson(body) };
    const root = assertHarnessWritePath(resolve(exportRoot), 'Memory Git export root', this.controlRoot);
    const file = assertHarnessWritePath(resolve(root, `${space.spaceId}.json`), 'Memory Git export bundle', this.controlRoot);
    await atomicWriteJson(file, bundle, { root: this.controlRoot });
    return { file, bundleDigest: bundle.bundleDigest, recordCount: records.length };
  }

  async importUnverified({ space: spaceInput, bundleFile, commandId, expectedRevision }) {
    const space = defineMemorySpace(spaceInput);
    const file = assertHarnessWritePath(resolve(bundleFile), 'Memory Git import bundle', this.controlRoot);
    const bundle = await readJson(file);
    const { bundleDigest, ...body } = bundle;
    assert(bundleDigest === digestJson(body) && digestJson(bundle.space) === digestJson(space) && Array.isArray(bundle.records) && bundle.records.length > 0 && bundle.records.length <= 1000, 'MEMORY_IMPORT_BUNDLE_INVALID', 'Imported memory bundle digest or Space does not match.');
    return this.#write(space, { commandId, expectedRevision, payload: { operation: 'import', bundleDigest } }, state => {
      const imported = [];
      for (const record of bundle.records) {
        assert(record?.recordId === digestJson({ spaceId: space.spaceId, kind: record.kind, topic: record.topic, claim: record.claim, dependencies: record.dependencies, ...(record.coverageSourceIds ? { coverageSourceIds: [...record.coverageSourceIds].sort(), coverageDigest: record.coverageDigest } : {}) }) && ['fact', 'inference', 'decision'].includes(record.kind) && record.topic && record.claim && Array.isArray(record.dependencies) && record.dependencies.length > 0 && record.dependencies.every(item => item.sourceId && item.path && sha.test(item.contentDigest ?? '')) && record.origin?.spaceId === space.spaceId, 'MEMORY_IMPORT_RECORD_INVALID', 'Imported record identity, evidence origin, or dependencies are invalid.');
        if (state.records.some(item => item.recordId === record.recordId)) continue;
        state.records.push({ recordId: record.recordId, kind: record.kind, topic: record.topic, claim: record.claim, dependencies: structuredClone(record.dependencies), ...(record.coverageSourceIds ? { coverageSourceIds: structuredClone(record.coverageSourceIds), coverageDigest: record.coverageDigest } : {}), origin: structuredClone(record.origin), status: 'imported-unverified', evidenceRef: null, createdAt: this.now(), verifiedAt: null, revokedAt: null });
        imported.push(record.recordId);
      }
      return { imported, status: 'unverified' };
    });
  }

  async query({ spaces, workflowId, projectId, manifest, topic, sessionId = null }) {
    verifySourceManifest(manifest);
    assert(manifest.projectId === projectId, 'MEMORY_SOURCE_PROJECT_MISMATCH', 'Memory query Source Manifest belongs to another Project.');
    const pinned = sourceMap(manifest);
    const matches = [];
    for (const input of spaces) {
      const space = defineMemorySpace(input);
      assert((space.memberProjectIds ?? [space.projectId]).includes(projectId) && (space.workflowId === null || space.workflowId === workflowId) && (space.sessionId === null || space.sessionId === sessionId), 'MEMORY_SCOPE_DENIED', 'Memory Space is outside the query scope.');
      const state = await this.read(space);
      for (const record of state.records) {
        if (record.status !== 'verified' || (record.expiresAt && Date.parse(record.expiresAt) <= Date.parse(this.now()))) continue;
        if (topic && record.kind !== 'negative' && !`${record.topic} ${record.claim}`.toLowerCase().includes(topic.toLowerCase())) continue;
        const valid = record.dependencies.every(item => pinned.get(`${item.sourceId}/${item.path}`) === item.contentDigest)
          && (!record.coverageSourceIds || digestJson([...record.coverageSourceIds].sort()) === digestJson(manifest.sources.map(source => source.sourceId).sort()) && record.coverageDigest === manifest.sourceSetDigest);
        matches.push({ ...structuredClone(record), spaceId: space.spaceId, spaceRevision: state.revision, validity: valid ? 'current' : 'recheck-required' });
      }
    }
    const conflicted = new Set(matches.filter(item => item.kind !== 'negative' && item.validity === 'current' && matches.some(other => other.recordId !== item.recordId && other.kind === item.kind && other.topic === item.topic && other.claim !== item.claim && other.validity === 'current')).map(item => item.recordId));
    for (const item of matches) if (conflicted.has(item.recordId)) item.validity = 'conflicted';
    return matches.sort((a, b) => a.recordId.localeCompare(b.recordId));
  }

  async #write(space, { commandId, expectedRevision, payload }, mutate) {
    assert(commandId && Number.isInteger(expectedRevision) && expectedRevision >= 0, 'MEMORY_COMMAND_INVALID', 'Memory writes require command ID and expected revision.');
    const file = this.file(space);
    return withDirectoryLock(`${file}.lock`, async () => {
      const state = await this.read(space);
      const payloadDigest = digestJson(payload);
      const prior = state.commands[commandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Memory command ID was reused with different input.');
        return { state, result: prior.result, reused: true };
      }
      assert(state.revision === expectedRevision, 'MEMORY_REVISION_CONFLICT', 'Memory Space revision changed.');
      const result = mutate(state);
      state.revision += 1;
      state.commands[commandId] = { payloadDigest, result, committedAt: this.now() };
      state.documentDigest = digestJson(withoutKeys(state, ['documentDigest']));
      await atomicWriteJson(file, state, { root: this.controlRoot });
      return { state, result, reused: false };
    }, { root: this.controlRoot });
  }
}
