import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configureBindings } from '../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs';
import { hookResponse, parsePseudoCommand } from '../integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs';
import { resolveCommandIntent } from '../src/extensions/command-contract.mjs';
import { cardWorldCommandManifest, tabletopCollectionCommandManifest } from '../src/consumers/index.mjs';

const pluginRoot = resolve('integrations', 'codex', 'agent-harness-codex');
const skillsRoot = resolve(pluginRoot, 'skills');

test('Codex plugin exposes one explicit-project pseudo-command router', async () => {
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
  assert.match(skill, /h:<project-alias> <action> <target> \[preset\]/);
  assert.match(skill, /h:where/);
  assert.match(skill, /h:report/);
  assert.match(skill, /commandManifest/);
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.match(metadata, /h:report/);
  assert.match(hooks, /UserPromptSubmit/);
  const reference = skill.match(/\]\(([^)]+pseudo-command-contract\.md)\)/)?.[1];
  assert(reference);
  await access(resolve(dirname(skillPath), reference));
});

test('pseudo-command parser requires a project alias and supports h:where and h:report', () => {
  assert.equal(parsePseudoCommand('普通对话'), null);
  assert.deepEqual(parsePseudoCommand('h:engine quality V3.8.4 review-only'), {
    protocolVersion: '1.0', kind: 'command', projectAlias: 'engine', action: 'quality', target: 'V3.8.4', arguments: ['review-only'],
  });
  assert.deepEqual(parsePseudoCommand('h:where'), { protocolVersion: '1.0', kind: 'where' });
  assert.deepEqual(parsePseudoCommand('h:where engine'), { protocolVersion: '1.0', kind: 'where', projectAlias: 'engine' });
  assert.deepEqual(parsePseudoCommand('h:report engine'), { protocolVersion: '1.0', kind: 'report', projectAlias: 'engine' });
  assert.equal(parsePseudoCommand('h:report').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:report engine extra').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:quality V3.8.4 review-only').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:engine quality V3.8.4 review-only extra').kind, 'invalid');
});

test('binding configuration makes project selection and Harness location deterministic', async () => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'agent-harness-codex-'));
  try {
    const installedPlugin = resolve(fixture, 'plugin');
    const controlRoot = resolve(fixture, 'harness');
    const workspaceRoot = resolve(fixture, 'CardWorld');
    const entrypoint = resolve(controlRoot, 'bin', 'agent-harness.mjs');
    await Promise.all([
      mkdir(resolve(controlRoot, 'bin'), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(installedPlugin, { recursive: true }),
    ]);
    await writeFile(entrypoint, '', 'utf8');
    const configured = await configureBindings({
      pluginRoot: installedPlugin,
      controlRoot,
      workspaceRoot,
      entrypoint: 'bin/agent-harness.mjs',
      dataRoot: '.agent-harness-data',
      projectSpecs: [
        'engine|cardworld-engine|engine-delivery|cardworld-engine-profile',
        'collection|tabletop-collection|collection-batch|tabletop-collection-profile',
      ],
    });
    assert.equal(configured.harness.entrypoint, entrypoint);

    const options = { pluginRoot: installedPlugin };
    const output = await hookResponse({ prompt: 'h:engine req V3.8.4 expand-to-plan', cwd: workspaceRoot }, options);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /commandManifest/);
    assert.match(context, /"projectAlias":"engine"/);
    assert.match(context, /"projectId":"cardworld-engine"/);
    assert.match(context, /"entrypoint":/);
    assert.match(context, /不得搜索磁盘/);

    const where = await hookResponse({ prompt: 'h:where', cwd: workspaceRoot }, options);
    assert.match(where.hookSpecificOutput.additionalContext, /只读结果/);
    assert.match(where.hookSpecificOutput.additionalContext, /cardworld-engine/);
    assert.match(where.hookSpecificOutput.additionalContext, /tabletop-collection/);

    const unknown = await hookResponse({ prompt: 'h:unknown quality V3.8.4', cwd: workspaceRoot }, options);
    assert.match(unknown.hookSpecificOutput.additionalContext, /项目别名不存在/);
    assert.match(unknown.hookSpecificOutput.additionalContext, /不得猜测项目/);

    const report = await hookResponse({ prompt: 'h:report engine', cwd: workspaceRoot }, options);
    const reportContext = report.hookSpecificOutput.additionalContext;
    assert.match(reportContext, /不得新建任务/);
    assert.match(reportContext, /issue record/);
    assert.match(reportContext, /controlRoot\/issues/);
    assert.match(reportContext, /"commandId":"report_/);
    assert.match(reportContext, /"projectId":"cardworld-engine"/);
    assert.match(reportContext, /"executionWorkspaceRoot"/);
    assert.equal(reportContext.length <= 1800, true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('binding accepts only linked worktrees with the configured Git common directory', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'agent-harness-worktree-binding-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const localPluginRoot = resolve(fixture, 'plugin');
  const controlRoot = resolve(fixture, 'control');
  const repositoryRoot = resolve(fixture, 'CardWorld');
  const commonDirectory = resolve(repositoryRoot, '.git');
  const gitDirectory = resolve(commonDirectory, 'worktrees', 'task');
  const linkedWorktree = resolve(fixture, 'worktrees', 'task', 'CardWorld');
  const unrelatedWorkspace = resolve(fixture, 'unrelated');
  await Promise.all([
    mkdir(localPluginRoot, { recursive: true }),
    mkdir(controlRoot, { recursive: true }),
    mkdir(gitDirectory, { recursive: true }),
    mkdir(linkedWorktree, { recursive: true }),
    mkdir(resolve(unrelatedWorkspace, '.git'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(controlRoot, 'agent-harness.mjs'), '', 'utf8'),
    writeFile(resolve(gitDirectory, 'commondir'), '../..\n', 'utf8'),
    writeFile(resolve(linkedWorktree, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8'),
  ]);
  const configured = await configureBindings({
    pluginRoot: localPluginRoot,
    controlRoot,
    workspaceRoot: repositoryRoot,
    entrypoint: 'agent-harness.mjs',
    dataRoot: 'data',
    projectSpecs: ['engine|cardworld-engine|engine-delivery|cardworld-engine-profile'],
  });
  assert.equal(configured.workspaceIdentity.type, 'git-common-dir');
  const linked = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: linkedWorktree }, { pluginRoot: localPluginRoot });
  assert.match(linked.hookSpecificOutput.additionalContext, /"workspaceMatch":"linked-worktree"/);
  assert.match(linked.hookSpecificOutput.additionalContext, /"executionWorkspaceRoot"/);
  const unrelated = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: unrelatedWorkspace }, { pluginRoot: localPluginRoot });
  assert.match(unrelated.hookSpecificOutput.additionalContext, /不是该仓库经验证的 linked worktree/);
});

test('the same pseudo actions resolve through the explicitly selected Extension command manifest', () => {
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
