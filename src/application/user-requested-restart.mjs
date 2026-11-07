import { assert } from '../common/errors.mjs';
import {assertLifecycleCommandBoundary} from './lifecycle-command-context.mjs';

/** Contain only the stopped command's existing leases; never spawn or clear its stop here. */
export const prepareStoppedUserTransport = async ({state,plan,commandBoundary,kernel,contain,recoverSource}) => {
  if(!state.metadata?.operatorStop?.requested)return state;
  assertLifecycleCommandBoundary(commandBoundary);
  const proof=await commandBoundary.userRestartProof(plan,state,{allowActive:true});
  const leases=state.leases.filter(l=>l.status==='active');
  if(!leases.length&&!state.dispatches.some(d=>['requested','assigned'].includes(d.status)))return state;
  assert(leases.length>0&&state.dispatches.filter(d=>['requested','assigned'].includes(d.status)).every(d=>leases.some(l=>l.dispatchId===d.dispatchId)),
    'USER_RESTART_TRANSPORT_UNBOUND','Every stopped dispatch must have its original bound lease before automatic transport preparation.');
  await commandBoundary.reserveUserRestartRecovery(plan,state);
  for(const lease of leases){
    const result=await contain(lease);
    assert(result?.contained===true&&['interrupted','already-terminal','absent-after-interrupt'].includes(result.outcome?.disposition),
      'USER_RESTART_CONTAINMENT_UNVERIFIED','Restart requires original native containment evidence, never a guessed absence.');
  }
  await commandBoundary.userRestartProof(plan,state,{allowActive:true});
  let current=(await kernel.recover(state.projectId,state.runId,{mode:'ordinary-resume'},
    {expectedRevision:state.revision,commandId:`${proof.commandId}.stopped-transport.${state.runId}`})).state;
  current=await recoverSource(current,`${proof.commandId}.stopped-draft.${state.runId}`);
  assert(current.metadata?.operatorStop?.requested,'USER_RESTART_STOP_LOST','Transport preparation must retain the user stop.');
  return current;
};

/** A new, live user command can resume an idle stopped Run; preparation cannot. */
export const resumeForCurrentUserCommand = async ({state,plan,commandBoundary,kernel}) => {
  if(!state.metadata?.operatorStop?.requested)return state;
  assertLifecycleCommandBoundary(commandBoundary);
  const proof=await commandBoundary.userRestartProof(plan,state);
  assert(state.metadata?.lifecyclePlanDigest===plan.planDigest,'USER_RESTART_PLAN_MISMATCH','Restart requires the exact verified lifecycle Plan.');
  const decision={id:`user-restart-${proof.commandId}-${state.runId}`,actor:'human-user',decision:'approved',action:'resume-execution',
    context:{projectId:state.projectId,runId:state.runId,sourceDigest:state.sourceDigest,priorAuthorityDigest:state.authorityDigest,
      commandId:proof.commandId,userReference:proof.userReference,userIssuedAt:proof.userIssuedAt,
      priorStopDecisionId:proof.stopDecisionId,planDigest:plan.planDigest}};
  return (await kernel.recordDecision(state.projectId,state.runId,decision,
    {expectedRevision:state.revision,commandId:`${proof.commandId}.user-restart.${state.runId}`})).state;
};
