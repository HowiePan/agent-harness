import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalPluginRelease } from './plugin-release-workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Agent Harness local release and Codex plugin reinstall\n\nUsage:\n  npm run release:plugin:check\n  npm run release:plugin\n\nThe apply command creates a verified local Release Candidate, then performs an awaited\nCodex plugin remove/add cycle and verifies the installed version and source. It never\nruns an Agent CLI, git commit/tag/push, npm publish, signing, cutover, or deletion.\n`;

const argument = process.argv[2];
if (argument === '--help' || argument === '-h') {
  process.stdout.write(usage);
} else {
  const mode = argument === '--check' ? 'check' : argument === '--apply' ? 'apply' : null;
  if (!mode || process.argv.length !== 3) {
    process.stderr.write(usage);
    process.stderr.write('\nExactly one of --check or --apply is required.\n');
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
