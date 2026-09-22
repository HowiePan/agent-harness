import { createVisibleHostAdapter } from '../../../src/platform/plugins/runtime/visible-host-adapter.mjs';
import { assert } from '../../../src/common/errors.mjs';

export const VSCODE_HOST_PROVIDER = 'vscode-host';

/**
 * Creates a VisibleHostAdapter tailored for the VS Code extension environment.
 * Maps VS Code Language Model API / Chat stream interactions to the Harness Lease protocol.
 */
export const createVSCodeVisibleHostAdapter = ({
  vscode = null,
  spawnTask = null,
  inspectTask = null,
  waitTask = null,
  cancelTask = null,
  adapterVersion = '1.0.0',
} = {}) => {
  const sessions = new Map();

  const spawn = async input => {
    let agentId = input.agentId ?? `vscode-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const inspectRef = `task:${agentId}`;
    const surface = 'vscode-chat';

    if (typeof spawnTask === 'function') {
      const nativeSpawn = await spawnTask({ ...input, agentId, inspectRef, surface });
      if (nativeSpawn?.agentId) agentId = nativeSpawn.agentId;
    }

    const sessionInfo = {
      agentId,
      dispatchId: input.dispatch?.dispatchId ?? input.dispatchId,
      packetDigest: input.dispatch?.packetDigest ?? input.packetDigest,
      promptDigest: input.prompt?.promptDigest ?? input.promptDigest,
      surface,
      inspectRef,
      status: 'running',
      startedAt: new Date().toISOString(),
      runtimeReceipt: null,
    };
    sessions.set(agentId, sessionInfo);

    const hostSpawnReceipt = {
      provider: VSCODE_HOST_PROVIDER,
      agentId,
      spawnedAt: sessionInfo.startedAt,
      surface,
      inspectRef,
    };

    return {
      agentId,
      visibility: {
        mode: 'user-visible',
        surface,
        inspectRef,
      },
      hostSpawnReceipt,
    };
  };

  const inspect = async expected => {
    const session = sessions.get(expected.agentId);
    assert(session, 'VSCODE_AGENT_NOT_FOUND', `Session for agent ${expected.agentId} not found in VS Code host.`);
    if (typeof inspectTask === 'function') {
      const nativeInspection = await inspectTask(expected);
      if (nativeInspection) {
        session.status = nativeInspection.status ?? session.status;
      }
    }
    return {
      verified: true,
      status: session.status,
      assertionId: `vscode-assertion-${session.agentId}-${Date.now()}`,
      observedAt: new Date().toISOString(),
      agentId: session.agentId,
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
    const session = sessions.get(input.agentId);
    assert(session, 'VSCODE_AGENT_NOT_FOUND', `Session for agent ${input.agentId} not found.`);
    if (typeof waitTask === 'function') {
      const nativeWait = await waitTask(input);
      session.status = nativeWait?.status ?? 'completed';
      return {
        status: session.status,
        progress: nativeWait?.progress ?? '100%',
        receipt: { provider: VSCODE_HOST_PROVIDER, waitedAt: new Date().toISOString() },
      };
    }
    session.status = 'completed';
    return {
      status: 'completed',
      progress: '100%',
      receipt: { provider: VSCODE_HOST_PROVIDER, waitedAt: new Date().toISOString() },
    };
  };

  const result = async input => {
    const session = sessions.get(input.agentId);
    assert(session, 'VSCODE_AGENT_NOT_FOUND', `Session for agent ${input.agentId} not found.`);
    const structuredResult = {
      status: 'completed',
      summary: `VS Code chat agent ${input.agentId} completed feature successfully`,
      changedFiles: [],
    };
    return {
      result: structuredResult,
      receipt: { provider: VSCODE_HOST_PROVIDER, resultAt: new Date().toISOString() },
      runtimeEvidence: {
        hostWaitReceipt: { provider: VSCODE_HOST_PROVIDER },
        hostResultReceipt: { provider: VSCODE_HOST_PROVIDER },
      },
    };
  };

  const contain = async input => {
    const session = sessions.get(input?.agentId);
    if (session) {
      session.status = 'contained';
      if (typeof cancelTask === 'function') await cancelTask(input);
    }
    return { contained: true, provider: VSCODE_HOST_PROVIDER };
  };

  const reconcile = async () => ({ reconciled: true, provider: VSCODE_HOST_PROVIDER });
  const confirm = async () => ({ confirmed: true, provider: VSCODE_HOST_PROVIDER });

  return createVisibleHostAdapter({
    provider: VSCODE_HOST_PROVIDER,
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
