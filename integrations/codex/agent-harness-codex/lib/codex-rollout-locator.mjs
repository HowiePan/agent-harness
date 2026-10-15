import { open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** SQLite WAL access may fail in a read-only Windows sandbox. Resolve only the
 * current UUIDv7's native day directory, never another session or a full scan. */
export const locateCodexRolloutFromMetadata = async ({ codexHome, codexSessionId, expectedCwd }) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(codexSessionId))
    fail('CODEX_ROLLOUT_METADATA_SESSION_INVALID', 'Metadata location requires the exact current UUIDv7 session.');
  const home = await realpath(codexHome);
  const date = new Date(Number.parseInt(codexSessionId.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10);
  const directory = await realpath(join(home, 'sessions', ...date.split('-')));
  if (!inside(join(home, 'sessions'), directory)) fail('CODEX_ROLLOUT_PATH_INVALID', 'Native session directory leaves CODEX_HOME/sessions.');
  const names = (await readdir(directory)).filter(name => name.startsWith('rollout-') && name.endsWith(`-${codexSessionId}.jsonl`));
  if (names.length !== 1) fail('CODEX_ROLLOUT_METADATA_AMBIGUOUS', 'Exactly one native rollout must bind the current session.');
  const path = await realpath(join(directory, names[0]));
  if (!inside(directory, path)) fail('CODEX_ROLLOUT_PATH_INVALID', 'Native rollout leaves its session directory.');
  const handle = await open(path, 'r');
  let record;
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.indexOf(10, 0);
    if (newline < 0 || newline >= bytesRead) fail('CODEX_ROLLOUT_METADATA_INVALID', 'Native session header is missing or exceeds its limit.');
    try { record = JSON.parse(bytes.subarray(0, newline).toString('utf8')); }
    catch { fail('CODEX_ROLLOUT_METADATA_INVALID', 'Native session header is not JSON.'); }
  } finally { await handle.close(); }
  const metadata = record?.payload;
  if (record?.type !== 'session_meta' || metadata?.id !== codexSessionId
    || typeof metadata.cwd !== 'string' || !samePath(metadata.cwd, expectedCwd)
    || typeof metadata.cli_version !== 'string' || !metadata.cli_version.trim())
    fail('CODEX_ROLLOUT_SESSION_NOT_BOUND', 'Native session metadata does not bind this session and workspace.');
  return { path, cliVersion: metadata.cli_version, codexHome: home };
};

export const readCodexThread = (databasePath, codexSessionId, Database) => {
  const database = new Database(databasePath, { readOnly: true });
  try { return database.prepare('SELECT id, rollout_path, cwd, cli_version FROM threads WHERE id = ?').get(codexSessionId); }
  finally { database.close(); }
};

/** Schema, corruption, missing-session and workspace errors never use fallback. */
export const resolveCodexThreadWithMetadata = async ({ databasePath, codexSessionId, codexHome, expectedCwd, Database }) => {
  try { return { row: readCodexThread(databasePath, codexSessionId, Database) }; }
  catch (error) {
    if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 14) throw error;
    return { host: await locateCodexRolloutFromMetadata({ codexHome, codexSessionId, expectedCwd }) };
  }
};
