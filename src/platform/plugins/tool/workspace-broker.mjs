import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { sha256 } from '../../../common/canonical.mjs';
import { assert } from '../../../common/errors.mjs';
import { assertInside, slash } from '../../../common/paths.mjs';
import { atomicWrite } from '../../../kernel/atomic-io.mjs';
import { envelope } from '../contracts.mjs';

export const createWorkspaceToolBroker = ({ manifest, workspaceRoot, writablePaths = [] }) => {
  const root = resolve(workspaceRoot);
  const allowedWrites = writablePaths.map(path => assertInside(root, resolve(root, path), 'writable path'));
  const pathFor = relativePath => assertInside(root, resolve(root, relativePath), 'workspace path');
  return {
    async invoke(request) {
      const file = request.path ? pathFor(request.path) : root;
      if (request.operation === 'read') {
        const bytes = await readFile(file);
        return envelope(manifest, 'receipt', { operation: 'read', path: slash(request.path), sha256: sha256(bytes), size: bytes.length, body: request.encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf8') });
      }
      if (request.operation === 'stat') {
        const info = await stat(file);
        return envelope(manifest, 'receipt', { operation: 'stat', path: slash(request.path), size: info.size, kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other' });
      }
      if (request.operation === 'list') {
        const entries = (await readdir(file, { withFileTypes: true })).map(entry => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' })).sort((a, b) => a.name.localeCompare(b.name));
        return envelope(manifest, 'receipt', { operation: 'list', path: slash(request.path ?? ''), entries });
      }
      if (request.operation === 'write') {
        assert(allowedWrites.some(directory => fileInside(directory, file)), 'TOOL_WRITE_DENIED', 'Workspace write is outside the Feature authorization.', { path: request.path });
        if (request.expectedSha256) {
          let actual = null;
          try { actual = sha256(await readFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          assert(actual === request.expectedSha256, 'TOOL_WRITE_REVISION_CONFLICT', 'Workspace file changed before write.', { path: request.path, expected: request.expectedSha256, actual });
        }
        await mkdir(dirname(file), { recursive: true });
        const bytes = Buffer.from(request.body, request.encoding === 'base64' ? 'base64' : 'utf8');
        await atomicWrite(file, bytes, { root });
        return envelope(manifest, 'receipt', { operation: 'write', path: slash(request.path), sha256: sha256(bytes), size: bytes.length });
      }
      assert(false, 'TOOL_OPERATION_INVALID', `Unsupported workspace operation: ${request.operation}`);
    },
  };
};

const fileInside = (root, file) => {
  try { assertInside(root, file); return true; } catch { return false; }
};
