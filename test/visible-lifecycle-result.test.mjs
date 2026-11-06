import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../src/common/canonical.mjs';
import { preserveVisibleResult } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-result.mjs';
import { makeFixture } from './test-support.mjs';
test('large terminal Authority is preserved by digest while its live event stays compact', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const result = { status: 'attention-required', reason: 'blocked-dependencies', state: {
    runId: 'run', revision: 4, sourceDigest: 'a'.repeat(64),
    features: [{ id: 'owner', state: 'blocked', blocker: { kind: 'environment', summary: 'failed'.repeat(2000) } }],
    leases: [], submissions: [{ prompt: 'x'.repeat(400000) }] } };
  const summary = await preserveVisibleResult({ result, dataRoot: f.dataRoot, controlRoot: process.cwd(), commandId: 'test-complete' });
  assert.ok(JSON.stringify(summary).length < 3000);
  assert.equal(summary.runId, 'run');
  const bytes = await readFile(summary.resultArtifact.path);
  assert.equal(sha256(bytes), summary.resultArtifact.sha256);
  assert.equal(bytes.length, summary.resultArtifact.size);
  assert.deepEqual(JSON.parse(bytes), result);
});
