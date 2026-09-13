import { assert } from '../../errors.mjs';
import { envelope } from '../contracts.mjs';

export const createCallbackRuntime = ({ manifest, adapter }) => ({
  async spawn(packet) {
    const result = await adapter.spawn(structuredClone(packet));
    assert(result?.agentId && result?.transportReceipt, 'RUNTIME_SPAWN_RECEIPT_INVALID', 'Runtime spawn requires agentId and transportReceipt.');
    return envelope(manifest, 'receipt', { operation: 'spawn', ...result, transportReceipt: { ...result.transportReceipt, runtimePluginId: manifest.id } });
  },
  async wait(request) { return envelope(manifest, 'event', { operation: 'wait', ...(await adapter.wait(structuredClone(request))) }); },
  async send(request) { return envelope(manifest, 'receipt', { operation: 'send', ...(await adapter.send(structuredClone(request))) }); },
  async heartbeat(request) { return envelope(manifest, 'receipt', { operation: 'heartbeat', ...(await adapter.heartbeat(structuredClone(request))) }); },
  async interrupt(request) { return envelope(manifest, 'receipt', { operation: 'interrupt', ...(await adapter.interrupt(structuredClone(request))) }); },
});
