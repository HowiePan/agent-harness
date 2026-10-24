import { resolve } from 'node:path';
import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';

const within = (root, path) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
export const isPlanningRecovery = state => ['plan', 'replan', 'amend'].includes(state.metadata?.commandIntent?.action);

/** Reuse the Authority-pinned selector, never a conversational reconstruction. */
export const developmentRecoveryArguments = intent => {
  if (intent.selector) {
    assert(intent.argumentPrefix && intent.requestedPreset === `${intent.argumentPrefix}${intent.selector}`,
      'DEVELOPMENT_RUN_SELECTOR_MISMATCH', 'Recovery requires the original selector-bearing preset.');
    return [intent.requestedPreset];
  }
  return intent.requestedPreset ? [intent.requestedPreset] : intent.preset === 'default' ? [] : [intent.preset];
};

const featureScope = features => features.map(feature => ({ id: feature.id,
  stage: feature.metadata?.stage, logicalRoot: feature.logicalRoot,
  allowedPaths: [...feature.allowedPaths].sort(), forbiddenPaths: [...feature.forbiddenPaths].sort(),
  dependsOn: feature.dependsOn })).sort((left, right) => left.id.localeCompare(right.id));

/** Draft bytes remain unaccepted input. No completed Feature or approval transfers. */
export const assertPlanningReplacementScope = ({ retired, plan, project, before, after }) => {
  const fail = condition => assert(condition, 'DEVELOPMENT_PLANNING_RECOVERY_SCOPE_CHANGED',
    'Planning recovery must preserve the selected command, planning scope, and verified draft source.');
  const prior = retired.metadata?.commandIntent;
  const next = plan.intent;
  fail(isPlanningRecovery(retired) && project.id === retired.projectId && plan.project.id === retired.projectId
    && plan.project.descriptorDigest === project.descriptorDigest
    && plan.logicalTaskKey === retired.metadata.logicalTaskKey
    && plan.run.executionWorkspaceRoot === retired.metadata.workspace.root
    && digestJson(plan.stopCondition) === digestJson(retired.metadata.stopCondition));
  for (const key of ['action', 'target', 'preset', 'selector', 'workflowId', 'profileId']) fail(prior[key] === next[key]);
  fail(digestJson(developmentRecoveryArguments(prior)) === digestJson(developmentRecoveryArguments(next))
    && digestJson(prior.changeRequest ?? null) === digestJson(next.changeRequest ?? null));
  const candidate = plan.run.features;
  fail(candidate.length === 2 && candidate.filter(row => row.metadata?.stage === 'version-planning').length === 1
    && candidate.filter(row => row.metadata?.stage === 'plan-review').length === 1);
  const base = retired.features.filter(row => candidate.some(item => item.id === row.id));
  fail(digestJson(featureScope(candidate)) === digestJson(featureScope(base)));
  fail(before?.protocolVersion === '1.0' && after?.protocolVersion === '1.0'
    && before.root === resolve(retired.metadata.workspace.root) && after.root === before.root
    && before.digest === digestJson(before.files) && before.digest === retired.sourceDigest
    && after.digest === digestJson(after.files) && after.digest === plan.run.sourceDigest);
  const active = retired.features.filter(row => row.state === 'running');
  const paths = diffWorkspaceSnapshots(before, after);
  fail(active.length === 1 && active[0].metadata?.stage === 'version-planning'
    && paths.every(path => active[0].allowedPaths.some(root => within(root, path))
      && !active[0].forbiddenPaths.some(root => within(root, path))));
  return { fromSourceDigest: before.digest, observedSourceDigest: after.digest, changedPaths: paths,
    disposition: 'unaccepted-draft-requires-new-planning-and-review' };
};
