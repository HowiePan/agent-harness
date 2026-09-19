import { resolve } from 'node:path';
import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';

const overlaps = (left, right) => left.workspaceRoot === right.workspaceRoot || left.outputs.some(output => right.outputs.includes(output));
const nowIso = () => new Date().toISOString();

/** Persistent, fair admission for independent Runs sharing a standalone Control Root. */
export class WorkflowAdmissionStore {
  constructor({ controlRoot: controlRootInput, root, authorityStore, now = nowIso }) {
    this.controlRoot = harnessControlRoot(controlRootInput);
    this.root = assertHarnessWritePath(root ?? resolve(this.controlRoot, 'workflow-admission'), 'Workflow admission root', this.controlRoot);
    this.file = resolve(this.root, 'admission.json');
    this.authorityStore = authorityStore;
    this.now = now;
  }

  async read() { return readJson(this.file, { schemaVersion: '1.0', revision: 0, queue: [], leases: [] }); }

  async enqueue({ requestId, projectId, workspaceRoot, outputs = [], providerKeys = [], maxConcurrentRuns = 1, providerCapacity = {} }) {
    assert(requestId && projectId && workspaceRoot, 'ADMISSION_REQUEST_INVALID', 'Admission request requires identity and workspace.');
    const request = { requestId, projectId, workspaceRoot, outputs: [...new Set(outputs)].sort(), providerKeys: [...new Set(providerKeys)].sort(), maxConcurrentRuns, providerCapacity: structuredClone(providerCapacity) };
    const requestDigest = digestJson(request);
    return this.#transact(async state => {
      const prior = state.queue.find(item => item.requestId === requestId);
      if (prior) {
        assert(prior.requestDigest === requestDigest, 'COMMAND_ID_REUSED', 'Admission request ID was reused.');
        prior.lastSeenAt = this.now();
        return { requestId, reused: true };
      }
      state.queue.push({ ...request, requestDigest, status: 'waiting', createdAt: this.now(), lastSeenAt: this.now(), runId: null });
      return { requestId, reused: false };
    });
  }

  async tryAcquire(requestId) {
    return this.#transact(async state => {
      await this.#reap(state);
      const request = state.queue.find(item => item.requestId === requestId);
      assert(request, 'ADMISSION_REQUEST_UNKNOWN', 'Admission request was not queued.');
      request.lastSeenAt = this.now();
      if (request.status === 'running') return { acquired: true, reused: true, leaseId: requestId };
      assert(request.status === 'waiting', 'ADMISSION_REQUEST_CLOSED', 'Admission request is no longer pending.');
      const active = state.leases;
      const capacity = Math.min(request.maxConcurrentRuns, ...active.map(lease => lease.maxConcurrentRuns));
      const available = active.length < capacity
        && !active.some(lease => overlaps(request, lease))
        && request.providerKeys.every(key => active.filter(lease => lease.providerKeys.includes(key)).length < Math.min(request.providerCapacity[key] ?? 1, ...active.filter(lease => lease.providerKeys.includes(key)).map(lease => lease.providerCapacity[key] ?? 1)))
        && !state.queue.slice(0, state.queue.indexOf(request)).some(item => item.status === 'waiting' && (overlaps(item, request) || item.providerKeys.some(key => request.providerKeys.includes(key))));
      if (!available) return { acquired: false };
      request.status = 'running';
      state.leases.push({ ...request, acquiredAt: this.now(), heartbeatAt: this.now(), expiresAt: new Date(Date.parse(this.now()) + 120000).toISOString() });
      return { acquired: true, reused: false, leaseId: requestId };
    });
  }

  async bindRun(requestId, runId) {
    return this.#transact(async state => {
      const lease = state.leases.find(item => item.requestId === requestId);
      assert(lease && (!lease.runId || lease.runId === runId), 'ADMISSION_LEASE_INVALID', 'Admission lease cannot bind another Run.');
      lease.runId = runId;
      state.queue.find(item => item.requestId === requestId).runId = runId;
      return { leaseId: requestId, runId };
    });
  }

  async heartbeat(requestId) {
    return this.#transact(async state => {
      const lease = state.leases.find(item => item.requestId === requestId);
      assert(lease, 'ADMISSION_LEASE_INVALID', 'Admission heartbeat requires a live lease.');
      lease.heartbeatAt = this.now();
      lease.expiresAt = new Date(Date.parse(lease.heartbeatAt) + 120000).toISOString();
      return { leaseId: requestId, expiresAt: lease.expiresAt };
    });
  }

  async release(requestId, status = 'closed') {
    return this.#transact(async state => {
      const request = state.queue.find(item => item.requestId === requestId);
      assert(request, 'ADMISSION_REQUEST_UNKNOWN', 'Admission request is unknown.');
      if (request.status === 'released') return { leaseId: requestId, reused: true };
      state.leases = state.leases.filter(item => item.requestId !== requestId);
      request.status = 'released'; request.releaseStatus = status; request.releasedAt = this.now();
      return { leaseId: requestId, reused: false };
    });
  }

  async #reap(state) {
    for (const lease of [...state.leases]) {
      if (Date.parse(lease.expiresAt) > Date.parse(this.now())) continue;
      const run = lease.runId ? await this.authorityStore.read(lease.projectId, lease.runId, { required: false }) : null;
      if (run && !['closed', 'superseded'].includes(run.status)) continue;
      state.leases = state.leases.filter(item => item.requestId !== lease.requestId);
      const request = state.queue.find(item => item.requestId === lease.requestId);
      request.status = 'released'; request.releaseStatus = 'expired'; request.releasedAt = this.now();
    }
    state.queue = state.queue.filter(item => item.status !== 'waiting' || Date.parse(item.lastSeenAt) + 120000 > Date.parse(this.now()));
  }

  async #transact(mutate) {
    return withDirectoryLock(`${this.file}.lock`, async () => {
      const state = await this.read();
      const result = await mutate(state);
      state.revision += 1;
      await atomicWriteJson(this.file, state, { root: this.controlRoot });
      return result;
    }, { root: this.controlRoot });
  }
}
