import { mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digestJson, newId, withoutKeys } from '../canonical.mjs';
import { assert, fail } from '../errors.mjs';
import { safeSegment } from '../paths.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from './atomic-io.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';

const authorityDigest = state => digestJson(withoutKeys(state, ['authorityDigest']));

export class AuthorityStore {
  constructor({ root, controlRoot, now = () => new Date().toISOString() }) {
    assert(root, 'STATE_ROOT_REQUIRED', 'AuthorityStore requires a managed state root.');
    this.controlRoot = controlRoot;
    this.root = assertHarnessWritePath(root, 'Authority root', controlRoot);
    this.now = now;
  }

  async init() {
    for (const directory of ['authority', 'transactions', 'evidence', 'receipts', 'recovery', 'registry', 'cache']) await mkdir(resolve(this.root, directory), { recursive: true });
    return this;
  }

  runFile(projectId, runId) {
    return resolve(this.root, 'authority', safeSegment(projectId, 'projectId'), safeSegment(runId, 'runId'), 'run.json');
  }

  transactionFile(transactionId) {
    return resolve(this.root, 'transactions', `${safeSegment(transactionId, 'transactionId')}.json`);
  }

  async read(projectId, runId, { required = true } = {}) {
    const state = await readJson(this.runFile(projectId, runId), null);
    if (!state && required) fail('RUN_NOT_FOUND', `Run not found: ${projectId}/${runId}`);
    if (state) {
      assert(state.authorityDigest === authorityDigest(state), 'AUTHORITY_DIGEST_MISMATCH', 'Authority digest does not match persisted state.', { projectId, runId });
    }
    return state;
  }

  async list(projectId) {
    const directory = resolve(this.root, 'authority', safeSegment(projectId, 'projectId'));
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const runs = [];
    for (const entry of entries.filter(item => item.isDirectory())) {
      const state = await this.read(projectId, entry.name, { required: false });
      if (state) runs.push(state);
    }
    return runs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async create(initialState, { commandId, payload = {} }) {
    const projectId = safeSegment(initialState.projectId, 'projectId');
    const runId = safeSegment(initialState.runId, 'runId');
    const file = this.runFile(projectId, runId);
    return withDirectoryLock(`${file}.lock`, async () => {
      const existing = await this.read(projectId, runId, { required: false });
      const payloadDigest = digestJson(payload);
      if (existing) {
        const receipt = existing.commands?.[commandId];
        assert(receipt && receipt.payloadDigest === payloadDigest, 'RUN_ALREADY_EXISTS', `Run already exists: ${projectId}/${runId}`);
        return { state: existing, receipt, reused: true };
      }
      const at = this.now();
      const state = {
        ...structuredClone(initialState),
        revision: 1,
        createdAt: initialState.createdAt ?? at,
        updatedAt: at,
        commands: {},
      };
      const result = { runId, revision: 1 };
      state.commands[commandId] = { commandId, payloadDigest, result, revision: 1, committedAt: at };
      state.authorityDigest = authorityDigest(state);
      await atomicWriteJson(file, state, { root: this.root });
      return { state, receipt: state.commands[commandId], reused: false };
    }, { root: this.root });
  }

  async transact(projectId, runId, { expectedRevision, commandId, payload = {} }, mutate) {
    const file = this.runFile(projectId, runId);
    return withDirectoryLock(`${file}.lock`, async () => {
      const current = await this.read(projectId, runId);
      const payloadDigest = digestJson(payload);
      const prior = current.commands?.[commandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'The command ID was already used with a different payload.', { commandId });
        return { state: current, receipt: prior, result: structuredClone(prior.result), reused: true };
      }
      assert(Number.isInteger(expectedRevision), 'EXPECTED_REVISION_REQUIRED', 'A numeric expected revision is required.');
      assert(current.revision === expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before the command could commit.', { expected: expectedRevision, actual: current.revision });
      const next = structuredClone(current);
      const result = await mutate(next);
      const at = this.now();
      next.revision = current.revision + 1;
      next.updatedAt = at;
      const receipt = { commandId, payloadDigest, result: structuredClone(result ?? null), revision: next.revision, committedAt: at };
      next.commands ??= {};
      next.commands[commandId] = receipt;
      next.authorityDigest = authorityDigest(next);
      const transactionId = newId('txn');
      const journal = { protocolVersion: '1.0', transactionId, status: 'prepared', projectId, runId, commandId, expectedRevision, nextRevision: next.revision, nextAuthorityDigest: next.authorityDigest, preparedAt: at };
      const journalFile = this.transactionFile(transactionId);
      await atomicWriteJson(journalFile, journal, { root: this.root });
      await atomicWriteJson(file, next, { root: this.root });
      await atomicWriteJson(journalFile, { ...journal, status: 'committed', committedAt: this.now() }, { root: this.root });
      return { state: next, receipt, result, reused: false };
    }, { root: this.root });
  }

  async recoverTransactions() {
    const directory = resolve(this.root, 'transactions');
    await mkdir(directory, { recursive: true });
    const outcomes = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      const file = resolve(directory, name);
      const journal = await readJson(file);
      if (journal.status !== 'prepared') continue;
      const state = await this.read(journal.projectId, journal.runId, { required: false });
      const committed = state?.revision >= journal.nextRevision && state?.authorityDigest === journal.nextAuthorityDigest && state?.commands?.[journal.commandId];
      const status = committed ? 'committed' : 'rolled-back';
      await atomicWriteJson(file, { ...journal, status, recoveredAt: this.now() }, { root: this.root });
      outcomes.push({ transactionId: journal.transactionId, status });
    }
    return outcomes;
  }
}

export const computeAuthorityDigest = authorityDigest;
