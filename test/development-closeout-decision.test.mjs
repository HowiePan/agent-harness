import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { assertDevelopmentCloseoutDecisionScope } from '../src/application/development-closeout-decision.mjs';

const ready = () => ({
  state: {
    projectId: 'engine', runId: 'closeout-1', revision: 18, status: 'closure-blocked',
    sourceDigest: 'source-1', profile: { config: { closeoutOnly: true } },
    metadata: { qualityCloseout: { sourceDigest: 'source-1' } },
  },
  decision: { id: 'routine-version-exit', actor: 'human-user', decision: 'approved', runId: 'closeout-1' },
  projectId: 'engine', expectedRevision: 18, commandId: 'decision-1', currentSourceDigest: 'source-1', workspaceMatch: true,
  profile: { canClose: () => ({ ok: false, reason: 'routine-version-exit-decision-required' }) },
});

test('source-linked routine exit accepts only the ready bound closeout Run', () => {
  assert.deepEqual(assertDevelopmentCloseoutDecisionScope(ready()), { recorded: false });
  const resumed = ready();
  resumed.state.status = 'ready-to-close';
  resumed.state.decisions = [{ ...resumed.decision, digest: digestJson(resumed.decision) }];
  resumed.profile.canClose = () => ({ ok: true });
  assert.deepEqual(assertDevelopmentCloseoutDecisionScope(resumed), { recorded: true });
  resumed.state.decisions[0].digest = 'wrong';
  assert.throws(() => assertDevelopmentCloseoutDecisionScope(resumed), { code: 'DEVELOPMENT_CLOSEOUT_DECISION_SCOPE_MISMATCH' });
  for (const change of [
    input => { input.projectId = 'other'; },
    input => { input.expectedRevision = 17; },
    input => { input.state.sourceDigest = 'drift'; },
    input => { input.currentSourceDigest = 'drift'; },
    input => { input.workspaceMatch = false; },
    input => { input.state.status = 'incomplete'; },
    input => { input.state.profile.config.closeoutOnly = false; },
    input => { input.decision.id = 'user-code-review'; },
    input => { input.decision.runId = 'other'; },
    input => { input.profile.canClose = () => ({ ok: false, reason: 'required-final-gate-missing:wasm' }); },
  ]) {
    const input = ready();
    change(input);
    assert.throws(() => assertDevelopmentCloseoutDecisionScope(input), { code: 'DEVELOPMENT_CLOSEOUT_DECISION_SCOPE_MISMATCH' });
  }
});
