import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { GateCache } from '../kernel/gate-cache.mjs';
import { createProcessGateExecutor } from '../platform/plugins/gate/process-gate.mjs';
import { DEFAULT_PROCESS_OUTPUTS } from '../platform/plugins/execution/managed-output.mjs';
import { executableAvailable, toolchainInputs } from '../platform/workflow/gates/project-gate-runner.mjs';
import { classifyFragmentedDeliveryHandoff } from '../flows/delivery-lifecycle/delivery-feedback.mjs';
import { envelope } from '../platform/plugins/contracts.mjs';

const manifest = { id: 'delivery-process-verification', kind: 'gate-executor', version: '1.0.0',
  capabilities: ['process', 'managed-outputs'], permissions: ['gate.execute'],
  execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } };

export const fingerprintDeliveryPaths = async (root, paths) => {
  const entries = [];
  const visit = async path => {
    const absolute = assertNoLinkPath(root, resolve(root, path), 'delivery verification input');
    let stat;
    try { stat = await lstat(absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push([path, null]); return;
    }
    assert(!stat.isSymbolicLink(), 'DELIVERY_VERIFICATION_LINK', 'Linked proof inputs are not reusable.');
    if (stat.isDirectory()) {
      entries.push([path, 'directory']);
      for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`);
    } else entries.push([path, sha256(await readFile(absolute))]);
  };
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return digestJson(entries);
};

const checkRecipe = check => ({ id: `delivery-check-${digestJson(check)}`, command: check.command,
  cwd: check.cwd ?? '.', timeoutMs: check.timeoutMs ?? 300000 });

/** Deterministic checks only. This runner cannot dispatch an Agent or implement code. */
export const executeDeliveryCheck = async ({ check, workspaceRoot, excluded = [], dataRoot, controlRoot,
  evidenceStore, sourceContext = {}, forceFresh = false, onProgress = () => {} }) => {
  const recipe = checkRecipe(check);
  const before = await captureWorkspace(workspaceRoot, { excluded });
  const inputDigest = await fingerprintDeliveryPaths(workspaceRoot, check.inputs);
  const outputDigest = await fingerprintDeliveryPaths(workspaceRoot, check.outputs);
  const commandRoot = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, recipe.cwd), 'delivery check cwd');
  const executable = await executableAvailable(check.command[0], commandRoot);
  const tools = [];
  let toolError = null;
  for (const path of [...new Set([executable, ...(check.toolchainFiles ?? [])])].filter(Boolean)) {
    const absolute = resolve(workspaceRoot, path);
    try { tools.push([absolute, sha256(await readFile(absolute))]); }
    catch (error) { toolError = { code: error.code ?? 'TOOLCHAIN_UNAVAILABLE', message: `Required toolchain file is unavailable: ${absolute}` }; tools.push([absolute, null]); }
  }
  const toolchainDigest = digestJson({ tools, scripts: await toolchainInputs(recipe, commandRoot) });
  const environmentDigest = digestJson({ platform: process.platform, arch: process.arch, env: process.env });
  const key = { gateId: recipe.id, specDigest: digestJson(check), sourceDigest: inputDigest,
    artifactDigest: sourceContext.artifactDigest ?? null,
    policyDigest: digestJson({ projectId: sourceContext.projectId, workspaceRoot, declared: sourceContext.policyDigest ?? null }),
    toolchainDigest, environmentDigest, pluginDigest: digestJson(manifest) };
  const cache = new GateCache({ root: dataRoot, controlRoot });
  const candidate = await cache.get(key, { forceFresh: forceFresh || !check.cacheable || Boolean(toolError) });
  let receipt = null;
  let cacheOriginRef = null;
  if (candidate.hit) {
    const origin = await evidenceStore.read(candidate.value.result.evidenceRefs[0]);
    const body = JSON.parse(origin.bytes.toString('utf8'));
    assert(body.kind === 'delivery-verification-receipt' && body.status === 'passed'
      && digestJson(body.key) === digestJson(key), 'DELIVERY_VERIFICATION_CACHE_INVALID', 'Verification reuse requires genuine matching Host evidence.');
    if (body.outputDigest === outputDigest) { receipt = body.executorReceipt; cacheOriginRef = origin.metadata.ref; }
  }
  if (toolError) receipt = envelope(manifest, 'receipt', { operation: 'gate', gateId: recipe.id,
    status: 'environment-failed', exitCode: null, stdout: '', stderr: toolError.message, environmentError: toolError });
  if (!receipt) {
    const executor = createProcessGateExecutor({ manifest, workspaceRoot, temporaryRoot: `${dataRoot}/tmp/delivery-checks`, controlRoot,
      allowlist: [{ ...recipe, executable: recipe.command[0], args: recipe.command.slice(1) }], onProgress });
    receipt = await executor.execute({ id: recipe.id, commandId: recipe.id, args: [], recipe, ...sourceContext });
  }
  const after = await captureWorkspace(workspaceRoot, { excluded });
  const stable = before.digest === after.digest && inputDigest === await fingerprintDeliveryPaths(workspaceRoot, check.inputs);
  const body = { kind: 'delivery-verification-receipt', version: '1.0', check: structuredClone(check), key,
    status: stable ? receipt.payload.status : 'failed', sourceDrift: !stable,
    inputDigest, outputDigest: await fingerprintDeliveryPaths(workspaceRoot, check.outputs),
    executorReceipt: receipt, cacheHit: Boolean(cacheOriginRef), cacheOriginRef,
    sourceBefore: before.digest, sourceAfter: after.digest };
  const evidence = await evidenceStore.put(body, { ...sourceContext, sourceDigest: before.digest,
    mediaType: 'application/json', labels: ['delivery-verification'] });
  if (body.status === 'passed' && !body.cacheHit && check.cacheable) await cache.put(key, { status: 'passed', evidenceRefs: [evidence.ref] });
  return { ...body, evidenceRef: evidence.ref };
};

export const verifyDeliveryBatchResult = async ({ state, feature, dispatch, result, workspaceRoot,
  project, evidenceStore, dataRoot, controlRoot, onProgress = () => {} }) => {
  const batch = feature.metadata?.deliveryBatch;
  if (!batch) return { result, receipts: [] };
  if (result.status !== 'completed') {
    const classified = classifyFragmentedDeliveryHandoff(state, feature, result);
    return { result: classified, receipts: [], ...(classified !== result ? { nativeResult: result } : {}) };
  }
  assert(digestJson([...(result.outputs?.implement?.value?.changedFiles ?? [])].sort()) === digestJson([...result.changedFiles].sort()),
    'DELIVERY_BATCH_OUTPUT_SOURCE_MISMATCH', 'Typed delivery output must report the same actual source delta as the managed result.');
  const context = dispatch.execution.implementationContinuation;
  const claims = new Map((result.checkpoints ?? []).map(item => [item.id, item]));
  assert(batch.obligationIds.every(id => claims.get(id)?.status === 'completed' && claims.get(id).evidence?.length),
    'DELIVERY_BATCH_ACCEPTANCE_INCOMPLETE', 'A completed batch requires evidence checkpoints for every assigned obligation.');
  const checks = [...batch.checks];
  if (batch.phase === 'convergence') {
    const owner = feature.metadata.deliveryOwnerProposal;
    const scopeIds = new Set(context.originalObligationIds);
    // Revalidate upstream proof at the current source. Unchanged, attested
    // inputs can reuse Host receipts; an actual repair invalidates dependents.
    const producers = state.features.filter(item => item.logicalRoot === feature.logicalRoot
      && item.metadata?.deliveryBatch && item.id !== feature.id && item.state === 'completed');
    for (const producer of producers) checks.unshift(...producer.metadata.deliveryBatch.checks);
    const covered = new Set(checks.flatMap(check => check.covers));
    assert([...scopeIds].every(id => covered.has(id)), 'DELIVERY_BATCH_CONVERGENCE_COVERAGE',
      `Original proposal ${owner.id} still has obligations without current verification.`);
    assert([...scopeIds].every(id => covered.has(id)), 'DELIVERY_BATCH_CONVERGENCE_COVERAGE', 'Original acceptance cannot be replaced by child completion.');
  }
  const receipts = [];
  for (const check of [...new Map(checks.map(item => [digestJson(item), item])).values()]) {
    const outputs = [...feature.allowedPaths, ...(feature.metadata.verificationOutputPaths ?? []), ...(project.policy?.qualityVerificationOutputs ?? [])];
    assert(check.outputs.every(path => outputs.some(root => path === root || path.startsWith(`${root}/`))),
      'DELIVERY_CHECK_OUTPUT_SCOPE', 'Verification outputs require the current Feature or declared transient-output authority.');
    const receipt = await executeDeliveryCheck({ check, workspaceRoot, excluded: project.workspace.excluded,
      evidenceStore, dataRoot, controlRoot, forceFresh: batch.checks.includes(check) && batch.phase === 'convergence',
      onProgress: event => onProgress?.({ ...event, deliveryBatchId: batch.id, checkId: check.id }),
      sourceContext: { projectId: state.projectId, runId: state.runId, featureId: feature.id, dispatchId: dispatch.dispatchId,
        epoch: state.epoch, generation: state.generation, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest } });
    receipts.push(receipt);
    if (receipt.status !== 'passed') {
      const external = receipt.status === 'environment-failed' || receipt.status === 'budget-exceeded';
      const failedIds = new Set(receipt.check.covers);
      return { receipts, nativeResult: result, result: { ...result, status: 'blocked', outputs: {},
        summary: `Delivery ${batch.id} verification failed: ${check.id}. ${result.summary}`,
        failureClass: external ? 'environment' : 'implementation-incomplete',
        blocker: { kind: external ? 'environment' : 'implementation', summary: `Host check ${check.id}: ${receipt.status}. ${(receipt.executorReceipt.payload.stderr ?? '').slice(-1500)}`,
          resumeWhen: `Repair the observed check failure and complete batch ${batch.id}; proof: ${receipt.evidenceRef}` },
        checkpoints: (result.checkpoints ?? []).filter(item => !failedIds.has(item.id)),
        observations: [...(result.observations ?? []), `Host verification evidence: ${receipt.evidenceRef}`] } };
    }
  }
  return { result, receipts };
};
