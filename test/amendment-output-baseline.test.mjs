import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { captureAmendmentBaselines, verifyAmendmentBaselines } from '../src/application/plan-amendment-baseline.mjs';

test('a committed source-changing handoff retains exact output baseline and budget through amendment', async () => {
  const root = process.cwd();
  const file = (path, sha256) => ({ path, sha256, size: 1 });
  const input = { root, files: [file('harness.json', 'a'), file('src/runtime', 'a')] }; input.digest = digestJson(input.files);
  const output = { root, files: [file('harness.json', 'a'), file('src/runtime', 'b')] }; output.digest = digestJson(output.files);
  const snapshot = { root, files: [file('docs/versions/scope.json', 'c'), file('harness.json', 'c'), file('src/runtime', 'b')] }; snapshot.digest = digestJson(snapshot.files);
  const result = { status: 'blocked', changedFiles: ['src/runtime'], checkpoints: [{ id: 'certificate', status: 'completed', evidence: ['proof'] }] };
  const submission = { submissionId: 'last', featureId: 'impl', dispatchId: 'dispatch', inputSourceDigest: input.digest,
    outputSourceDigest: output.digest, result, changedFiles: ['src/runtime'], evidenceRefs: ['result'] };
  submission.submissionDigest = digestJson(submission);
  const prior = { projectId: 'project', runId: 'prior', status: 'ready', sourceDigest: output.digest,
    metadata: { workspace: { root } }, features: [{ id: 'impl', state: 'failed-budget', logicalRoot: 'root:A1', metadata: { stage: 'implementation', approvedProposal: { id: 'A1' } } }],
    dispatches: [{ dispatchId: 'dispatch', status: 'committed', sourceDigest: input.digest, sourceSnapshotRef: 'input' }], submissions: [submission],
    attempts: { 'root:A1:progress': { used: 21, limit: 21, records: [{ submissionId: 'last' }] } } };
  const records = { input: { metadata: {}, bytes: Buffer.from(JSON.stringify(input)) }, result: {
    metadata: { projectId: 'project', runId: 'prior', featureId: 'impl', dispatchId: 'dispatch' },
    bytes: Buffer.from(JSON.stringify({ result, inputSourceDigest: input.digest, outputSourceDigest: output.digest })) } };
  const evidenceStore = { read: async ref => records[ref] };
  const revision = { affectedImplementationRuns: [{ runId: 'prior' }], amendmentScope: {
    artifactRoot: 'docs/amend', baselineCompatibilityPaths: ['harness.json', 'docs/versions/scope.json'] } };
  const capture = source => captureAmendmentBaselines({ states: [prior], revision, snapshot: source, evidenceStore, project: {} });
  const baselines = await capture(snapshot);
  assert.equal(baselines.length, 1); assert.equal(baselines[0].snapshotKind, 'committed-result-output');
  assert.equal(baselines[0].outputSnapshot.digest, prior.sourceDigest);
  prior.status = 'failed'; revision.implementationBaselines = baselines;
  const planRun = { projectId: 'project', runId: 'amend', metadata: { planRevision: revision } };
  const inherited = await verifyAmendmentBaselines({ planRun, typedPlan: { amendment: { documentBindings: [] } }, snapshot,
    authorityStore: { read: async () => prior }, evidenceStore });
  assert.equal(inherited.progress.A1.attempts['root:A1:progress'].used, 21);
  assert.equal(inherited.progress.A1.checkpoints[0].id, 'certificate');
  for (const mutate of [s => { s.files[2].sha256 = 'drift'; }, s => { s.files.push(file('unexpected', 'x')); }]) {
    const changed = structuredClone(snapshot); mutate(changed);
    await assert.rejects(capture(changed), { code: 'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID' });
  }
  const bad = structuredClone(baselines); bad[0].outputSnapshot.files[1].sha256 = 'tampered';
  await assert.rejects(verifyAmendmentBaselines({ planRun: { ...planRun, metadata: { planRevision: { ...revision, implementationBaselines: bad } } },
    typedPlan: { amendment: { documentBindings: [] } }, snapshot, authorityStore: { read: async () => prior }, evidenceStore }),
  { code: 'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID' });
});

test('a runtime-repaired blocked draft reuses verified implementation output instead of reconstructing it from draft files', async () => {
  const root = process.cwd(); const file = (path, hash) => ({ path, sha256: hash, size: 1 });
  const snapshot = files => ({ root, files, digest: digestJson(files) });
  const input = snapshot([file('src/runtime', 'before')]);
  const output = snapshot([file('src/runtime', 'after')]);
  const result = { status: 'blocked', changedFiles: ['src/runtime'] };
  const submission = { submissionId: 'last', featureId: 'impl', dispatchId: 'implementation',
    inputSourceDigest: input.digest, outputSourceDigest: output.digest, result,
    changedFiles: ['src/runtime'], evidenceRefs: ['output-result'] };
  submission.submissionDigest = digestJson(submission);
  const prior = { projectId: 'project', runId: 'prior', status: 'ready', sourceDigest: output.digest,
    metadata: { workspace: { root } }, features: [], attempts: { progress: { used: 21, limit: 21 } },
    dispatches: [{ dispatchId: 'implementation', status: 'committed', sourceDigest: input.digest, sourceSnapshotRef: 'input' }],
    submissions: [submission] };
  const scope = { version: 'plan-amendment/1', artifactRoot: 'docs/amend', featureIds: ['A1'], planPointers: ['/proposedFeatures/0'], documents: [] };
  const revision = { parentRunId: 'base', parentPlanDigest: 'b'.repeat(64), changeRequestDigest: 'c'.repeat(64),
    affectedImplementationRuns: [{ runId: 'prior' }], amendmentScope: scope };
  const record = (metadata, value) => ({ metadata, bytes: Buffer.from(JSON.stringify(value)) });
  const records = { input: record({}, input), 'output-result': record({ projectId: 'project', runId: 'prior', featureId: 'impl', dispatchId: 'implementation' },
    { result, inputSourceDigest: input.digest, outputSourceDigest: output.digest }) };
  const evidenceStore = { read: async ref => records[ref] };
  const baselines = await captureAmendmentBaselines({ states: [prior], revision, snapshot: output, evidenceStore, project: {} });
  const after = snapshot([file('docs/amend/audit.mjs', 'draft'), ...output.files]);
  const draftResult = { status: 'blocked', failureClass: 'scope-blocker', changedFiles: ['docs/amend/audit.mjs'] };
  const draftSubmission = { submissionId: 'draft-result', dispatchId: 'planning', featureId: 'planner', result: draftResult,
    inputSourceDigest: output.digest, outputSourceDigest: after.digest, changedFiles: draftResult.changedFiles, evidenceRefs: ['draft-result'] };
  draftSubmission.submissionDigest = digestJson(draftSubmission);
  const draft = { projectId: 'project', runId: 'draft', revision: 9, authorityDigest: 'd'.repeat(64),
    artifactDigest: '1'.repeat(64), status: 'ready', sourceDigest: after.digest, findings: [], leases: [],
    metadata: { commandIntent: { action: 'amend', selector: 'bounded' }, lifecyclePlanDigest: 'e'.repeat(64),
      planRevision: { ...revision, implementationBaselines: baselines } },
    features: [{ metadata: { stage: 'version-planning' }, state: 'blocked', blocker: { kind: 'scope' } }],
    dispatches: [{ dispatchId: 'planning', status: 'committed', submissionId: 'draft-result', sourceSnapshotRef: 'draft-input', featureSnapshot: { metadata: { stage: 'version-planning' } } }],
    submissions: [draftSubmission] };
  const meta = { projectId: 'project', runId: 'draft', dispatchId: 'planning', featureId: 'planner', sourceDigest: output.digest };
  records['draft-input'] = record(meta, output);
  records['draft-result'] = record(meta, { result: draftResult, inputSourceDigest: output.digest, outputSourceDigest: after.digest, sourceSnapshotRef: 'draft-input' });
  prior.status = 'superseded'; prior.metadata.supersededByRunId = draft.runId; prior.metadata.supersedePlanDigest = draft.metadata.lifecyclePlanDigest;
  const next = { ...revision, affectedImplementationRuns: [], replacesAmendment: { runId: draft.runId, revision: draft.revision,
    authorityDigest: draft.authorityDigest, lifecyclePlanDigest: draft.metadata.lifecyclePlanDigest, sourceDigest: after.digest, replacementArtifactDigest: '2'.repeat(64) } };
  const capture = source => captureAmendmentBaselines({ states: [prior, draft], revision: next, snapshot: source, evidenceStore,
    project: { harness: { artifactDigest: '2'.repeat(64) } } });
  const before = digestJson({ prior, draft });
  const inherited = await capture(after);
  assert.equal(inherited[0].outputSnapshot.digest, output.digest);
  assert.deepEqual(inherited[0].retirementChain, ['draft']);
  assert.deepEqual(inherited[0].preparationPaths.map(item => item.path), ['docs/amend/audit.mjs']);
  assert.equal(digestJson({ prior, draft }), before);
  const changed = structuredClone(after); changed.files[0].sha256 = 'tampered'; changed.digest = digestJson(changed.files);
  await assert.rejects(capture(changed), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED' });
  const sourceDrift = structuredClone(after); sourceDrift.files[1].sha256 = 'drift'; sourceDrift.digest = digestJson(sourceDrift.files);
  await assert.rejects(capture(sourceDrift), { code: 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED' });
});
