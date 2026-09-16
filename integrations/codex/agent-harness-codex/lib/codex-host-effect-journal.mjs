import { readFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../../../../src/canonical.mjs';
import { assert } from '../../../../src/errors.mjs';
import { assertJsonSchema } from '../../../../src/json-schema.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../../../../src/kernel/atomic-io.mjs';
import { safeSegment } from '../../../../src/paths.mjs';
import { assertHarnessWritePath } from '../../../../src/write-boundary.mjs';

const schema = JSON.parse(readFileSync(new URL('../../../../schemas/codex-host-effect.schema.json', import.meta.url), 'utf8'));
const terminalStates = new Set(['settled', 'contained']);
const transitions = Object.freeze({
  'spawn-requested': new Set(['spawn-responded', 'contained']),
  'spawn-responded': new Set(['agent-observed', 'contained']),
  'agent-observed': new Set(['lease-bound', 'contained']),
  'lease-bound': new Set(['settled', 'contained']),
  settled: new Set(),
  contained: new Set(),
});

export const codexHostEffectDigest = effect => digestJson(withoutKeys(effect, ['effectDigest']));

export const validateCodexHostEffect = effect => {
  assertJsonSchema(effect, schema, { code: 'CODEX_HOST_EFFECT_INVALID', label: 'Codex Host Effect' });
  assert(effect.effectDigest === codexHostEffectDigest(effect), 'CODEX_HOST_EFFECT_DIGEST_MISMATCH', 'Codex Host Effect digest does not match its contents.');
  return structuredClone(effect);
};

const seal = body => validateCodexHostEffect({ ...body, effectDigest: codexHostEffectDigest(body) });

export class CodexHostEffectJournal {
  constructor({ controlRoot, dataRoot, contract, now = () => new Date().toISOString() }) {
    assert(contract?.id && contract?.version && /^[a-f0-9]{64}$/.test(contract?.digest ?? ''), 'CODEX_HOST_CONTRACT_REQUIRED', 'Codex Host Effect Journal requires a versioned native contract identity.');
    this.controlRoot = controlRoot;
    this.root = assertHarnessWritePath(resolve(dataRoot, 'host-effects', 'codex-collaboration'), 'Codex Host Effect Journal root', controlRoot);
    this.contract = structuredClone(contract);
    this.now = now;
  }

  file(effectId) {
    return assertHarnessWritePath(resolve(this.root, `${safeSegment(effectId, 'effectId')}.json`), 'Codex Host Effect entry', this.controlRoot);
  }

  async read(effectId, { required = false } = {}) {
    const value = await readJson(this.file(effectId), null);
    if (!value && required) assert(false, 'CODEX_HOST_EFFECT_NOT_FOUND', `Codex Host Effect was not found: ${effectId}`);
    return value ? validateCodexHostEffect(value) : null;
  }

  async list() {
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const effects = [];
    for (const entry of entries.filter(item => item.isFile() && /^codex_host_effect_[a-f0-9]{24}\.json$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      effects.push(validateCodexHostEffect(await readJson(resolve(this.root, entry.name))));
    }
    return effects;
  }

  async unresolved() {
    return (await this.list()).filter(effect => !terminalStates.has(effect.state));
  }

  async prepare({ request, taskName, binding }) {
    await mkdir(this.root, { recursive: true });
    const effectId = `codex_host_effect_${request.requestDigest.slice(0, 24)}`;
    const file = this.file(effectId);
    const commandId = `${request.requestId}.prepare`;
    const payload = { requestDigest: request.requestDigest, taskName, binding, contract: this.contract };
    const payloadDigest = digestJson(payload);
    return withDirectoryLock(`${file}.lock`, async () => {
      const current = await this.read(effectId);
      if (current) {
        const prior = current.commands?.[commandId];
        assert(prior?.payloadDigest === payloadDigest, 'CODEX_HOST_EFFECT_CONFLICT', 'Codex Host Effect identity was reused with different input.');
        return { effect: current, reused: true };
      }
      const committedAt = this.now();
      const receipt = { commandId, payloadDigest, revision: 1, committedAt };
      const body = {
        protocolVersion: '1.0', kind: 'codex-collaboration-host-effect', effectId, revision: 1, state: 'spawn-requested',
        contract: structuredClone(this.contract), sessionId: request.sessionId, requestId: request.requestId, requestDigest: request.requestDigest,
        operation: request.operation, tool: request.tool, taskName, binding: structuredClone(binding), nativeResult: null,
        nativeTaskName: null, providerAgentId: null, nickname: null, canonicalAgentName: null, outcome: null,
        commands: { [commandId]: receipt }, createdAt: committedAt, updatedAt: committedAt,
      };
      const effect = seal(body);
      await atomicWriteJson(file, effect, { root: this.root });
      return { effect, reused: false };
    }, { root: this.root });
  }

  async transition(effectId, { expectedRevision, commandId, state, patch = {} }) {
    const safeCommandId = safeSegment(commandId, 'commandId');
    const file = this.file(effectId);
    const payloadDigest = digestJson({ state, patch });
    return withDirectoryLock(`${file}.lock`, async () => {
      const current = await this.read(effectId, { required: true });
      const prior = current.commands?.[safeCommandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Codex Host Effect command ID was reused with different input.');
        return { effect: current, receipt: prior, reused: true };
      }
      assert(current.revision === expectedRevision, 'CODEX_HOST_EFFECT_REVISION_CONFLICT', 'Codex Host Effect revision changed.', { expected: expectedRevision, actual: current.revision, effectId });
      assert(transitions[current.state]?.has(state), 'CODEX_HOST_EFFECT_TRANSITION_INVALID', `Codex Host Effect cannot transition from ${current.state} to ${state}.`, { effectId });
      const revision = current.revision + 1;
      const committedAt = this.now();
      const receipt = { commandId: safeCommandId, payloadDigest, revision, committedAt };
      const body = {
        ...withoutKeys(current, ['effectDigest']), ...structuredClone(patch), revision, state,
        commands: { ...current.commands, [safeCommandId]: receipt }, updatedAt: committedAt,
      };
      const effect = seal(body);
      await atomicWriteJson(file, effect, { root: this.root });
      return { effect, receipt, reused: false };
    }, { root: this.root });
  }
}

export const isTerminalCodexHostEffect = effect => terminalStates.has(effect?.state);
