import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson, withoutKeys } from '../src/common/canonical.mjs';
import { rejectedAmendmentDraftEvidence, diagnosedAmendmentScopeEvidence, selectAmendmentRetry, matchesAmendmentRetry } from '../src/application/plan-amendment-retry.mjs';
import { verifyBlockedDraftArtifacts } from '../src/application/plan-amendment-draft-artifacts.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';
import { validateFinding } from '../src/kernel/quality.mjs';
import { featureContractDigest } from '../src/common/interruption-contract.mjs';
import { carryAmendmentReviewFindings } from '../src/application/plan-amendment-finding-carryover.mjs';
import { planReviewResolutionCandidates, verifyPlanReviewResolutionEvidence } from '../src/application/plan-review-reconciliation.mjs';

const fixture = () => {
  const { revision } = amendmentFixture();
  const intent = { action: 'amend', selector: 'bounded', workflowId: 'delivery', target: 'V1' };
  const request = { target: 'V1', amendmentScope: revision.amendmentScope };
  revision.changeRequestDigest = digestJson(request);
  const file = (path, hash) => ({ path, sha256: hash, size: 1 });
  const snapshot = files => ({ root: process.cwd(), files, digest: digestJson(files) });
  const input = snapshot([file('src/runtime', 'base')]);
  const candidate = snapshot([file('docs/amend/candidate.json', 'candidate'), ...input.files]);
  const final = snapshot([candidate.files[0], file('docs/amend/fix.json', 'fix'), ...input.files]);
  const blocker = { kind: 'protected', code: 'PLAN_AMENDMENT_TOO_LARGE', summary: 'Size bound' };
  const features = [{ id: 'planner', metadata: { stage: 'version-planning' }, state: 'completed' },
    { id: 'review', metadata: { stage: 'plan-review' }, state: 'completed' },
    { id: 'repair', metadata: { stage: 'version-planning' }, state: 'blocked', blocker }];
  const results = [
    { status: 'completed', changedFiles: ['docs/amend/candidate.json'], outputs: { amendment: { value: {
      version: 'plan-amendment/1', basePlanDigest: revision.parentPlanDigest,
      changeRequestDigest: revision.changeRequestDigest, deltaRef: { path: 'docs/amend/candidate.json', sha256: 'a'.repeat(64) } } } } },
    { status: 'completed', changedFiles: [], findings: ['mapping', 'inputs'].map(id => ({
      id, severity: 'P1', summary: `Correct ${id}`, affectedPaths: ['docs/amend/candidate.json'], evidence: ['source declaration'] })), outputs: { 'plan-review': { value: {
      approved: false, findings: ['mapping', 'inputs'], basePlanDigest: revision.parentPlanDigest,
      deltaDigest: 'd'.repeat(64), reviewedFeatureIds: revision.amendmentScope.featureIds } } } },
    { status: 'blocked', failureClass: 'protected-plan-blocker', blocker, changedFiles: ['docs/amend/fix.json'] },
  ];
  const submissions = results.map((result, index) => {
    const value = { submissionId: `s${index}`, featureId: features[index].id, dispatchId: `d${index}`,
      result, changedFiles: result.changedFiles, inputSourceDigest: index ? candidate.digest : input.digest,
      outputSourceDigest: index === 2 ? final.digest : candidate.digest, evidenceRefs: [`e${index}`] };
    return { ...value, submissionDigest: digestJson(value) };
  });
  const dispatches = submissions.map((row, index) => ({ dispatchId: row.dispatchId, featureId: row.featureId,
    status: 'committed', submissionId: row.submissionId, sourceSnapshotRef: `input${index}`,
    featureSnapshot: features[index] }));
  const state = { projectId: 'project', runId: 'draft', status: 'ready', revision: 29,
    authorityDigest: 'e'.repeat(64), sourceDigest: final.digest, artifactDigest: '1'.repeat(64),
    metadata: { commandIntent: intent, lifecyclePlanDigest: 'f'.repeat(64), planRevision: revision },
    decisions: [], findings: results[1].findings.map(finding => validateFinding({ ...finding,
      source: 'review', status: 'open', featureId: 'review', evidenceRefs: ['e1'], openedAt: 'original' })),
    leases: [], features, submissions, dispatches,
    attempts: { progress: { used: 21, limit: 21, exhausted: true, records: ['retained'] } } };
  const records = {};
  submissions.forEach((row, index) => {
    const metadata = { projectId: state.projectId, runId: state.runId, featureId: row.featureId,
      dispatchId: row.dispatchId, sourceDigest: row.inputSourceDigest };
    const source = index ? candidate : input;
    records[`input${index}`] = { metadata, bytes: Buffer.from(JSON.stringify(source)) };
    records[`e${index}`] = { metadata, bytes: Buffer.from(JSON.stringify({ result: row.result,
      sourceSnapshotRef: `input${index}`, inputSourceDigest: row.inputSourceDigest, outputSourceDigest: row.outputSourceDigest })) };
  });
  const args = { states: [state], intent, parentRunId: revision.parentRunId, parentPlanDigest: revision.parentPlanDigest,
    request, scope: revision.amendmentScope, artifactDigest: '2'.repeat(64) };
  return { state, args, records, final };
};

const reconciliationFixture = () => {
  const data = fixture(), { state } = data;
  const repair = state.features[2], blocked = state.submissions[2];
  repair.metadata.planReviewRound = 2;
  repair.allowedPaths = [state.metadata.planRevision.amendmentScope.artifactRoot];
  repair.logicalRoot = 'planner'; repair.forbiddenPaths = []; repair.acceptance = ['Reconcile consumers.'];
  repair.blocker = { kind: 'scope', code: 'ALLOCATION_UNPROVEN', summary: 'Consumer allocation needs reconciliation.' };
  blocked.result.blocker = repair.blocker; blocked.result.failureClass = 'scope-blocker';
  blocked.submissionDigest = digestJson(withoutKeys(blocked, ['submissionDigest']));
  state.profile = { config: { planReviewLimit: 6 } };
  const diagnostic = { submissionId: 'diagnosed', featureId: 'diagnostic', dispatchId: 'diagnostic-dispatch',
    inputSourceDigest: state.sourceDigest, outputSourceDigest: state.sourceDigest, changedFiles: [], evidenceRefs: ['diagnostic-evidence'],
    result: { status: 'completed', outputs: { diagnosis: { value: { conclusion: 'unresolved',
      sourceSubmissionId: blocked.submissionId, contractDigest: featureContractDigest(repair) } } } } };
  diagnostic.submissionDigest = digestJson(diagnostic);
  state.features.push({ id: 'diagnostic', kind: 'execution-diagnostic', state: 'completed', submissionId: diagnostic.submissionId,
    allowedPaths: [], metadata: { intervention: { sourceFeatureId: repair.id, sourceSubmissionId: blocked.submissionId,
      sourceDigest: state.sourceDigest, contractDigest: featureContractDigest(repair) } } });
  state.metadata.interruptionLedger = [{ id: 'diagnostic', sourceSubmissionId: blocked.submissionId }];
  state.submissions.push(diagnostic);
  state.dispatches.push({ dispatchId: diagnostic.dispatchId, status: 'committed', submissionId: diagnostic.submissionId });
  return data;
};

const scopeCorrectionFixture = () => {
  const { state: original, args: priorArgs, records, final } = reconciliationFixture();
  const ref = selectAmendmentRetry(priorArgs), state = structuredClone(original);
  state.runId = 'scope-draft'; state.revision = 37; state.artifactDigest = priorArgs.artifactDigest;
  const revision = state.metadata.planRevision;
  revision.replacesAmendment = ref;
  revision.parentPlan.proposedFeatures[0].projectId = state.projectId;
  revision.parentPlan.proposedFeatures[0].deliveryBatches = [{ id: 'original', sizing: { capacityUnits: 36 } }];
  revision.amendmentScope.batchPolicy = { policy: 'bounded-delivery/2', maxBatchesPerFeature: 20 };
  revision.amendmentScope.documents = [{ id: 'expanded', source: { path: 'base.json', sha256: 'a'.repeat(64) },
    outputPath: 'docs/amend/expanded.json', allowedPointers: [...revision.amendmentScope.planPointers] }];
  state.features = state.features.slice(2);
  state.submissions = state.submissions.slice(2);
  state.dispatches = state.dispatches.slice(2);
  state.findings = ref.preservedDraft.openFindings.map(finding => validateFinding({
    ...finding, source: 'authority-snapshot', openedAt: 'carried' }));
  const diagnostic = state.submissions.at(-1);
  Object.assign(diagnostic.result.outputs.diagnosis.value, { conclusion: 'contract-change', repairPaths: [] });
  diagnostic.submissionDigest = digestJson(withoutKeys(diagnostic, ['submissionDigest']));
  const request = { target: priorArgs.intent.target, amendmentScope: structuredClone(revision.amendmentScope) };
  revision.changeRequestDigest = digestJson(request);
  const scope = structuredClone(revision.amendmentScope);
  scope.featureIds.push('A0'); scope.planPointers.push('/proposedFeatures/0/deliveryBatches');
  scope.documents[0].allowedPointers.push('/proposedFeatures/0/deliveryBatches');
  const args = { ...priorArgs, states: [state], request: { ...request, amendmentScope: scope }, scope, artifactDigest: '3'.repeat(64) };
  for (const row of state.submissions) {
    const dispatch = state.dispatches.find(item => item.dispatchId === row.dispatchId);
    records[row.evidenceRefs[0]] = { metadata: { projectId: state.projectId, runId: state.runId,
      featureId: row.featureId, dispatchId: row.dispatchId, sourceDigest: row.inputSourceDigest }, bytes: Buffer.from(JSON.stringify({
      result: row.result, sourceSnapshotRef: dispatch.sourceSnapshotRef,
      inputSourceDigest: row.inputSourceDigest, outputSourceDigest: row.outputSourceDigest })) };
    if (dispatch.sourceSnapshotRef) records[dispatch.sourceSnapshotRef].metadata.runId = state.runId;
  }
  return { original, state, args, records, final };
};

test('a diagnosed registered batch correction retains rejected ancestry and review allowance across another Run', () => {
  const { state, args } = scopeCorrectionFixture();
  const before = digestJson(state), ref = selectAmendmentRetry(args);
  assert.equal(ref.preservedDraft.rejectedReview.originRunId, 'draft');
  assert.equal(ref.preservedDraft.reviewRoundsUsed, 1);
  assert.deepEqual(ref.preservedDraft.openFindings, state.metadata.planRevision.replacesAmendment.preservedDraft.openFindings);
  assert.equal(ref.preservedDraft.scopeCorrection.sourceDigest, state.sourceDigest);
  assert.equal(ref.preservedDraft.correctedDraft.submissionId, state.submissions[0].submissionId);
  const plan = { harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...state.metadata.planRevision, amendmentScope: args.scope,
      changeRequestDigest: digestJson(args.request), replacesAmendment: ref } } };
  assert(matchesAmendmentRetry(state, plan));
  assert(matchesAmendmentRetry({ ...state, status: 'superseded' }, plan));
  assert.equal(digestJson(state), before);
  assert.equal(state.attempts.progress.used, 21);
  assert.throws(() => selectAmendmentRetry({ ...args, request: { target: args.intent.target,
    amendmentScope: state.metadata.planRevision.amendmentScope }, scope: state.metadata.planRevision.amendmentScope }),
  { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('diagnosed batch corrections reject unbound claims, scope drift, completed work and allowance resets', () => {
  for (const mutate of [
    row => row.state.leases.push({ status: 'active' }),
    row => row.state.findings.push({ id: 'unrelated', status: 'open' }),
    row => { row.state.findings[0].summary = 'different'; },
    row => { row.state.sourceDigest = 'drift'; },
    row => { row.state.submissions.at(-1).result.outputs.diagnosis.value.conclusion = 'unresolved'; },
    row => { row.state.submissions.at(-1).result.outputs.diagnosis.value.repairPaths = ['scope.json']; },
    row => { row.state.submissions.at(-1).result.outputs.diagnosis.value.sourceSubmissionId = 'different'; },
    row => { row.state.submissions.at(-1).changedFiles = ['src/unauthorized']; },
    row => { row.state.submissions.at(-1).outputSourceDigest = 'drift'; },
    row => { row.state.dispatches.at(-1).status = 'requested'; },
    row => { row.state.metadata.interruptionLedger = []; },
    row => row.state.submissions.push({ result: { status: 'completed' } }),
    row => row.state.decisions.push({ id: 'implementation-plan-approved', decision: 'approved' }),
    row => { row.state.metadata.planRevision.replacesAmendment.preservedDraft.reviewRoundsUsed = 6; },
    row => { row.args.scope.batchPolicy.maxBatchesPerFeature = 21; },
    row => { row.args.scope.featureSplits = [{ featureId: 'A0', prefix: 'A0-', maxNewFeatures: 2 }]; },
    row => row.args.scope.planPointers.push('/proposedFeatures/0/allowedPaths'),
    row => { row.args.scope.documents[0].allowedPointers.pop(); },
    row => { row.args.scope.featureIds.reverse(); },
    row => { row.state.metadata.planRevision.parentPlan.proposedFeatures[0].projectId = 'other'; },
    row => { row.state.metadata.planRevision.implementationBaselines = [{ completed: [{ proposalId: 'A0' }] }]; },
  ]) {
    const row = scopeCorrectionFixture(); mutate(row);
    assert.throws(() => selectAmendmentRetry(row.args), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
});

test('multi-generation batch correction verifies diagnostic bytes and the original review Authority', async () => {
  const { original, state: prior, args, records, final } = scopeCorrectionFixture();
  assert(diagnosedAmendmentScopeEvidence(prior));
  const evidenceStore = { read: async ref => records[ref] };
  const verify = () => verifyBlockedDraftArtifacts({ drafts: [prior], snapshot: final, artifactRoot: 'docs/amend', evidenceStore });
  assert.deepEqual([...await verify()], ['docs/amend/fix.json']);
  const diagnosticEvidence = prior.submissions.at(-1).evidenceRefs[0], saved = records[diagnosticEvidence];
  records[diagnosticEvidence] = { ...saved, bytes: Buffer.from('{}') };
  await assert.rejects(verify(), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID' });
  records[diagnosticEvidence] = saved;
  const ref = selectAmendmentRetry(args);
  delete ref.replacementArtifactDigest; // Registered correction also works without a second Runtime change.
  const plan = { planDigest: 'fresh-plan', harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...prior.metadata.planRevision, amendmentScope: args.scope,
      changeRequestDigest: digestJson(args.request), replacesAmendment: ref } } };
  const state = { projectId: prior.projectId, runId: 'fresh', revision: 1, findings: [], submissions: [],
    features: [], artifactDigest: args.artifactDigest, metadata: { lifecyclePlanDigest: plan.planDigest,
      commandIntent: plan.intent, planRevision: plan.intent.planRevision } };
  const input = { state, plan, evidenceStore, commandId: 'fresh',
    authorityStore: { read: async (_project, id) => id === prior.runId ? prior : original },
    kernel: { recordFinding: async (_project, _run, finding) => {
      state.findings.push(validateFinding({ ...finding, status: 'open', openedAt: 'new' }));
      state.revision++; return { state };
    } } };
  await carryAmendmentReviewFindings(input);
  assert.equal(state.findings.length, 2);
  const result = { status: 'completed', changedFiles: [], findings: [], outputs: { 'plan-review': { value: {
    approved: true, findings: [], resolvedFindings: ['mapping', 'inputs'] } } },
  checkpoints: ['mapping', 'inputs'].map(id => ({ id, status: 'resolved', summary: 'Verified new correction', evidence: ['exact-contract'] })) };
  state.features.push({ id: 'fresh-review', state: 'completed', allowedPaths: [], dependsOn: [],
    metadata: { stage: 'plan-review', sourcePolicy: 'read-only' } });
  const submission = { submissionId: 'fresh-review-result', featureId: 'fresh-review', dispatchId: 'fresh-dispatch',
    result, inputSourceDigest: 'new', outputSourceDigest: 'new', evidenceRefs: ['fresh-evidence'] };
  submission.submissionDigest = digestJson(submission); state.submissions.push(submission);
  records['fresh-evidence'] = { metadata: { projectId: state.projectId, runId: state.runId,
    featureId: submission.featureId, dispatchId: submission.dispatchId }, bytes: Buffer.from(JSON.stringify({
    result, inputSourceDigest: 'new', outputSourceDigest: 'new' })) };
  const candidates = planReviewResolutionCandidates(state);
  assert.equal(candidates.length, 2);
  assert(candidates.every(item => item.carriedOrigin.runId === original.runId));
  await verifyPlanReviewResolutionEvidence(state, candidates, evidenceStore);
  original.submissions = [];
  await assert.rejects(carryAmendmentReviewFindings({ ...input, state: { ...state, findings: [], submissions: [] } }),
    { code: 'PLAN_AMENDMENT_FINDING_CARRYOVER_INVALID' });
});

test('a repaired runtime can restart source-bound planning reconciliation without scope or review-budget expansion', () => {
  const { state, args } = reconciliationFixture();
  const saved = digestJson(state);
  const ref = selectAmendmentRetry(args);
  assert.equal(ref.preservedDraft.reviewRoundsUsed, 1);
  assert.deepEqual(ref.preservedDraft.openFindings, state.findings);
  assert.equal(digestJson(state), saved);
  for (const mutate of [
    s => { s.submissions.at(-1).result.outputs.diagnosis.value.conclusion = 'contract-change'; },
    s => { s.submissions.at(-1).outputSourceDigest = 'different'; },
    s => { s.submissions.at(-1).changedFiles = ['docs/amend/unclaimed']; },
    s => { s.features[2].allowedPaths = ['src']; },
    s => { s.profile.config.planReviewLimit = 1; },
    s => { s.metadata.interruptionLedger = []; },
    s => { s.features.at(-1).metadata.intervention.contractDigest = 'different'; },
    s => { s.features.at(-1).metadata.intervention.sourceDigest = 'different'; },
    s => { s.submissions.at(-1).result.outputs.diagnosis.value.sourceSubmissionId = 'different'; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.throws(() => selectAmendmentRetry({ ...args, states: [changed] }), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
  const changedScope = structuredClone(args.scope); changedScope.planPointers.push('/proposedFeatures/0/dependsOn');
  assert.throws(() => selectAmendmentRetry({ ...args, scope: changedScope }), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('retry accepts reviewed registered new children but rejects unrelated or excess identities', () => {
  const { state, args } = reconciliationFixture();
  const revision = state.metadata.planRevision;
  const parent = revision.amendmentScope.featureIds[0];
  revision.amendmentScope.featureSplits = [{ featureId: parent, prefix: `${parent}-`, maxNewFeatures: 1 }];
  revision.changeRequestDigest = digestJson(args.request);
  const planner = state.submissions[0], review = state.submissions[1];
  planner.result.outputs.amendment.value.changeRequestDigest = revision.changeRequestDigest;
  planner.submissionDigest = digestJson(withoutKeys(planner, ['submissionDigest']));
  const originalIds = [...review.result.outputs['plan-review'].value.reviewedFeatureIds];
  const ids = [...originalIds, `${parent}-new`];
  const check = candidateIds => {
    review.result.outputs['plan-review'].value.reviewedFeatureIds = candidateIds;
    review.submissionDigest = digestJson(withoutKeys(review, ['submissionDigest']));
    return selectAmendmentRetry(args);
  };
  assert(check(ids));
  for (const candidateIds of [[...ids, `${parent}-extra`], [...originalIds, 'unrelated'],
    ids.slice(1), [...ids, ids.at(-1)]]) {
    assert.throws(() => check(candidateIds), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
  revision.parentPlan.proposedFeatures.push({ id: `${parent}-new` });
  assert.throws(() => check(ids), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('runtime repair retries only the exact rejected amendment and retains feedback and counters', () => {
  const { state, args } = fixture();
  const before = digestJson(state);
  assert(rejectedAmendmentDraftEvidence(state));
  const ref = selectAmendmentRetry(args);
  assert.deepEqual(ref.preservedDraft.rejectedReview.value.findings, ['mapping', 'inputs']);
  assert.deepEqual(ref.preservedDraft.openFindings, state.findings);
  assert.deepEqual(ref.preservedDraft.correctedDraft.changedFiles, ['docs/amend/fix.json']);
  assert.equal(ref.preservedDraft.acceptance, 'unaccepted-requires-planning-and-review');
  const plan = { harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...state.metadata.planRevision, replacesAmendment: ref } } };
  assert(matchesAmendmentRetry(state, plan));
  assert.equal(selectAmendmentRetry({ ...args, artifactDigest: state.artifactDigest }), null);
  assert.equal(digestJson(state), before);
  for (const mutate of [
    row => row.leases.push({ status: 'active' }),
    row => row.findings.push({ status: 'open' }),
    row => { row.findings[0].summary = 'unverified change'; },
    row => { row.findings[0].evidenceRefs = ['different']; },
    row => row.decisions.push({ id: 'implementation-plan-approved', decision: 'approved' }),
    row => { row.submissions[1].result.outputs['plan-review'].value.approved = true; },
    row => { row.submissions[2].result.blocker.code = 'DIFFERENT'; },
    row => { row.sourceDigest = 'a'.repeat(64); },
    row => { row.dispatches[1].status = 'requested'; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.throws(() => selectAmendmentRetry({ ...args, states: [changed] }), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
  assert.throws(() => selectAmendmentRetry({ ...args, request: { ...args.request, summary: 'changed' } }),
    { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('carried planning Findings remain open until a fresh review resolves each exact ID with sealed evidence', async () => {
  const { state: prior, args, records } = fixture();
  const ref = selectAmendmentRetry(args);
  const plan = { planDigest: 'plan', harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...prior.metadata.planRevision, replacesAmendment: ref } } };
  const state = { projectId: prior.projectId, runId: 'replacement', revision: 1, findings: [], submissions: [],
    artifactDigest: args.artifactDigest, metadata: { lifecyclePlanDigest: plan.planDigest,
      commandIntent: plan.intent, planRevision: plan.intent.planRevision }, features: [] };
  let recorded = 0;
  const input = { state, plan, authorityStore: { read: async () => prior },
    evidenceStore: { read: async ref => records[ref] }, commandId: 'retry', kernel: {
      recordFinding: async (projectId, runId, finding, command) => {
        assert.equal(command.expectedRevision, state.revision);
        state.findings.push(validateFinding({ ...finding, status: 'open', openedAt: 'new' }));
        state.revision += 1; recorded += 1; return { state };
      } } };
  await carryAmendmentReviewFindings(input);
  await carryAmendmentReviewFindings(input);
  assert.equal(recorded, 2);
  assert(state.findings.every(row => row.status === 'open'));
  assert(prior.findings.every(row => row.status === 'open'));
  const result = { status: 'completed', changedFiles: [], findings: [], checkpoints: [],
    outputs: { 'plan-review': { value: { approved: true, findings: [] } } } };
  const review = { submissionId: 'fresh', featureId: 'fresh-review', dispatchId: 'fresh-dispatch',
    result, evidenceRefs: ['fresh-evidence'], inputSourceDigest: 'new-source', outputSourceDigest: 'new-source' };
  state.features.push({ id: review.featureId, state: 'completed', allowedPaths: [],
    metadata: { stage: 'plan-review', sourcePolicy: 'read-only' }, dependsOn: [] });
  state.submissions.push(review);
  assert.deepEqual(planReviewResolutionCandidates(state), []);
  result.outputs['plan-review'].value.resolvedFindings = ['mapping', 'inputs'];
  result.checkpoints.push({ id: 'mapping', status: 'resolved', summary: 'Exact contract mapping verified', evidence: ['contract'] });
  assert.deepEqual(planReviewResolutionCandidates(state).map(row => row.id), ['mapping']);
  result.checkpoints.push({ id: 'inputs', status: 'resolved', summary: 'Complete inputs verified', evidence: ['checks'] });
  review.submissionDigest = digestJson(review);
  records['fresh-evidence'] = { metadata: { projectId: state.projectId, runId: state.runId,
    featureId: review.featureId, dispatchId: review.dispatchId }, bytes: Buffer.from(JSON.stringify({ result,
      inputSourceDigest: review.inputSourceDigest, outputSourceDigest: review.outputSourceDigest })) };
  const candidates = planReviewResolutionCandidates(state);
  assert.equal(candidates.length, 2);
  await verifyPlanReviewResolutionEvidence(state, candidates, input.evidenceStore);
  records.e1.bytes = Buffer.from('{}');
  await assert.rejects(verifyPlanReviewResolutionEvidence(state, candidates, input.evidenceStore),
    { code: 'PLAN_REVIEW_EVIDENCE_MISMATCH' });
});

test('rejected candidate and correction bytes need original committed evidence; no artifact wildcard', async () => {
  const { state, records, final } = fixture();
  const evidenceStore = { read: async ref => records[ref] };
  const verify = (draft = state, snapshot = final) => verifyBlockedDraftArtifacts({ drafts: [draft], snapshot,
    artifactRoot: 'docs/amend', evidenceStore });
  assert.deepEqual([...await verify()].sort(), ['docs/amend/candidate.json', 'docs/amend/fix.json']);
  const changed = structuredClone(final); changed.files[1].sha256 = 'tampered'; changed.digest = digestJson(changed.files);
  await assert.rejects(verify(state, changed), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED' });
  const extra = structuredClone(final); extra.files.push({ path: 'docs/amend/unclaimed', sha256: 'x', size: 1 });
  assert.equal((await verify(state, extra)).has('docs/amend/unclaimed'), false);
  records.e1.bytes = Buffer.from('{}');
  await assert.rejects(verify(), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID' });
  assert.equal(state.attempts.progress.used, 21);
  assert.equal(state.submissions[2].submissionDigest,
    digestJson(withoutKeys(state.submissions[2], ['submissionDigest'])));
});
