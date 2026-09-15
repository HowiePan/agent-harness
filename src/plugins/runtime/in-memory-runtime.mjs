import { newId } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { envelope } from '../contracts.mjs';

export const createInMemoryRuntime = ({ manifest, handler }) => {
  const tasks = new Map();
  const messages = new Map();
  return {
    async spawn(packet) {
      const agentId = newId('memory-agent');
      const task = { status: 'running', promise: Promise.resolve().then(() => handler(structuredClone(packet), { agentId, messages: messages.get(agentId) ?? [] })) };
      tasks.set(agentId, task);
      messages.set(agentId, []);
      task.promise.then(result => { task.status = 'completed'; task.result = result; }, error => { task.status = 'failed'; task.error = { message: error.message, code: error.code }; });
      return envelope(manifest, 'receipt', { operation: 'spawn', agentId, transportReceipt: { runtimePluginId: manifest.id, mode: 'in-memory', startedAt: new Date().toISOString() } });
    },
    async wait({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'MEMORY_AGENT_NOT_FOUND', `In-memory agent not found: ${agentId}`);
      try { await task.promise; } catch {}
      const transported = task.result?.result && typeof task.result.result === 'object'
        ? { result: task.result.result, verificationReceipts: structuredClone(task.result.verificationReceipts ?? []) }
        : { result: task.result };
      return envelope(manifest, 'event', { operation: 'wait', agentId, status: task.status, ...transported, error: task.error });
    },
    async send({ agentId, message }) {
      assert(tasks.has(agentId), 'MEMORY_AGENT_NOT_FOUND', `In-memory agent not found: ${agentId}`);
      messages.get(agentId).push(structuredClone(message));
      return envelope(manifest, 'receipt', { operation: 'send', agentId, accepted: true });
    },
    async heartbeat({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'MEMORY_AGENT_NOT_FOUND', `In-memory agent not found: ${agentId}`);
      return envelope(manifest, 'receipt', { operation: 'heartbeat', agentId, status: task.status, observedAt: new Date().toISOString() });
    },
    async interrupt({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'MEMORY_AGENT_NOT_FOUND', `In-memory agent not found: ${agentId}`);
      task.status = task.status === 'running' ? 'interrupted' : task.status;
      return envelope(manifest, 'receipt', { operation: 'interrupt', agentId, status: task.status });
    },
  };
};
