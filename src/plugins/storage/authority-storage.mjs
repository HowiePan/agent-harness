import { envelope } from '../contracts.mjs';

export const createAuthorityStoragePlugin = ({ manifest, store }) => ({
  async read(projectId, runId, options) { return envelope(manifest, 'receipt', { operation: 'read', value: await store.read(projectId, runId, options) }); },
  async create(state, command) { return envelope(manifest, 'receipt', { operation: 'create', value: await store.create(state, command) }); },
  async transact(projectId, runId, command, mutate) { return envelope(manifest, 'receipt', { operation: 'transact', value: await store.transact(projectId, runId, command, mutate) }); },
});
