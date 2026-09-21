import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalPluginRelease } from './plugin-release-workflow.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const usage = `Agent Harness Codex channel local release\n\nUsage:\n  npm run release:codex:check\n  npm run release:codex:prepare\n  npm run release:codex:local -- --prepared <preparation-receipt.json>\n\nPrepare runs all source, test, package, and clean-room checks without changing the Codex\ninstallation. Apply accepts only those exact prepared artifacts, then removes/adds the\nlocal Codex plugin and verifies its binding. Neither mode commits, tags, pushes, publishes,\nsigns, activates a runtime composition, or performs a business cutover.\n`;

const argument = process.argv[2];
if (argument === '--help' || argument === '-h') process.stdout.write(usage);
else {
  const mode = argument === '--check' ? 'check' : argument === '--prepare' ? 'prepare' : argument === '--apply' ? 'apply' : null;
  const preparedIndex = process.argv.indexOf('--prepared');
  const preparedReceiptFile = preparedIndex >= 0 ? process.argv[preparedIndex + 1] : undefined;
  const validArguments = mode === 'apply' ? process.argv.length === 5 && preparedIndex === 3 && preparedReceiptFile : process.argv.length === 3;
  if (!mode || !validArguments) {
    process.stderr.write(`${usage}\nUse exactly one mode; --apply also requires one --prepared receipt.\n`);
    process.exitCode = 1;
  } else {
    try {
      const result = await runLocalPluginRelease({ root, mode, preparedReceiptFile, npmCli: process.env.npm_execpath });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${error?.code ?? 'LOCAL_RELEASE_FAILED'}: ${error?.message ?? error}\n`);
      if (error?.receipt) process.stderr.write(`Failure receipt: ${error.receipt}\n`);
      process.exitCode = 1;
    }
  }
}
