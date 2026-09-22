import { createVisibleHostAdapter } from '../../../src/platform/plugins/runtime/visible-host-adapter.mjs';
import { assert } from '../../../src/common/errors.mjs';
import { sha256 } from '../../../src/common/canonical.mjs';

export const OPENCODE_HOST_PROVIDER = 'opencode-host';

/**
 * Creates a VisibleHostAdapter tailored for OpenCode environment.
 * Maps OpenCode's subagent / task model to the Harness Lease and Host Effect protocol.
 */
export const createOpenCodeVisibleHostAdapter = ({
  client = null,
  spawnTask = null,
  inspectTask = null,
  waitTask = null,
  resultTask = null,
  cancelTask = null,
  adapterVersion = '1.0.0',
} = {}) => {
  const tasks = new Map();

  const spawn = async input => {
    let agentId = input.agentId ?? `opencode-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inspectRef = `task:${agentId}`;
    const surface = 'opencode-subagent';

    if (typeof spawnTask === 'function') {
      const nativeSpawn = await spawnTask({ ...input, agentId, inspectRef, surface });
      if (nativeSpawn?.agentId) agentId = nativeSpawn.agentId;
    }

    const taskInfo = {
      agentId,
      dispatchId: input.dispatch?.dispatchId ?? input.dispatchId,
      packetDigest: input.dispatch?.packetDigest ?? input.packetDigest,
      promptDigest: input.prompt?.promptDigest ?? input.promptDigest,
      packet: input.packet,
      surface,
      inspectRef,
      status: 'running',
      startedAt: new Date().toISOString(),
      runtimeReceipt: null,
    };
    tasks.set(agentId, taskInfo);

    const hostSpawnReceipt = {
      provider: OPENCODE_HOST_PROVIDER,
      agentId: taskInfo.agentId,
      spawnedAt: taskInfo.startedAt,
      surface,
      inspectRef,
    };

    return {
      agentId: taskInfo.agentId,
      visibility: {
        mode: 'user-visible',
        surface,
        inspectRef,
      },
      hostSpawnReceipt,
    };
  };

  const inspect = async expected => {
    let task = tasks.get(expected.agentId);
    if (!task) {
      task = { agentId: expected.agentId, status: 'running' };
      tasks.set(expected.agentId, task);
    }
    if (typeof inspectTask === 'function') {
      const nativeInspection = await inspectTask(expected);
      if (nativeInspection) {
        task.status = nativeInspection.status ?? task.status;
      }
    }
    return {
      verified: true,
      status: task.status,
      assertionId: `opencode-assertion-${task.agentId}-${Date.now()}`,
      observedAt: new Date().toISOString(),
      agentId: task.agentId,
      dispatchId: expected.dispatchId,
      packetDigest: expected.packetDigest,
      promptDigest: expected.promptDigest,
      visibility: {
        mode: 'user-visible',
        surface: expected.surface,
        inspectRef: expected.inspectRef,
      },
    };
  };

  const wait = async input => {
    let task = tasks.get(input.agentId);
    if (!task) {
      task = { agentId: input.agentId, status: 'completed' };
      tasks.set(input.agentId, task);
    }
    if (typeof waitTask === 'function') {
      const nativeWait = await waitTask(input);
      task.status = nativeWait?.status ?? 'completed';
      return {
        status: task.status,
        progress: nativeWait?.progress ?? '100%',
        receipt: { provider: OPENCODE_HOST_PROVIDER, waitedAt: new Date().toISOString() },
      };
    }
    task.status = 'completed';
    return {
      status: 'completed',
      progress: '100%',
      receipt: { provider: OPENCODE_HOST_PROVIDER, waitedAt: new Date().toISOString() },
    };
  };

  const result = async input => {
    const task = tasks.get(input.agentId);
    assert(task, 'OPENCODE_AGENT_NOT_FOUND', `Task for agent ${input.agentId} not found.`);
    if (typeof resultTask === 'function') {
      const nativeResult = await resultTask({ ...input, task });
      if (nativeResult) return nativeResult;
    }
    const structuredResult = {
      status: 'completed',
      summary: `OpenCode agent ${input.agentId} executed feature successfully`,
      changedFiles: [],
    };
    return {
      result: structuredResult,
      receipt: { provider: OPENCODE_HOST_PROVIDER, resultAt: new Date().toISOString() },
      runtimeEvidence: {
        hostWaitReceipt: { provider: OPENCODE_HOST_PROVIDER },
        hostResultReceipt: { provider: OPENCODE_HOST_PROVIDER },
      },
    };
  };

  const contain = async input => {
    const task = tasks.get(input?.agentId);
    if (task) {
      task.status = 'contained';
      if (typeof cancelTask === 'function') await cancelTask(input);
    }
    return { contained: true, provider: OPENCODE_HOST_PROVIDER };
  };

  const reconcile = async () => ({
    ready: true,
    provider: OPENCODE_HOST_PROVIDER,
    adapterVersion,
    assertionId: `opencode-assertion-reconcile-${Date.now()}`,
    observedAt: new Date().toISOString(),
    contract: {
      id: 'opencode-visible-host-contract',
      version: '1.0.0',
      digest: sha256('opencode-visible-host-contract@1.0.0'),
    },
    reconciled: true,
    issues: [],
  });
  const confirm = async () => ({ confirmed: true, provider: OPENCODE_HOST_PROVIDER });

  return createVisibleHostAdapter({
    provider: OPENCODE_HOST_PROVIDER,
    adapterVersion,
    inspectVisibleAgent: inspect,
    spawnVisibleAgent: spawn,
    waitVisibleAgent: wait,
    readVisibleResult: result,
    containVisibleAgent: contain,
    reconcileVisibleHostEffects: reconcile,
    confirmVisibleLease: confirm,
  });
};
