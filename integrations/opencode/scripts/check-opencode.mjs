import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

const errors = [];
if (packageJson.name !== 'agent-harness-opencode') errors.push('OpenCode package name mismatch');
if (packageJson.version !== '1.0.0') errors.push('OpenCode package version must match Core release');

for (const target of Object.values(packageJson.exports)) {
  try { await access(resolve(root, target)); }
  catch { errors.push(`Missing export target: ${target}`); }
}

const skillMd = await readFile(resolve(root, 'skills', 'agent-harness', 'SKILL.md'), 'utf8');
if (!skillMd.startsWith('---\n') || !skillMd.includes('name: agent-harness\n') || !skillMd.includes('description: ')) {
  errors.push('OpenCode skill frontmatter invalid');
}

const commandMd = await readFile(resolve(root, 'commands', 'h.md'), 'utf8');
if (!commandMd.startsWith('---\n') || !commandMd.includes('description: ')) {
  errors.push('OpenCode command frontmatter invalid');
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, channel: 'opencode', version: packageJson.version }, null, 2));
}
