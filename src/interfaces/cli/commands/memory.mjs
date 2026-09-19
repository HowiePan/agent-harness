import { resolve } from 'node:path';
import { AuthorityStore } from '../../../kernel/authority-store.mjs';
import { MemoryStore } from '../../../platform/resources/memory/memory-store.mjs';

export const handleMemoryCommand = async ({ subject, runDataRoot, controlRoot, take, optionalNumber, jsonInput }) => {
  const authorityStore = new AuthorityStore({ root: runDataRoot, controlRoot });
  const memory = new MemoryStore({ controlRoot, root: take('--memory-root') ?? resolve(runDataRoot, 'memory'), authorityStore });
  const input = subject === 'recover' ? null : await jsonInput('--input');
  const options = { ...input, commandId: take('--command-id'), expectedRevision: optionalNumber('--expected-revision') };
  const result = subject === 'query' ? await memory.query(input)
    : subject === 'propose' ? await memory.propose(options)
    : subject === 'stage' ? await memory.stageFromSubmission(options)
    : subject === 'promote' ? await memory.promote(options)
    : subject === 'revoke' ? await memory.revoke(options)
    : subject === 'reject' ? await memory.rejectAnswer(options)
    : subject === 'export' ? await memory.exportVerified(input)
    : subject === 'import' ? await memory.importUnverified(options)
    : subject === 'recover' ? await memory.recoverPendingPromotions()
    : null;
  if (result === null) throw Object.assign(new Error(`Unknown memory command: ${subject}`), { code: 'COMMAND_UNKNOWN' });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
  return true;
};
