import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLastJsonDocument } from '../scripts/parse-json-output.mjs';

test('release candidate parser accepts npm lifecycle output before pack JSON', () => {
  const output = [
    '> agent-harness@1.0.0 prepack',
    '> node scripts/check-project.mjs',
    '',
    JSON.stringify({ ok: true, checked: ['exports', 'skills'] }, null, 2),
    JSON.stringify([{ filename: 'agent-harness-1.0.0.tgz', files: [] }], null, 2),
  ].join('\r\n');

  assert.deepEqual(parseLastJsonDocument(output), [{ filename: 'agent-harness-1.0.0.tgz', files: [] }]);
});

test('release candidate parser rejects output without a final JSON document', () => {
  assert.throws(
    () => parseLastJsonDocument('npm pack failed'),
    error => error?.code === 'COMMAND_JSON_OUTPUT_INVALID',
  );
});
