import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';

const hosts = new WeakSet();
const boundaries = new WeakSet();
export const assertLifecycleCommandBoundary = value => assert(boundaries.has(value), 'CURRENT_USER_COMMAND_REQUIRED', 'Only a trusted current-command boundary can continue execution.');
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const scopeOf = plan => ({ projectId: plan.project.id, action: plan.intent.requestedAction ?? plan.intent.action, target: plan.intent.target,
  workspaceRoot: plan.run.executionWorkspaceRoot });
const stopped = state => {
  const frozen=state.decisions?.some(d=>d.action==='freeze-execution'&&d.decision==='approved');
  const latest=state.decisions?.findLast(d=>['stop-execution','resume-execution'].includes(d.action)&&d.decision==='approved');
  return frozen || (state.metadata?.operatorStop ? state.metadata.operatorStop.requested : latest?.action==='stop-execution');
};

/** Trusted embedding boundary, like Runtime/Grant adapters; never accept one from worker JSON. */
export const createLifecycleCommandHost = ({ provider, verifyCommand, verifyActive, verifyPrestartRetry = () => false }) => {
  assert(typeof provider === 'string' && provider && typeof verifyCommand === 'function' && typeof verifyActive === 'function',
    'LIFECYCLE_COMMAND_HOST_INVALID', 'A command host must verify original user initiation and continued validity.');
  assert(typeof verifyPrestartRetry === 'function', 'LIFECYCLE_COMMAND_HOST_INVALID', 'Prestart retry verification must be trusted host code.');
  const host = Object.freeze({ provider, verifyCommand, verifyActive, verifyPrestartRetry }); hosts.add(host); return host;
};

export const createLifecycleCommandBoundary = ({ root, host = null }) => {
  assert(host === null || hosts.has(host), 'LIFECYCLE_COMMAND_HOST_INVALID', 'Command host must be a trusted adapter.');
  const storage = new AsyncLocalStorage();
  const current = async scope => {
    const context = storage.getStore();
    assert(context?.active && context.purpose === 'business', 'CURRENT_USER_COMMAND_REQUIRED',
      'Business execution requires the current host-verified user command; maintenance and historical receipts cannot initiate it.');
    assert(scope.projectId === context.scope.projectId && scope.action === context.scope.action
      && scope.target === context.scope.target && samePath(scope.workspaceRoot, context.scope.workspaceRoot),
      'CURRENT_USER_COMMAND_SCOPE_MISMATCH', 'Execution differs from the current user command project, goal or workspace.');
    const observation = await host.verifyActive(structuredClone(context.attestation));
    if (observation?.active !== true) { context.active = false; context.record.status = 'revoked'; await save(context); }
    assert(context.active, 'CURRENT_USER_COMMAND_INACTIVE', 'The user command was stopped, replaced or can no longer be verified.');
    return context;
  };
  const save = async context => {
    const body = { ...context.record }; delete body.recordDigest;
    context.record = { ...body, recordDigest: digestJson(body) };
    await atomicWriteJson(context.file, context.record, { root });
  };
  const reserve = async context => {
    if (context.record.recoveries >= context.record.recoveryLimit) { context.active = false; context.record.status = 'exhausted'; await save(context); }
    assert(context.active, 'COMMAND_RECOVERY_EXHAUSTED', 'Current command recovery allowance is exhausted; another Run does not renew it.');
    context.record.recoveries += 1; await save(context);
    return { commandId: context.record.commandId, recovery: context.record.recoveries };
  };
  const boundary = {
    async userRestartProof(plan,state,{allowActive=false}={}) {
      const context=await current(scopeOf(plan));
      const issuedAt=context.attestation.userIssuedAt,stop=state.metadata?.operatorStop;
      assert(stop?.requested && Number.isFinite(Date.parse(issuedAt)) && Date.parse(issuedAt)>Date.parse(stop.at)
        && !['closed','failed','incomplete','superseded'].includes(state.status)
        && !state.decisions?.some(d=>d.action==='freeze-execution'&&d.decision==='approved'),
      'USER_RESTART_REQUIRES_NEW_COMMAND','Only a fresh explicit user command after this stop may resume the original goal.');
      assert(allowActive || !state.leases?.some(l=>['requested','active'].includes(l.status))
        && !state.dispatches?.some(d=>['requested','assigned'].includes(d.status)),
      'OPERATOR_RESUME_EFFECT_ACTIVE','Stopped transport must be formally contained before user-requested restart.');
      assert(state.projectId===plan.project.id && state.metadata?.commandIntent?.action===plan.intent.action
        && state.metadata.commandIntent.target===plan.intent.target && samePath(state.metadata?.workspace?.root,plan.run.executionWorkspaceRoot),
      'CURRENT_USER_COMMAND_SCOPE_MISMATCH','Restart must retain the exact stopped project, target and workspace.');
      return {commandId:context.record.commandId,userReference:context.attestation.reference,userIssuedAt:issuedAt,stopDecisionId:stop.decisionId};
    },
    async reserveUserRestartRecovery(plan,state){
      await boundary.userRestartProof(plan,state,{allowActive:true});
      const context=storage.getStore();
      assert(!context.activeRunId||context.activeRunId===state.runId,'CURRENT_USER_COMMAND_RUN_CHANGED','Restart transport belongs to another pinned Run.');
      context.effectsStarted=true;return reserve(context);
    },
    async assertAction(scope) {
      const context=await current(scope);context.effectsStarted=true;
    },
    async beginPlanEffects(plan) {
      await boundary.assertPlan(plan);storage.getStore().effectsStarted=true;
    },
    async assertScope(plan) {
      const context = await current(scopeOf(plan));
      return {commandId:context.record.commandId};
    },
    async run(request, operation) {
      assert(hosts.has(host), 'CURRENT_USER_COMMAND_REQUIRED', 'No trusted user command host is configured.');
      assert(!storage.getStore(), 'LIFECYCLE_COMMAND_NESTING_DENIED', 'An internal operation cannot initiate another lifecycle command.');
      const attestation = await host.verifyCommand(structuredClone(request));
      assert(attestation?.verified === true && attestation.purpose === 'business' && attestation.reference
        && attestation.commandId === request.commandId && attestation.scope?.projectId && attestation.scope.action
        && attestation.scope.target && attestation.scope.workspaceRoot && (!attestation.dataRoot || samePath(attestation.dataRoot, root)),
      'CURRENT_USER_COMMAND_REQUIRED', 'Host did not verify a current explicit user lifecycle command.');
      // One native user event may initiate once, even with a different command ID or Run.
      const key = digestJson({ provider: host.provider, reference: attestation.reference });
      const file = assertNoLinkPath(root, resolve(root, 'lifecycle-commands', `${key}.json`));
      return withDirectoryLock(`${file}.lock`, async () => {
        const previous = await readJson(file, null);
        const retry = previous?.status === 'prestart-retry' && previous.recordDigest === digestJson(withoutKeys(previous,['recordDigest']))
          && previous.commandId === request.commandId && digestJson(previous.scope) === digestJson(attestation.scope)
          && previous.prestartRestarts === 0 && previous.recoveries < previous.recoveryLimit;
        assert(!previous || retry, 'USER_COMMAND_ALREADY_CONSUMED',
          'This user command was already admitted. An exited process cannot replay it or reset its recovery allowance.');
        const context = { active: true, purpose: attestation.purpose, scope: structuredClone(attestation.scope),
          attestation: structuredClone(attestation), file,
          record: { version: 'lifecycle-command/1', provider: host.provider, reference: attestation.reference,
            commandId: request.commandId, scope: attestation.scope, status: 'running', recoveries: 0, recoveryLimit: 2, prestartRestarts: 0, plans: [] } };
        if (retry) {
          context.record = { ...previous, status: 'running', recoveries: previous.recoveries + 1, prestartRestarts: 1 };
          context.binding = previous.contractBinding; context.activeRunId = previous.activeRunId;
        }
        await save(context);
        return storage.run(context, async () => {
          try { const result = await operation(); if (context.active) context.record.status = 'settled'; return result; }
          catch (error) {
            if (context.active) context.record.status = !context.effectsStarted && context.record.plans.length
              && context.record.prestartRestarts === 0 && await host.verifyPrestartRetry(error)
              ? 'prestart-retry' : 'interrupted';
            throw error;
          }
          finally { context.active = false; await save(context); }
        });
      }, { root });
    },
    async assertPlan(plan, commandId = null) {
      const context = await current(scopeOf(plan));
      assert(!commandId || commandId === context.record.commandId || commandId.startsWith(`${context.record.commandId}.`),
        'CURRENT_USER_COMMAND_ID_MISMATCH', 'Lifecycle entry belongs to another command.');
      const command = context.attestation.command;
      assert(!command || (plan.intent.requestedPreset ?? null) === (command.arguments?.[0] ?? null)
        && (!command.workflowId || plan.workflow?.id === command.workflowId)
        && (!command.extensionId || plan.extension?.id === command.extensionId)
        && (!command.profileId || plan.run.profileId === command.profileId)
        && (!command.projectIds || digestJson([...command.projectIds].sort())===digestJson([...(plan.workspaceRef?.projectIds??[])].sort())),
      'CURRENT_USER_COMMAND_SCOPE_MISMATCH', 'Plan preset, Workflow, Extension or Profile differs from the verified user command.');
      const binding = digestJson({ project: plan.project, workspaceRef:plan.workspaceRef??null, intent: plan.intent, harness: plan.harness, extension: plan.extension ?? null,
        workflow: plan.workflow ?? null, workspace: plan.run.executionWorkspaceRoot, mode: plan.run.agentExecutionMode ?? null,
        runtime: plan.run.runtimePluginId ?? null, constraints: plan.run.executionConstraintDigest ?? null, grant: plan.run.executionGrant ?? null,
        features: plan.run.features ?? null, profile: plan.run.profileConfig ?? null,
        stopCondition: plan.stopCondition ?? null, protectedOperations: plan.protectedOperations ?? [] });
      assert(!context.binding || context.binding === binding, 'CURRENT_USER_COMMAND_CONTRACT_CHANGED',
        'Internal continuation cannot change the original contract, permissions or selected runtime.');
      context.binding = binding;
      assert(!context.activeRunId || context.activeRunId === plan.run.runId, 'CURRENT_USER_COMMAND_RUN_CHANGED',
        'A replacement Run requires verified sealed continuation; changing its ID cannot restart coordination.');
      context.activeRunId = plan.run.runId;
      context.record.contractBinding = binding; context.record.activeRunId = plan.run.runId;
      context.startFeatures = digestJson(plan.run.features ?? []);
      if (!context.record.plans.includes(plan.planDigest)) { context.record.plans.push(plan.planDigest); await save(context); }
      return { commandId: context.record.commandId, reference: context.attestation.reference };
    },
    async assertStart(input, project) {
      const intent = input.metadata?.commandIntent ?? { action: 'run', target: input.runId };
      const context = await current({ projectId: input.projectId, action: intent.requestedAction ?? intent.action, target: intent.target,
        workspaceRoot: input.executionWorkspaceRoot ?? project.workspace.root });
      assert(!context.binding || context.record.plans.includes(input.metadata?.lifecyclePlanDigest)
        && context.activeRunId === input.runId && context.startFeatures === digestJson(input.features ?? []), 'CURRENT_USER_COMMAND_CONTRACT_CHANGED',
        'Raw Run start cannot bypass the pinned lifecycle contract.');
      context.effectsStarted = true;
      return {commandId:context.record.commandId,reference:context.attestation.reference};
    },
    async assertState(state) {
      const intent = state.metadata?.commandIntent ?? { action: 'run', target: state.runId };
      await current({ projectId: state.projectId, action: intent.requestedAction ?? intent.action, target: intent.target, workspaceRoot: state.metadata?.workspace?.root });
      const context = storage.getStore();
      assert(!context.binding || context.activeRunId===state.runId && context.record.plans.includes(state.metadata?.lifecyclePlanDigest),
        'CURRENT_USER_COMMAND_RUN_CHANGED','Run execution differs from the current pinned lifecycle.');
      context.effectsStarted = true;
      if (stopped(state)) { context.active = false; context.record.status = 'stopped'; await save(context); }
      assert(context.active, 'OPERATOR_EXECUTION_STOPPED', 'User stop cannot be cleared by command continuation.');
      assert(!['closed', 'failed', 'incomplete', 'superseded'].includes(state.status),
        'CURRENT_USER_COMMAND_RUN_STOPPED', 'Stopped or terminal Runs cannot dispatch or execute Gates.');
    },
    async reserveContinuation(plan, prior) {
      const context = await current(scopeOf(plan));
      assert(!stopped(prior) && (prior.metadata?.lifecycleUserCommandId ?? prior.metadata?.lifecycleInvocationId) === context.record.commandId,
        'CURRENT_USER_COMMAND_LINEAGE_MISMATCH', 'Old command metadata is evidence, not authority for the current command.');
      return reserve(context);
    },
    async acceptSealedReplacement(plan, prior) {
      const context = await current(scopeOf(plan));
      assert(!context.executionActive && !stopped(prior)
        && (prior.metadata?.lifecycleUserCommandId ?? prior.metadata?.lifecycleInvocationId) === context.record.commandId,
      'CURRENT_USER_COMMAND_LINEAGE_MISMATCH', 'Replacement must belong to the same current user command after the prior execution settled.');
      const previous = context.activeRunId; context.activeRunId = plan.run.runId;
      try { return await boundary.assertPlan(plan); } catch(error) { context.activeRunId = previous; throw error; }
    },
    async execute(plan, commandId, operation) {
      await boundary.assertPlan(plan, commandId);
      const context = storage.getStore();
      assert(!context.executionActive, 'LIFECYCLE_EXECUTION_REENTRY_DENIED', 'A running lifecycle cannot recursively start another lifecycle.');
      if (context.executions) await reserve(context);
      context.executions = (context.executions ?? 0) + 1; context.executionActive = true;
      try { return await operation(); } finally { context.executionActive = false; }
    },
  };
  boundaries.add(boundary); return Object.freeze(boundary);
};
