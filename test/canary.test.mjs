import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { command, dispatchAndBind, feature, makeFixture, recordResult, startRun } from './test-support.mjs';

for (const projectId of ['neutral-library', 'neutral-service', 'neutral-docs']) {
  test(`zero-residency canary: ${projectId}`, async t => {
    const fixture = await makeFixture({ projectId, profiles: ['feature-delivery'] }); t.after(() => fixture.cleanup());
    const before = await readdir(fixture.workspace);
    const readme = await readFile(`${fixture.workspace}/README.md`, 'utf8');
    await startRun(fixture, { runId: 'canary', features: [feature('portable-work')] });
    const bound = await dispatchAndBind(fixture, 'canary');
    const result = await recordResult(fixture, 'canary', bound.dispatch);
    const closed = await fixture.harness.kernel.closeRun(projectId, 'canary', {}, command(result.state));
    assert.equal(closed.state.status, 'closed');
    assert.deepEqual(await readdir(fixture.workspace), before);
    assert.equal(await readFile(`${fixture.workspace}/README.md`, 'utf8'), readme);
    assert.equal(before.some(name => name.includes('harness')), false);
  });
}
