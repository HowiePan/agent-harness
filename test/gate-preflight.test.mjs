import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectProjectGateCapabilities } from '../src/platform/workflow/gates/project-gate-runner.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';

test('Gate preflight aggregates observer, recipe, script, package-script, and sandbox blockers', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'gate-preflight');
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(resolve(workspace, 'package.json'), JSON.stringify({ scripts: { present: 'node -e ""' } }), 'utf8');
  const project = {
    id: 'gate-preflight-project',
    gateRecipes: [
      { id: 'missing-node-script', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, 'scripts/missing.mjs'], cwd: '.' },
      { id: 'missing-package-script', executionClass: 'deterministic-process', scope: 'final', command: ['npm', 'run', 'absent'], cwd: '.' },
      { id: 'sandbox-required', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', sandboxMode: 'required' },
    ],
  };
  const report = await inspectProjectGateCapabilities({ project, workspaceRoot: workspace, gateIds: ['missing-node-script', 'missing-package-script', 'sandbox-required', 'undeclared'] });
  const codes = report.issues.map(issue => issue.code);
  assert.equal(report.ready, false);
  for (const code of ['PROCESS_PROGRESS_OBSERVER_REQUIRED', 'GATE_RECIPE_NOT_FOUND', 'GATE_SCRIPT_UNAVAILABLE', 'GATE_PACKAGE_SCRIPT_UNAVAILABLE', 'OS_SANDBOX_REQUIRED']) assert.equal(codes.includes(code), true, code);
});

test('new Gate nodes fail before process inspection unless classified as deterministic processes', async () => {
  await assert.rejects(
    () => inspectProjectGateCapabilities({ project: { id: 'invalid', gateRecipes: [{ id: 'undeclared', command: [process.execPath, '-e', 'process.exit(0)'] }] }, workspaceRoot: process.cwd(), onProgress: () => {} }),
    error => error?.code === 'GATE_EXECUTION_CLASS_INVALID',
  );
  await assert.rejects(
    () => inspectProjectGateCapabilities({ project: { id: 'invalid', gateRecipes: [{ id: 'agent-in-gate', executionClass: 'agent-reasoning', command: [process.execPath, '-e', 'process.exit(0)'] }] }, workspaceRoot: process.cwd(), onProgress: () => {} }),
    error => error?.code === 'GATE_EXECUTION_CLASS_INVALID',
  );
});
