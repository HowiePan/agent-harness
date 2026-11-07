import { digestJson } from './canonical.mjs';
import { continuousPolicy } from './continuous-execution.mjs';

export const INTERRUPTION_POLICY = 'bounded-interruption/1';
export const MAX_INTERVENTIONS_PER_ROOT = 2;
export const interventionAllowance = (feature, state) => {
  const continuous=continuousPolicy(state);
  if(continuous && feature.kind!=='execution-diagnostic') return continuous.recovery.cyclesPerProblem*continuous.recovery.diagnosticsPerCycle;
  const reserve = feature.metadata?.deliveryOwnerProposal?.deliveryBatchReserve ?? feature.metadata?.approvedProposal?.deliveryBatchReserve;
  return Number.isSafeInteger(reserve) ? Math.max(0, Math.min(MAX_INTERVENTIONS_PER_ROOT, reserve)) : MAX_INTERVENTIONS_PER_ROOT;
};
export const featureContractDigest = feature => digestJson({ id: feature.id, logicalRoot: feature.logicalRoot,
  task: feature.task ?? null, allowedPaths: feature.allowedPaths, forbiddenPaths: feature.forbiddenPaths,
  acceptance: feature.acceptance, deliveryBatch: feature.metadata?.deliveryBatch ?? null });
