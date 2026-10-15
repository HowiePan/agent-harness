import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { expandApprovedImplementation } from '../flows/delivery-lifecycle/approved-implementation.mjs';
import { assertPlanningReplacementScope, isPlanningRecovery } from './development-planning-recovery.mjs';

const within = (root, path) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
const scope = features => features.map(feature => ({ id: feature.id,
  allowedPaths: [...feature.allowedPaths].sort(), forbiddenPaths: [...feature.forbiddenPaths].sort(),
  dependsOn: feature.dependsOn,
})).sort((left, right) => left.id.localeCompare(right.id));

/** Verify a fresh Plan after retirement changes the Quality Target ledger. */
export const assertDevelopmentReplacementScope = ({ retired, plan, project, planningSource = null }) => {
  const fail = condition => assert(condition, 'VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED',
    'The replacement Plan changed outside the retired Run ledger.');
  fail(retired.status === 'superseded'
    && /^development-h[1234]-recovery:[a-f0-9]{64}$/.test(retired.metadata?.supersededReason ?? '')
    && plan.project.id === retired.projectId && project.id === retired.projectId
    && plan.project.descriptorDigest === project.descriptorDigest
    && plan.logicalTaskKey === retired.metadata.logicalTaskKey
    && (isPlanningRecovery(retired) || plan.run.sourceDigest === retired.sourceDigest)
    && plan.run.executionWorkspaceRoot === retired.metadata.workspace.root
    && digestJson(plan.stopCondition) === digestJson(retired.metadata.stopCondition));
  if (isPlanningRecovery(retired)) {
    assertPlanningReplacementScope({ retired, plan, project, ...planningSource });
    return plan.run.features;
  }
  const approved = retired.metadata.approvedPlan;
  const typedPlan = approved?.projectId === retired.projectId ? approved.typedPlan : null;
  if (typedPlan) fail(plan.run.features.filter(feature => feature.metadata?.stage === 'implementation').length === 1);
  const candidate = typedPlan ? expandApprovedImplementation({ features: plan.run.features,
    typedPlan, projectId: retired.projectId, approvalBinding: approved }) : plan.run.features;
  const expected = structuredClone(retired.features);
  // No completed evidence is transferred here. A Descriptor repair may add
  // only paths already proposed by the approved project-owned plan. Completed
  // work still requires the separate, unchanged-graph carry-over contract.
  if (typedPlan && !retired.features.some(feature => feature.state === 'completed')) {
    const approvedPaths = typedPlan.proposedFeatures.filter(item => item.projectId === retired.projectId
      && item.disposition === 'project-owned').flatMap(item => item.allowedPaths);
    const currentPaths = project.policy.actionPaths.implement;
    fail(Array.isArray(currentPaths));
    for (const feature of expected.filter(item => item.metadata?.stage === 'implementation')) {
      fail(currentPaths.every(path => feature.allowedPaths.some(root => within(root, path))
        || approvedPaths.some(root => within(root, path))));
      feature.allowedPaths = [...currentPaths];
    }
  }
  fail(digestJson(scope(candidate)) === digestJson(scope(expected)));
  return candidate;
};
