import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { atomicWriteJson } from '../../../../src/kernel/atomic-io.mjs';

const maxRawBytes = 256 * 1024;

export const createHostExchangeDiagnosticWriter = ({ controlRoot, dataRoot, now = () => new Date().toISOString() }) => {
  const root = assertHarnessWritePath(resolve(dataRoot, 'diagnostics', 'codex-host-exchange'), 'Codex Host diagnostic root', controlRoot);
  return async ({ code, request, rawLine, requestId, requestDigest, operation, tool, rawFrameDigest, rawFrameBytes, observedFields, mismatchedFields }) => {
    const rawCaptured = rawFrameBytes <= maxRawBytes;
    const body = {
      protocolVersion: '1.0', kind: 'codex-host-exchange-rejection', code,
      sessionId: request.sessionId, requestId, requestDigest, operation, tool,
      bindingDigest: digestJson(request.binding ?? null), rawFrameDigest, rawFrameBytes,
      observedFields, mismatchedFields, rawCaptured,
      ...(rawCaptured ? { rawFrame: rawLine } : {}),
      observedAt: now(),
    };
    const receipt = { ...body, receiptDigest: digestJson(body) };
    const file = assertHarnessWritePath(resolve(root, `${sha256(`${requestDigest}:${rawFrameDigest}:${code}`)}.json`), 'Codex Host diagnostic', controlRoot);
    await mkdir(root, { recursive: true });
    await atomicWriteJson(file, receipt, { root });
    return { file, receiptDigest: receipt.receiptDigest, rawCaptured };
  };
};
