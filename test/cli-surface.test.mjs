import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { harnessProjectRoot, harnessTemporaryRoot } from '../src/index.mjs';

const executeFile = promisify(execFile);

const cli = async (args, dataRoot) => {
  const projectRoot = harnessProjectRoot();
  const { stdout } = await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), ...args, ...(dataRoot ? ['--data-root', dataRoot] : [])], { cwd: projectRoot, windowsHide: true });
  return stdout;
};

const withDataRoot = async run => {
  const parent = resolve(harnessTemporaryRoot(), 'cli-surface');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  try {
    const dataRoot = resolve(root, 'data');
    return await run(dataRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(() => {});
    await rmdir(harnessTemporaryRoot()).catch(() => {});
  }
};

test('CLI help and self-describing commands stay available', async () => {
  const help = await cli(['--help']);
  assert.match(help, /Agent Harness V1\.0\.0/);
  const schema = JSON.parse(await cli(['config', 'schema']));
  assert.equal(schema.$id, 'https://agent-harness.local/schemas/project-harness-config.schema.json');
  const topics = JSON.parse(await cli(['docs', 'list']));
  assert.ok(topics.topics.includes('product'));
  const product = await cli(['docs', 'show', 'product']);
  assert.match(product, /Agent Harness/);
});

test('CLI read-only registries and issue register respond without a project', async () => {
  await withDataRoot(async dataRoot => {
    assert.deepEqual(JSON.parse(await cli(['extension', 'list'], dataRoot)).registry.extensions, []);
    assert.deepEqual(JSON.parse(await cli(['workspace', 'list'], dataRoot)).workspaces, []);
    assert.deepEqual(JSON.parse(await cli(['project', 'list'], dataRoot)).projects, []);
    const issues = JSON.parse(await cli(['issue', 'list']));
    assert.ok(Array.isArray(issues.issues));
    assert.ok(issues.issues.every(issue => issue.triage !== null));
    const doctor = JSON.parse(await cli(['doctor'], dataRoot));
    assert.equal(doctor.ok, true);
    assert.equal(doctor.writeBoundary, 'standalone-control-root-only');
  });
});

test('CLI planning and issue commands expose deterministic plans and status', async () => {
  await withDataRoot(async dataRoot => {
    const activation = JSON.parse(await cli(['release', 'activation-plan'], dataRoot));
    assert.equal(activation.ok, true);
    assert.equal(activation.plan.kind, 'release-activation-plan');
    const sdk = await cli(['docs', 'show', 'sdk']);
    assert.match(sdk, /defineExtensionPack/);
    const status = JSON.parse(await cli(['issue', 'status', '--issue', 'AH-20260915-8C001F4D266E']));
    assert.equal(status.issueId, 'AH-20260915-8C001F4D266E');
    assert.equal(status.triage.disposition.status, 'reopened');
    await assert.rejects(cli(['dev', 'generations'], dataRoot), error => /DEVELOPMENT_SOURCE_MANIFEST_INVALID/.test(error.stderr));
  });
});
