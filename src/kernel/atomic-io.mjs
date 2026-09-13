import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize } from '../canonical.mjs';
import { HarnessError } from '../errors.mjs';
import { assertInside, assertNoLinkPath } from '../paths.mjs';

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

export const readJson = async (file, fallback = undefined) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    if (error instanceof SyntaxError) throw new HarnessError('JSON_INVALID', `Invalid JSON: ${file}`, { file }, { cause: error });
    throw error;
  }
};

export const atomicWrite = async (file, bytes, { root } = {}) => {
  const target = root ? assertNoLinkPath(root, file) : resolve(file);
  await mkdir(dirname(target), { recursive: true });
  if (root) assertNoLinkPath(root, target, 'atomic write target');
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  if (root) assertInside(root, temporary, 'temporary path');
  const handle = await open(temporary, 'wx');
  let closed = false;
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(temporary, target);
    renamed = true;
  } finally {
    if (!closed) await handle.close().catch(() => {});
    if (!renamed) await rm(temporary, { force: true }).catch(() => {});
  }
  try {
    const directory = await open(dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
  }
  return target;
};

export const atomicWriteJson = (file, value, options = {}) => atomicWrite(file, `${canonicalize(value)}\n`, options);

export const withDirectoryLock = async (lockPath, operation, { root, timeoutMs = 5000, pollMs = 20, staleMs = 30000 } = {}) => {
  if (root) assertNoLinkPath(root, lockPath, 'lock path');
  await mkdir(dirname(lockPath), { recursive: true });
  if (root) assertNoLinkPath(root, lockPath, 'lock path');
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(resolve(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          if (root) assertNoLinkPath(root, lockPath, 'lock path');
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      if (Date.now() - started >= timeoutMs) throw new HarnessError('AUTHORITY_LOCK_TIMEOUT', `Timed out acquiring authority lock: ${lockPath}`, { lockPath, timeoutMs });
      await wait(pollMs);
    }
  }
  try {
    return await operation();
  } finally {
    if (root) assertNoLinkPath(root, lockPath, 'lock path');
    await rm(lockPath, { recursive: true, force: true });
  }
};
