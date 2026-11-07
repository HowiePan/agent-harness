// Explicit synthetic user-event host for isolated fixtures. Production defaults remain deny.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHarness as createCoreHarness } from '../src/application/harness.mjs';
import { createLifecycleCommandHost } from '../src/application/lifecycle-command-context.mjs';

let sequence = 0;
export const createTestHarness = async options => {
  const nested = new AsyncLocalStorage();
  const host = createLifecycleCommandHost({ provider: 'isolated-fixture-user',
    verifyCommand: async request => ({ verified: true, purpose: 'business', commandId: request.commandId,
      reference: `fixture-event-${++sequence}`, ...(request.userIssuedAt?{userIssuedAt:request.userIssuedAt}:{}), scope: request.scope }),
    verifyActive: async () => ({ active: true }) });
  const core = await createCoreHarness({ ...options, lifecycleCommandHost: host });
  const plans = new Set(['assertCurrentCommandPlan', 'createExecutionReadinessReport', 'startLifecyclePlan', 'executeLifecyclePlan', 'executeVisibleLifecyclePlan', 'continueVisibleLifecyclePlan']);
  const states = new Set(['readDispatchPacket', 'dispatch', 'spawnDispatch', 'bindDispatch', 'assertCurrentCommandState', 'scheduleInterruptionReview', 'recordResult']);
  const releases=new Set(['promoteVersionRelease','publishVersionRelease','promoteScopedRelease']);
  return new Proxy(core, { get(target, key) {
    if (key === 'withUserLifecycleCommand') return (request, operation) => target.withUserLifecycleCommand(request, () => nested.run(true, operation));
    const value = target[key];
    if (typeof value !== 'function' || !(plans.has(key) || states.has(key) || releases.has(key) || ['startRun', 'invokeGateExecutor'].includes(key))) return value;
    return async (...args) => {
      if (nested.getStore()) return value(...args);
      if (key === 'invokeGateExecutor' && (!args[1]?.projectId || !args[1]?.runId)) return value(...args);
      let scope, commandId;
      if (plans.has(key)) {
        const plan = args[0]; commandId = args[1]?.commandId;
        scope = { projectId: plan.project.id, action: plan.intent.requestedAction ?? plan.intent.action,
          target: plan.intent.target, workspaceRoot: plan.run.executionWorkspaceRoot };
      } else if(releases.has(key)){
        const input=args[0],project=await core.projectRegistry.get(input.projectId);
        scope={projectId:input.projectId,action:'release',target:input.target,workspaceRoot:project.workspace.root};
      } else if (key === 'startRun') {
        const input = args[0], project = await core.projectRegistry.get(input.projectId);
        const intent = input.metadata?.commandIntent ?? { action: 'run', target: input.runId };
        scope = { projectId: input.projectId, action: intent.requestedAction ?? intent.action, target: intent.target,
          workspaceRoot: input.executionWorkspaceRoot ?? project.workspace.root };
      } else {
        const projectId = key === 'invokeGateExecutor' ? args[1].projectId : args[0];
        const runId = key === 'invokeGateExecutor' ? args[1].runId : args[1];
        const state = await core.authorityStore.read(projectId, runId), intent = state.metadata?.commandIntent ?? { action: 'run', target: runId };
        scope = { projectId, action: intent.requestedAction ?? intent.action, target: intent.target, workspaceRoot: state.metadata.workspace.root };
      }
      return core.withUserLifecycleCommand({ commandId: commandId ?? `fixture-command-${++sequence}`, scope },
        () => nested.run(true, () => value(...args)));
    };
  } });
};
