import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalPluginRelease } from './plugin-release-workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const usage = `Agent Harness Codex channel local release\n\nUsage:\n  npm run release:codex:check\n  npm run release:codex:local\n\nThe local command validates and packs the Core and Codex artifacts, creates a verified\nCore Release Candidate, then removes/adds the local Codex plugin and checks its binding.\nIt does not commit, tag, push, publish, sign, or perform a business cutover.\n`;

const argument = process.argv[2];
if (argument === '--help' || argument === '-h') process.stdout.write(usage);
else {
  const mode = argument === '--check' ? 'check' : argument === '--apply' ? 'apply' : null;
  if (!mode || process.argv.length !== 3) {
    process.stderr.write(`${usage}\nExactly one of --check or --apply is required.\n`);
    process.exitCode = 1;
  } else {
    try {
      const result = await runLocalPluginRelease({ root, mode, npmCli: process.env.npm_execpath });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error?.code ?? 'LOCAL_RELEASE_FAILED'}: ${error?.message ?? error}\n`);
      if (error?.receipt) process.stderr.write(`Failure receipt: ${error.receipt}\n`);
      process.exitCode = 1;
    }
  }
}
