import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

const errors = [];
if (packageJson.name !== 'agent-harness-vscode') errors.push('VS Code package name mismatch');
if (packageJson.version !== '1.0.0') errors.push('VS Code package version must match Core release');

if (!packageJson.contributes?.chatParticipants?.length) {
  errors.push('VS Code package must contribute at least one chatParticipant');
}

if (!packageJson.contributes?.viewsContainers?.activitybar?.length) {
  errors.push('VS Code package must contribute an activitybar viewsContainer');
}

if (!packageJson.contributes?.views?.['agent-harness']?.length) {
  errors.push('VS Code package must contribute views in the agent-harness container');
}

try {
  await access(resolve(root, packageJson.main));
} catch {
  errors.push(`Missing extension main entrypoint: ${packageJson.main}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, channel: 'vscode', version: packageJson.version }, null, 2));
}
