export const readCodexThread = (databasePath, codexSessionId, Database) => {
  const database = new Database(databasePath, { readOnly: true });
  try { return database.prepare('SELECT id, rollout_path, cwd, cli_version FROM threads WHERE id = ?').get(codexSessionId); }
  finally { database.close(); }
};

/** A logical thread may resume into a new paginated rollout. Its original
 * UUIDv7 day and session_meta cannot identify the active physical file. */
export const resolveCodexThread = async ({ databasePath, codexSessionId, Database }) => {
  try { return { row: readCodexThread(databasePath, codexSessionId, Database) }; }
  catch (error) {
    if (error.code !== 'ERR_SQLITE_ERROR' || error.errcode !== 14) throw error;
    throw Object.assign(new Error('Read-only access to the current Codex session database is unavailable. Verify the exact bound Host probe with narrowly scoped sandbox escalation before starting the Coordinator; do not infer the active rollout from the original session filename.'),
      { code: 'CODEX_ROLLOUT_DATABASE_UNAVAILABLE', cause: error });
  }
};
