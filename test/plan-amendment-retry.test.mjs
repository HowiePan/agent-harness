import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { selectAmendmentRetry, matchesAmendmentRetry } from '../src/application/plan-amendment-retry.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

const fixture = () => {
  const { revision } = amendmentFixture();
  const intent = { action: 'amend', selector: 'boundary', workflowId: 'delivery', target: 'V1.0.0' };
  const request = { target: intent.target, summary: 'Original scope', amendmentScope: revision.amendmentScope };
  const state = { runId: 'draft', revision: 10, authorityDigest: 'a'.repeat(64), sourceDigest: 'b'.repeat(64),
    status: 'ready', leases: [], dispatches: [], findings: [],
    metadata: { commandIntent: intent, lifecyclePlanDigest: 'c'.repeat(64),
      planRevision: { ...revision, changeRequestDigest: digestJson(request) } },
    features: [{ state: 'blocked', metadata: { stage: 'version-planning' }, blocker: { kind: 'scope' } }],
    submissions: [{ result: { status: 'blocked', failureClass: 'scope-blocker' } }] };
  const scope = structuredClone(revision.amendmentScope);
  scope.planPointers.push('/proposedFeatures/2/dependsOn');
  const nextRequest = { ...request, amendmentScope: scope };
  const input = { states: [state], intent, parentRunId: revision.parentRunId,
    parentPlanDigest: revision.parentPlanDigest, request: nextRequest, scope };
  return { state, input };
};

test('a registered scope correction pins the exact unaccepted idle draft', () => {
  const { state, input } = fixture();
  const replacesAmendment = selectAmendmentRetry(input);
  const plan = { intent: { ...input.intent, planRevision: { ...state.metadata.planRevision,
    amendmentScope: input.scope, changeRequestDigest: digestJson(input.request), replacesAmendment } } };
  assert.equal(matchesAmendmentRetry(state, plan), true);
  assert.equal(matchesAmendmentRetry({ ...state, revision: state.revision + 1 }, plan), false);
  assert.equal(selectAmendmentRetry({ ...input, request: { target: input.intent.target,
    summary: 'Original scope', amendmentScope: state.metadata.planRevision.amendmentScope } }), null);
});

test('scope retry rejects live work, accepted output, different bases and broader identities', () => {
  for (const mutate of [
    row => row.state.leases.push({ status: 'active' }),
    row => row.state.submissions.push({ result: { status: 'completed', outputs: { amendment: {} } } }),
    row => row.state.findings.push({ status: 'open' }),
    row => { row.input.parentPlanDigest = 'd'.repeat(64); },
    row => { row.input.scope.featureIds.push('unrelated'); },
    row => { row.input.scope.artifactRoot = 'src'; },
    row => { row.input.scope.planPointers.shift(); },
    row => { row.input.intent = { ...row.input.intent, selector: 'different' }; },
  ]) {
    const row = fixture(); mutate(row);
    assert.throws(() => selectAmendmentRetry(row.input), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
  const row = fixture();
  row.input.states.push(structuredClone(row.state));
  assert.throws(() => selectAmendmentRetry(row.input), { code: 'PLAN_AMENDMENT_RETRY_AMBIGUOUS' });
});
