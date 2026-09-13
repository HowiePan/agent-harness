import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hookResponse, parsePseudoCommand } from '../integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs';
import { resolveCommandIntent } from '../src/extensions/command-contract.mjs';
import { cardWorldCommandManifest, tabletopCollectionCommandManifest } from '../src/consumers/index.mjs';

const pluginRoot = resolve('integrations', 'codex', 'agent-harness-codex');
const skillsRoot = resolve(pluginRoot, 'skills');

test('Codex plugin exposes one generic pseudo-command router instead of project-prefixed command skills', async () => {
  const actual = (await readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(actual, ['agent-harness-command', 'agent-harness-extension-author', 'agent-harness-operator']);
  assert(!actual.some(name => name.startsWith('collection-') || name.startsWith('harness-')));

  const skillPath = resolve(skillsRoot, 'agent-harness-command', 'SKILL.md');
  const [skill, metadata, hooks] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(resolve(skillsRoot, 'agent-harness-command', 'agents', 'openai.yaml'), 'utf8'),
    readFile(resolve(pluginRoot, 'hooks', 'hooks.json'), 'utf8'),
  ]);
  assert.match(skill, /^---\nname: agent-harness-command\n/);
  assert.match(skill, /h:<action> <target> \[preset\]/);
  assert.match(skill, /commandManifest/);
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.match(hooks, /UserPromptSubmit/);
  const reference = skill.match(/\]\(([^)]+pseudo-command-contract\.md)\)/)?.[1];
  assert(reference);
  await access(resolve(dirname(skillPath), reference));
});

test('pseudo-command hook parses only the generic single-line envelope and never embeds project semantics', () => {
  assert.equal(parsePseudoCommand('普通对话'), null);
  assert.deepEqual(parsePseudoCommand('h:quality V3.8.4 review-only'), {
    protocolVersion: '1.0', action: 'quality', target: 'V3.8.4', arguments: ['review-only'],
  });
  assert(parsePseudoCommand('h:quality V3.8.4 review-only extra').error);
  const output = hookResponse({ prompt: 'h:req V3.8.4 expand-to-plan', cwd: 'F:\\consumer' });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /commandManifest/);
  assert.match(context, /"action":"req"/);
  assert.doesNotMatch(context, /collection|cardworld/i);
});

test('the same pseudo actions resolve through the selected Extension command manifest', () => {
  const engineQuality = resolveCommandIntent(cardWorldCommandManifest, { action: 'quality', target: 'V3.8.4', arguments: ['review-only'] });
  assert.equal(engineQuality.profileId, 'engine-delivery');
  assert.equal(engineQuality.sourcePolicy, 'read-only');
  assert.equal(engineQuality.scope, 'quality');

  const requirement = resolveCommandIntent(cardWorldCommandManifest, { action: 'req', target: 'V3.8.4', arguments: ['expand-to-plan'] });
  assert.equal(requirement.action, 'requirements');
  assert.equal(requirement.scope, 'requirement-expansion..version-plan');

  const batchQuality = resolveCommandIntent(tabletopCollectionCommandManifest, { action: 'quality', target: 'B1', arguments: ['game:chess'] });
  assert.equal(batchQuality.profileId, 'collection-batch');
  assert.equal(batchQuality.preset, 'game');
  assert.equal(batchQuality.selector, 'chess');
  assert.throws(() => resolveCommandIntent(cardWorldCommandManifest, { action: 'rules', target: 'V3.8.4' }), error => error.code === 'COMMAND_ACTION_UNKNOWN');
});
