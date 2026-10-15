import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { developmentRecoveryArguments, assertPlanningReplacementScope } from '../src/application/development-planning-recovery.mjs';
import { assertDevelopmentReplacementScope } from '../src/application/development-replacement-scope.mjs';

const fixture = () => {
  const intent = { action: 'replan', target: 'V1', profileId: 'delivery', workflowId: 'delivery',
    preset: 'change', requestedPreset: 'change:layout', argumentPrefix: 'change:', selector: 'layout',
    changeRequest: { id: 'layout', digest: 'c'.repeat(64) } };
  const planner = { id: 'plan/V1', logicalRoot: 'plan:V1', allowedPaths: ['docs'], forbiddenPaths: ['docs/private'],
    dependsOn: [], metadata: { stage: 'version-planning' }, state: 'completed' };
  const review = { id: 'review/V1', logicalRoot: 'review:V1', allowedPaths: [], forbiddenPaths: ['docs/private'],
    dependsOn: [planner.id], metadata: { stage: 'plan-review' }, state: 'completed' };
  const beforeFiles = [{ path: 'docs/plan.json', sha256: 'a'.repeat(64), size: 10 }];
  const afterFiles = [{ path: 'docs/plan.json', sha256: 'b'.repeat(64), size: 12 }];
  const before = { protocolVersion: '1.0', root: resolve('fixture-project'), files: beforeFiles, digest: digestJson(beforeFiles) };
  const after = { ...before, files: afterFiles, digest: digestJson(afterFiles) };
  const project = { id: 'project', descriptorDigest: 'd'.repeat(64) };
  const stopCondition = { requiredFinalDecisions: ['implementation-plan-approved'] };
  const retired = { projectId: project.id, status: 'superseded', sourceDigest: before.digest,
    features: [planner, review, { ...planner, id: 'plan/V1--review-revision-6', state: 'running' }],
    metadata: { commandIntent: intent, workspace: { root: before.root }, logicalTaskKey: 'logical', stopCondition,
      supersededReason: `development-h3-recovery:${'e'.repeat(64)}` } };
  const plan = { project, intent: structuredClone(intent), logicalTaskKey: 'logical', stopCondition,
    run: { sourceDigest: after.digest, executionWorkspaceRoot: before.root,
      features: [structuredClone(planner), structuredClone(review)] } };
  return { retired, plan, project, before, after };
};

test('recovery retains the exact dynamic preset and rejects a mismatched stored selector', () => {
  assert.deepEqual(developmentRecoveryArguments(fixture().retired.metadata.commandIntent), ['change:layout']);
  assert.deepEqual(developmentRecoveryArguments({ preset: 'default' }), []);
  assert.deepEqual(developmentRecoveryArguments({ preset: 'closeout' }), ['closeout']);
  assert.throws(() => developmentRecoveryArguments({ ...fixture().plan.intent, selector: 'other' }),
    error => error.code === 'DEVELOPMENT_RUN_SELECTOR_MISMATCH');
});

test('an interrupted multi-round plan restarts planning from verified draft bytes without transferring completions', () => {
  const input = fixture();
  const original = structuredClone(input);
  const assessed = assertPlanningReplacementScope(input);
  assert.deepEqual(assessed.changedPaths, ['docs/plan.json']);
  assert.equal(assessed.disposition, 'unaccepted-draft-requires-new-planning-and-review');
  assertDevelopmentReplacementScope({ ...input, planningSource: { before: input.before, after: input.after } });
  assert.deepEqual(input, original);
  assert.throws(() => assertDevelopmentReplacementScope(input));
});

test('planning recovery rejects source tampering, path widening, a changed command and review bypass', () => {
  const changes = [
    input => { input.after.files[0].sha256 = 'f'.repeat(64); },
    input => { input.before.digest = input.after.digest; },
    input => { input.after.root = resolve('sibling'); },
    input => { input.plan.run.sourceDigest = input.before.digest; },
    input => { input.plan.intent.selector = 'other'; },
    input => { input.plan.intent.action = 'implement'; },
    input => { input.plan.intent.changeRequest.digest = 'f'.repeat(64); },
    input => { input.plan.run.features[0].allowedPaths.push('src'); },
    input => { input.plan.run.features[1].allowedPaths.push('docs'); },
    input => { input.plan.run.features[1].dependsOn = []; },
    input => { input.plan.run.features.pop(); },
    input => { input.retired.features.at(-1).metadata.stage = 'implementation'; },
    input => { input.retired.features.at(-1).state = 'completed'; },
    input => { input.plan.stopCondition = {}; },
    input => { input.plan.project = { ...input.project, descriptorDigest: 'other' }; },
    input => { input.plan.logicalTaskKey = 'other'; },
    input => { input.plan.run.executionWorkspaceRoot = resolve('sibling'); },
  ];
  for (const change of changes) {
    const input = fixture(); change(input);
    assert.throws(() => assertPlanningReplacementScope(input));
  }
  for (const path of ['src/engine.rs', 'docs/private/key.json']) {
    const input = fixture(); input.after.files.push({ path, sha256: 'f'.repeat(64), size: 1 });
    input.after.digest = digestJson(input.after.files); input.plan.run.sourceDigest = input.after.digest;
    assert.throws(() => assertPlanningReplacementScope(input));
  }
});
