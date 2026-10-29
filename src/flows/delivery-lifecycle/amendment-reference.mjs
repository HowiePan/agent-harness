import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { assert } from '../../common/errors.mjs';
import { assertNoLinkPath } from '../../common/paths.mjs';
import { sha256 } from '../../common/canonical.mjs';
import { parseAmendmentJson } from './amendment-json.mjs';

/** Read a fixed delta on demand; the complete derived plan never enters the result port. */
export const readAmendmentReference = (revision, value, workspaceRoot) => {
  const ref = value?.deltaRef;
  assert(workspaceRoot && ref?.path?.startsWith(`${revision.amendmentScope.artifactRoot}/`)
    && !/[:\\\u0000-\u001f]/u.test(ref.path) && ref.path.split('/').every(part => part && !['.', '..'].includes(part))
    && /^[a-f0-9]{64}$/.test(ref.sha256 ?? ''),
  'PLAN_AMENDMENT_REFERENCE_INVALID', 'A compact result requires its pinned project-local delta.');
  const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, ref.path), 'amendment delta');
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd); const limit = 128 * 1024 * 1024;
    assert(info.isFile() && info.size <= limit, 'PLAN_AMENDMENT_INPUT_TOO_LARGE', 'An amendment artifact cannot exceed 128 MiB.');
    const buffer = Buffer.alloc(info.size + 1); let length = 0; let count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null))) length += count;
    assert(length === info.size && fstatSync(fd).size === info.size,
      'PLAN_AMENDMENT_INPUT_STALE', 'The pinned delta changed during reading.');
    const bytes = buffer.subarray(0, length);
    assert(sha256(bytes) === ref.sha256, 'PLAN_AMENDMENT_INPUT_STALE', 'The pinned delta bytes changed.');
    return parseAmendmentJson(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } finally { closeSync(fd); }
};
