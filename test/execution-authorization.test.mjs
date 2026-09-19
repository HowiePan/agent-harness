import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { compileAgentPrompt } from '../src/platform/plugins/codec/agent-prompt-codec.mjs';
import { createCodexCliRuntime } from '../integrations/codex/runtime/codex-cli-runtime.mjs';
import {
  createExecutionAuthorizationAdapter,
  sealLifecycleExecutionGrant,
  verifyHeadlessExecutionGrant,
} from '../src/platform/execution/authorization.mjs';
import { createHarness } from '../src/application/harness.mjs';
import { makeFixture } from './test-support.mjs';

const execFile = promisify(execFileCallback);

const digest = character => character.repeat(64);
const context = (overrides = {}) => ({
  projectId: 'project',
  projectRevision: 1,
  projectDescriptorDigest: digest('a'),
  intentDigest: digest('b'),
  action: 'quality',
  target: 'V3.8.4',
  scope: null,
  runId: 'quality-run',
  runtimePluginId: 'codex-cli-runtime',
  runtimeVersion: '1.0.0',
  agentExecutionMode: 'headless',
  executionWorkspaceRoot: 'F:\\workspace',
  sourceDigest: digest('d'),
  harnessArtifactDigest: digest('e'),
  extensionDigest: digest('f'),
  constraintDigest: digest('c'),
  ...overrides,
});

const grant = (grantContext = context(), overrides = {}) => sealLifecycleExecutionGrant({
  protocolVersion: '1.0',
  kind: 'lifecycle-execution-grant',
  grantId: 'grant-1',
  actor: 'user',
  decision: 'approved',
  interactionMode: 'unattended',
  context: grantContext,
  issuedAt: '2026-09-15T00:00:00.000Z',
  expiresAt: '2099-09-15T00:00:00.000Z',
  attestation: { provider: 'trusted-host', reference: 'user-message:1' },
  ...overrides,
});

const adapter = ({ constraints = { processBackedAgent: 'allow-explicit', unattended: 'allow-explicit', decisionLineage: 'test-explicit-policy' }, verified = true } = {}) => createExecutionAuthorizationAdapter({
  provider: 'trusted-host',
  constraints,
  verifyExecutionGrant: () => ({ verified, provider: 'trusted-host', assertionId: 'assertion-1', observedAt: '2026-09-15T00:00:01.000Z' }),
});

const processManifest = { id: 'codex-cli-runtime', version: '1.0.0', permissions: ['process.spawn'] };

test('headless grants reject absence, expiry, forged verification, and cross-Run replay', async () => {
  const trusted = adapter();
  const trustedContext = overrides => context({ constraintDigest: trusted.constraints.constraintDigest, ...overrides });
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: trusted, grant: null, context: trustedContext(), manifest: processManifest }),
    error => error.code === 'LIFECYCLE_EXECUTION_GRANT_REQUIRED',
  );
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: trusted, grant: grant(trustedContext(), { expiresAt: '2026-09-15T00:00:00.500Z' }), context: trustedContext(), manifest: processManifest, now: () => '2026-09-15T00:00:01.000Z' }),
    error => error.code === 'LIFECYCLE_EXECUTION_GRANT_EXPIRED',
  );
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: adapter({ verified: false }), grant: grant(trustedContext()), context: trustedContext(), manifest: processManifest }),
    error => error.code === 'LIFECYCLE_EXECUTION_GRANT_INVALID',
  );
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: trusted, grant: grant(trustedContext()), context: trustedContext({ runId: 'other-run' }), manifest: processManifest }),
    error => error.code === 'LIFECYCLE_EXECUTION_GRANT_SCOPE_MISMATCH',
  );
  for (const changed of [
    { action: 'full' },
    { target: 'V3.8.5' },
    { runtimePluginId: 'other-runtime' },
    { runtimeVersion: '1.0.1' },
    { executionWorkspaceRoot: 'F:\\other-workspace' },
    { sourceDigest: digest('9') },
    { harnessArtifactDigest: digest('8') },
    { extensionDigest: digest('7') },
  ]) {
    await assert.rejects(
      () => verifyHeadlessExecutionGrant({ adapter: trusted, grant: grant(trustedContext()), context: trustedContext(changed), manifest: processManifest }),
      error => error.code === 'LIFECYCLE_EXECUTION_GRANT_SCOPE_MISMATCH',
    );
  }
});

test('trusted deny constraints override a well-formed Descriptor-compatible grant', async () => {
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: adapter({ constraints: { processBackedAgent: 'deny', unattended: 'allow-explicit', decisionLineage: 'test-deny-process' } }), grant: grant(), context: context(), manifest: processManifest }),
    error => error.code === 'PROCESS_BACKED_AGENT_USER_DENIED',
  );
  await assert.rejects(
    () => verifyHeadlessExecutionGrant({ adapter: adapter({ constraints: { processBackedAgent: 'allow-explicit', unattended: 'deny', decisionLineage: 'test-deny-unattended' } }), grant: grant(), context: context(), manifest: processManifest }),
    error => error.code === 'HEADLESS_USER_INTENT_REQUIRED',
  );
});

test('Harness refuses untrusted authorization callbacks', async () => {
  await assert.rejects(
    () => createHarness({ dataRoot: `${process.cwd()}\\.agent-harness-data-untrusted-test`, releaseIdentity: { version: '1.0.0', artifactDigest: null }, strictProjectIdentity: false, initializeStorage: false, executionAuthorizationAdapter: { verifyExecutionGrant: () => ({ verified: true }) } }),
    error => error.code === 'EXECUTION_AUTHORIZATION_ADAPTER_REQUIRED',
  );
});

test('standalone CLI disables both Agent execution entrypoints', async () => {
  for (const args of [['lifecycle', 'execute'], ['run', 'execute']]) {
    await assert.rejects(
      () => execFile(process.execPath, ['bin/agent-harness.mjs', ...args], { cwd: process.cwd(), windowsHide: true }),
      error => {
        const output = JSON.parse(error.stderr);
        return output.code === 'AGENT_CLI_EXECUTION_DISABLED';
      },
    );
  }
});

test('Codex CLI Runtime rejects a missing Core launch capability before process spawn', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime' } });
  t.after(() => fixture.cleanup());
  let spawnProcessCallCount = 0;
  const runtime = createCodexCliRuntime({
    resolveProject: id => fixture.harness.projectRegistry.get(id),
    runtimeRoot: fixture.dataRoot,
    spawnProcess: () => { spawnProcessCallCount += 1; throw new Error('must not spawn'); },
  });
  const packet = {
    protocolVersion: '1.0',
    projectId: fixture.projectId,
    dispatchId: 'dispatch-without-capability',
    feature: { id: 'probe', acceptance: [], dependsOn: [], allowedPaths: [], forbiddenPaths: [], metadata: {} },
    execution: { prompt: { pluginId: 'reference-agent-prompt-codec', pluginVersion: '1.0.0', contractVersion: '1.0' } },
  };
  const prompt = compileAgentPrompt(packet);
  await assert.rejects(
    () => runtime.spawn(packet, { prompt, executionGrantDigest: digest('d'), packetDigest: prompt.packetDigest }),
    error => error.code === 'AGENT_RUNTIME_LAUNCH_CAPABILITY_REQUIRED',
  );
  assert.equal(spawnProcessCallCount, 0);
});
