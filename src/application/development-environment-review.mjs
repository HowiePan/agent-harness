import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson, sha256, withoutKeys } from '../common/canonical.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { submissionAttempt } from '../kernel/attempt-budget.mjs';

const code = 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID';
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export const environmentBlockedFeatures = state => state.features.filter(feature => feature.state === 'blocked'
  && state.submissions.findLast(item => item.featureId === feature.id)?.result?.failureClass === 'environment-blocker');

export const assertEnvironmentReviewScope = ({ state, project, review, currentSourceDigest }) => {
  const blocked = state.features.filter(feature => feature.state === 'blocked');
  assert(state.metadata?.commandIntent?.action === 'implement'
    && !['closed', 'failed', 'incomplete', 'superseded'].includes(state.status)
    && !state.leases.some(item => item.status === 'active')
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status))
    && blocked.length === 1 && blocked[0].metadata?.stage === 'implementation'
    && state.projectId === project.id && samePath(state.metadata?.workspace?.root, project.workspace.root)
    && currentSourceDigest === state.sourceDigest, code,
  'Environment review requires one idle blocked implementation and its exact registered source.');
  const feature = blocked[0];
  const submission = state.submissions.findLast(item => item.featureId === feature.id);
  assert(submission?.result?.status === 'blocked' && submission.result.failureClass === 'environment-blocker'
    && submission.result.blocker?.kind === 'environment' && submission.evidenceRefs?.length > 0
    && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
    && !submission.supersededAt, code, 'Only the exact committed environment blocker can be reviewed.');
  assert(review?.kind === 'environment-blocker-review' && review.actor === 'operator'
    && Object.keys(review).every(key => ['kind', 'actor', 'projectId', 'runId', 'featureId', 'expectedRevision',
      'submissionDigest', 'sourceDigest', 'blockerDigest', 'executables'].includes(key))
    && review.projectId === state.projectId && review.runId === state.runId && review.featureId === feature.id
    && review.expectedRevision === state.revision && review.sourceDigest === state.sourceDigest
    && review.submissionDigest === submission.submissionDigest
    && review.blockerDigest === digestJson(submission.result.blocker), code,
  'Operator review must bind the current revision, source and original blocked Submission.');
  const attempt = submissionAttempt(state, feature, submission);
  assert(attempt && !attempt.exhausted, code, 'Environment review cannot reset an exhausted budget.');
  const paths = [...new Set((submission.result.deliveryPrerequisites ?? []).flatMap(item => item.affectedPaths ?? []))];
  assert(paths.length > 0 && paths.length <= 8 && paths.every(path => typeof path === 'string' && isAbsolute(path))
    && Array.isArray(review.executables) && review.executables.length === paths.length
    && new Set(review.executables.map(path => typeof path === 'string' ? resolve(path).toLowerCase() : '')).size === paths.length
    && review.executables.every(path => typeof path === 'string' && isAbsolute(path)
      && paths.some(original => samePath(original, path))), code,
  'Version probes must cover exactly the original environment prerequisite paths.');
  return { feature, submission, paths };
};

// No shell, input-supplied arguments, ACL changes, installs or business checks.
// The exact prerequisite executable is probed only with the fixed version flag.
export const probeEnvironmentExecutable = async ({ path, workspaceRoot }) => {
  assert((await stat(path)).isFile() && samePath(await realpath(path), path), code,
    'Environment prerequisite must be the original physical executable.');
  const before = sha256(await readFile(path));
  const stdout = execFileSync(path, ['--version'], { cwd: workspaceRoot, encoding: 'utf8',
    stdio: 'pipe', windowsHide: true, timeout: 10000, maxBuffer: 65536 });
  assert(stdout.trim().length > 0 && sha256(await readFile(path)) === before, code,
    'Version probe must succeed without changing executable bytes.');
  return { path, arguments: ['--version'], executableSha256: before, exitCode: 0, stdout };
};

export const reviewDevelopmentEnvironment = async ({ state, project, review, evidenceStore,
  patchReceiptDigest, onProgress, probe = probeEnvironmentExecutable }) => {
  assert(typeof onProgress === 'function', code, 'Environment probes require a live progress observer.');
  const snapshot = await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] });
  const { feature, submission, paths } = assertEnvironmentReviewScope({ state, project, review,
    currentSourceDigest: snapshot.digest });
  // Re-read committed Evidence; a JSON result or an operator assertion alone is
  // not proof that the original failure belongs to this Run and source.
  for (const ref of submission.evidenceRefs) {
    const record = await evidenceStore.read(ref);
    const body = JSON.parse(record.bytes.toString('utf8'));
    assert(record.metadata.projectId === state.projectId && record.metadata.runId === state.runId
      && record.metadata.featureId === feature.id && record.metadata.dispatchId === submission.dispatchId
      && digestJson(body.result) === digestJson(submission.result), code,
    'Environment blocker Evidence differs from its committed Submission.');
  }
  const probes = [];
  for (const path of paths) {
    onProgress({ phase: 'started', path, arguments: ['--version'] });
    const result = await probe({ path, workspaceRoot: project.workspace.root });
    assert(samePath(result.path, path) && digestJson(result.arguments) === digestJson(['--version'])
      && result.exitCode === 0 && typeof result.stdout === 'string' && result.stdout.trim()
      && /^[a-f0-9]{64}$/.test(result.executableSha256 ?? ''), code, 'Environment probe did not pass.');
    probes.push(result);
    onProgress({ phase: 'passed', path, stdout: result.stdout });
  }
  assert((await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] })).digest === snapshot.digest,
    code, 'Project source changed during environment review.');
  const body = { kind: 'environment-blocker-resolution', version: '1.0', projectId: state.projectId,
    runId: state.runId, featureId: feature.id, submissionDigest: submission.submissionDigest,
    blockerDigest: review.blockerDigest, priorRevision: state.revision, priorAuthorityDigest: state.authorityDigest,
    sourceDigest: state.sourceDigest, patchReceiptDigest, review: structuredClone(review), probes,
    featureExecutionStarted: false, reviewedAt: new Date().toISOString() };
  const evidence = await evidenceStore.put(body, { projectId: state.projectId, runId: state.runId,
    epoch: state.epoch, generation: state.generation, featureId: feature.id, dispatchId: submission.dispatchId,
    sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
    pluginSetDigest: state.pluginSetDigest, labels: ['environment-blocker-resolution'] });
  return { evidenceRef: evidence.ref, reviewDigest: digestJson(body), featureId: feature.id,
    submissionDigest: submission.submissionDigest, sourceDigest: state.sourceDigest };
};
