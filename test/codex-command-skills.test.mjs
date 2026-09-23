import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { configureBindings } from '../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs';
import { hookResponse, loadBindings, parsePseudoCommand } from '../integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs';
import { decodeVisibleLifecycleIntent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';
import { resolveCommandIntent } from '../src/platform/extensions/command-contract.mjs';
import { cardWorldCommandManifest } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { tabletopCollectionCommandManifest } from '../integrations/legacy-consumers/collection/index.mjs';
import { digestJson, sha256 } from '../src/common/canonical.mjs';

const pluginRoot = resolve('integrations', 'codex', 'agent-harness-codex');
const skillsRoot = resolve(pluginRoot, 'skills');

const createTemporaryFixture = async prefix => {
  await mkdir(tmpdir(), { recursive: true });
  return mkdtemp(resolve(tmpdir(), prefix));
};

const createActiveReleaseFixture = async controlRoot => {
  const dataRoot = resolve(controlRoot, 'data');
  const runtimeRelative = 'runtime';
  const runtimeRoot = resolve(controlRoot, runtimeRelative);
  const entryRelative = 'bin/agent-harness.mjs';
  const entrypoint = resolve(runtimeRoot, entryRelative);
  const entryBytes = Buffer.from('// fixture runtime\n');
  const coordinatorRelative = 'integrations/codex/agent-harness-codex/scripts/visible-lifecycle-coordinator.mjs';
  const coordinatorEntrypoint = resolve(runtimeRoot, coordinatorRelative);
  const coordinatorBytes = Buffer.from('// fixture visible coordinator\n');
  const hostBridgeRelative = 'integrations/codex/agent-harness-codex/lib/hook-host-exchange.mjs';
  const hostBridgeModule = resolve(runtimeRoot, hostBridgeRelative);
  const hostBridgeBytes = Buffer.from('export const captureHookToolResult = async () => ({ captured: false });\n');
  const files = [{ path: entryRelative, sha256: sha256(entryBytes), size: entryBytes.length }];
  const packageDigest = digestJson(files);
  const channelFiles = [
    { path: coordinatorRelative, sha256: sha256(coordinatorBytes), size: coordinatorBytes.length },
    { path: hostBridgeRelative, sha256: sha256(hostBridgeBytes), size: hostBridgeBytes.length },
  ];
  const channelBody = { protocolVersion: '1.0', channel: 'codex', plugin: { name: 'agent-harness-codex', version: '1.0.0' }, requiresCore: { name: 'agent-harness', version: '1.0.0', packageDigest }, layout: { pluginPath: 'integrations/codex/agent-harness-codex', marketplacePath: '.agents/plugins/marketplace.json' }, files: channelFiles, contentDigest: digestJson(channelFiles) };
  const channelArtifactDigest = digestJson(channelBody);
  const generationId = 'g-fixture';
  await Promise.all([
    mkdir(resolve(runtimeRoot, 'bin'), { recursive: true }),
    mkdir(dirname(coordinatorEntrypoint), { recursive: true }),
    mkdir(dirname(hostBridgeModule), { recursive: true }),
    mkdir(resolve(dataRoot, 'registry', 'generations', generationId, 'projects'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(entrypoint, entryBytes),
    writeFile(coordinatorEntrypoint, coordinatorBytes),
    writeFile(hostBridgeModule, hostBridgeBytes),
    writeFile(resolve(runtimeRoot, 'release-manifest.json'), `${JSON.stringify({ protocolVersion: '1.0', version: '1.0.0', files, packageDigest })}\n`, 'utf8'),
    writeFile(resolve(runtimeRoot, 'codex-channel-manifest.json'), `${JSON.stringify({ ...channelBody, artifactDigest: channelArtifactDigest })}\n`, 'utf8'),
    writeFile(resolve(dataRoot, 'registry', 'generations', generationId, 'extensions.json'), '{}\n', 'utf8'),
  ]);
  const pointer = { protocolVersion: '1.0', kind: 'active-release', generationId, release: { version: '1.0.0', artifactDigest: packageDigest, verified: true }, runtimeRoot: runtimeRelative, runtimeEntrypoint: `${runtimeRelative}/${entryRelative}` };
  pointer.pointerDigest = digestJson(pointer);
  await writeFile(resolve(dataRoot, 'registry', 'active-release.json'), `${JSON.stringify(pointer)}\n`, 'utf8');
  return { dataRoot, entrypoint, coordinatorEntrypoint, hostBridgeModule, release: { version: '1.0.0', artifactDigest: packageDigest, channelArtifactDigest, generationId, pointerDigest: pointer.pointerDigest } };
};

test('Codex plugin exposes one explicit-project pseudo-command router', async () => {
  const actual = (await readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.deepEqual(actual, ['agent-harness-command', 'agent-harness-extension-author', 'agent-harness-flow-author', 'agent-harness-operator', 'agent-harness-workspace-author']);
  assert(!actual.some(name => name.startsWith('collection-') || name.startsWith('harness-')));

  const skillTexts = await Promise.all(actual.map(name => readFile(resolve(skillsRoot, name, 'SKILL.md'), 'utf8')));
  for (const skillText of skillTexts) {
    assert.match(skillText, /exact user-selected project checkout as the only source-edit destination/);
    assert.match(skillText, /Sharing a Git common directory is not sufficient/);
    assert.match(skillText, /Do not create or use a sibling worktree, clone, mirror, staging repository, or project-external directory/);
    assert.match(skillText, /Creating or registering any Git worktree is a protected mutation/);
    assert.match(skillText, /obtain the user's explicit authorization for the exact repository, base ref or branch, and target path/);
    assert.match(skillText, /Never create a worktree silently/);
    assert.match(skillText, /A general request to implement, continue, isolate work, use another drive, or avoid the current checkout is not worktree authorization/);
    assert.match(skillText, /treat `C:\\` as read-only by default/);
    assert.match(skillText, /sole write exception is a user-requested Codex plugin lifecycle operation/);
    assert.match(skillText, /install, reinstall, update, or remove an exact named Codex plugin/);
    assert.match(skillText, /plugin-manager-owned cache, registration, marketplace, and configuration writes/);
    assert.match(skillText, /execute the official command rather than editing files directly/);
    assert.match(skillText, /does not authorize source, worktree, temporary, build, Harness control\/data, arbitrary configuration/);
    assert.match(skillText, /`git status --short` exposes every source change/);
    assert.match(skillText, /uncommitted changes are not portable to another computer/);
  }

  const skillPath = resolve(skillsRoot, 'agent-harness-command', 'SKILL.md');
  const [skill, operatorSkill, metadata, hooks] = await Promise.all([
    readFile(skillPath, 'utf8'),
    readFile(resolve(skillsRoot, 'agent-harness-operator', 'SKILL.md'), 'utf8'),
    readFile(resolve(skillsRoot, 'agent-harness-command', 'agents', 'openai.yaml'), 'utf8'),
    readFile(resolve(pluginRoot, 'hooks', 'hooks.json'), 'utf8'),
  ]);
  assert.match(skill, /^---\nname: agent-harness-command\n/);
  assert.match(skill, /h:<workspace-or-legacy-project-alias> <action> <target> \[preset\]/);
  assert.match(skill, /h:where/);
  assert.match(skill, /h:report/);
  assert.match(skill, /commandManifest/);
  assert.match(skill, /所有面向用户的控制对话必须使用中文/);
  assert.match(skill, /不得为了中文输出而翻译、改写或补充 Harness 生成的子 Agent Prompt/);
  assert.match(skill, /qualityFindingPolicy=repair-and-rereview/);
  assert.match(skill, /`yield_time_ms` no greater than 1000/);
  assert.match(skill, /stop with `CODEX_VISIBLE_COORDINATOR_SESSION_REQUIRED`/);
  assert.match(skill, /deduplicate by the exact `requestId` plus `requestDigest`/);
  assert.match(skill, /Never inspect the pending directory as a substitute/);
  assert.match(operatorSkill, /所有面向用户的控制对话必须使用中文/);
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.match(metadata, /h:report/);
  assert.match(hooks, /UserPromptSubmit/);
  const postToolMatcher = new RegExp(JSON.parse(hooks).hooks.PostToolUse[0].matcher);
  for (const toolName of ['Agent', 'spawn_agent', 'list_agents', 'wait_agent', 'interrupt_agent', 'collaboration.spawn_agent', 'collaboration.list_agents', 'collaboration.wait_agent', 'collaboration.interrupt_agent']) assert.equal(postToolMatcher.test(toolName), true, toolName);
  for (const toolName of ['Bash', 'spawn_agents', 'other.list_agents']) assert.equal(postToolMatcher.test(toolName), false, toolName);
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
  assert.deepEqual(parsePseudoCommand('h:init --decision decision.json --source F:/agent-harness'), { protocolVersion: '1.0', kind: 'init', decisionFile: 'decision.json', configFile: 'harness.json', sourceRoot: 'F:/agent-harness' });
  assert.equal(parsePseudoCommand('h:init --source F:/agent-harness').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:report').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:report engine extra').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:quality V3.8.4 review-only').kind, 'invalid');
  assert.equal(parsePseudoCommand('h:engine quality V3.8.4 review-only extra').kind, 'invalid');
});

test('binding configuration makes project selection and Harness location deterministic', async () => {
  const fixture = await createTemporaryFixture('agent-harness-codex-');
  try {
    const installedPlugin = resolve(fixture, 'plugin');
    const controlRoot = resolve(fixture, 'harness');
    const workspaceRoot = resolve(fixture, 'CardWorld');
    const active = await createActiveReleaseFixture(controlRoot);
    const entrypoint = active.entrypoint;
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(installedPlugin, { recursive: true }),
    ]);
    const configured = await configureBindings({
      pluginRoot: installedPlugin,
      controlRoot,
      workspaceRoot,
      entrypoint: 'runtime/bin/agent-harness.mjs',
      dataRoot: 'data',
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
    assert.match(context, /"coordinatorEntrypoint":/);
    assert.match(context, /"coordinationIntent":/);
    assert.match(context, /--intent/);
    assert.match(context, /不得搜索磁盘/);
    assert.match(context, /所有面向用户的控制对话使用中文/);
    assert.match(context, /不得翻译或改写子 Agent Prompt/);
    assert.match(context, /tty:true/);
    assert.match(context, /4096/);
    const routed = JSON.parse(context.slice(context.indexOf('解析结果：') + '解析结果：'.length));
    const sealed = decodeVisibleLifecycleIntent(routed.coordinationIntent);
    assert.deepEqual(sealed.command, { action: 'req', target: 'V3.8.4', arguments: ['expand-to-plan'] });
    assert.deepEqual(sealed.project, { projectId: 'cardworld-engine', profileId: 'engine-delivery', extensionId: 'cardworld-engine-profile' });
    assert.equal(sealed.harness.coordinatorEntrypoint, active.coordinatorEntrypoint);

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

test('Workspace aliases route exact Workflow and member Project scope into a sealed visible intent', async () => {
  const fixture = await createTemporaryFixture('agent-harness-workspace-binding-');
  try {
    const installedPlugin = resolve(fixture, 'plugin');
    const controlRoot = resolve(fixture, 'harness');
    const workspaceRoot = resolve(fixture, 'output');
    await createActiveReleaseFixture(controlRoot);
    await mkdir(installedPlugin, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    const digest = 'a'.repeat(64);
    await configureBindings({ pluginRoot: installedPlugin, controlRoot, entrypoint: 'runtime/bin/agent-harness.mjs', dataRoot: 'data', workspaceSpecs: [`alpha|alpha|output|${workspaceRoot}`], workflowSpecs: [`alpha|knowledge-qa|1.0.0|${digest}|composable-workflow|knowledge-qa-workflow`] });
    const parsed = parsePseudoCommand('h:alpha flow knowledge-qa ask audit --projects frontend,backend');
    assert.deepEqual(parsed.projectIds, ['frontend', 'backend']);
    const routed = await hookResponse({ prompt: 'h:alpha flow knowledge-qa ask audit --project frontend', cwd: workspaceRoot }, { pluginRoot: installedPlugin });
    const context = routed.hookSpecificOutput.additionalContext;
    const payload = JSON.parse(context.slice(context.indexOf('解析结果：') + '解析结果：'.length));
    const intent = decodeVisibleLifecycleIntent(payload.coordinationIntent);
    assert.deepEqual(intent.project.projectIds, ['frontend']);
    assert.equal(intent.project.workspaceId, 'alpha');
    assert.equal(intent.project.projectId, 'ws.alpha.output');
    assert.equal(intent.project.workflowDigest, digest);
    assert.match((await hookResponse({ prompt: 'h:flows alpha', cwd: workspaceRoot }, { pluginRoot: installedPlugin })).hookSpecificOutput.additionalContext, /knowledge-qa/);
    assert.equal(parsePseudoCommand('h:alpha ask audit --projects frontend,frontend').kind, 'invalid');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test('router recovers its exact install-root binding when a restarted Hook omits runtime environment variables', async () => {
  const fixture = await createTemporaryFixture('agent-harness-runtime-binding-');
  try {
    const pluginInstallRoot = resolve(fixture, 'plugin');
    const bindingRoot = resolve(pluginInstallRoot, '.plugin-data');
    const controlRoot = resolve(fixture, 'harness');
    const workspaceRoot = resolve(fixture, 'workspace');
    await Promise.all([
      mkdir(bindingRoot, { recursive: true }),
      mkdir(controlRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    const active = await createActiveReleaseFixture(controlRoot);
    await writeFile(resolve(bindingRoot, 'bindings.json'), `${JSON.stringify({
      protocolVersion: '1.0',
      harness: {
        controlRoot,
        entrypoint: active.entrypoint,
        dataRoot: active.dataRoot,
        release: active.release,
      },
      projects: {
        engine: { projectId: 'cardworld-engine', profileId: 'engine-delivery', extensionId: 'cardworld-engine-profile', workspaceRoot },
      },
    })}\n`, 'utf8');
    const bindings = await loadBindings({ pluginData: '', pluginRoot: resolve(fixture, 'stale-plugin-root'), fallbackPluginRoot: pluginInstallRoot });
    assert.equal(bindings.source, resolve(bindingRoot, 'bindings.json'));
    const output = await hookResponse({ prompt: 'h:where', cwd: workspaceRoot }, { pluginData: '', pluginRoot: '', fallbackPluginRoot: pluginInstallRoot });
    assert.match(output.hookSpecificOutput.additionalContext, /cardworld-engine/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('router fails closed when the active release pointer changes after binding', async t => {
  const fixture = await createTemporaryFixture('agent-harness-binding-drift-');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const installedPlugin = resolve(fixture, 'plugin');
  const controlRoot = resolve(fixture, 'harness');
  const workspaceRoot = resolve(fixture, 'workspace');
  await Promise.all([mkdir(installedPlugin, { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);
  const active = await createActiveReleaseFixture(controlRoot);
  await configureBindings({ pluginRoot: installedPlugin, controlRoot, workspaceRoot, entrypoint: 'runtime/bin/agent-harness.mjs', dataRoot: 'data', projectSpecs: ['engine|cardworld-engine|engine-delivery|cardworld-engine-profile'] });
  const pointerFile = resolve(active.dataRoot, 'registry', 'active-release.json');
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  pointer.generationId = 'g-next';
  delete pointer.pointerDigest;
  pointer.pointerDigest = digestJson(pointer);
  const generationRoot = resolve(active.dataRoot, 'registry', 'generations', pointer.generationId);
  await mkdir(resolve(generationRoot, 'projects'), { recursive: true });
  await writeFile(resolve(generationRoot, 'extensions.json'), '{}\n', 'utf8');
  await writeFile(pointerFile, `${JSON.stringify(pointer)}\n`, 'utf8');
  const response = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: workspaceRoot }, { pluginRoot: installedPlugin });
  assert.match(response.hookSpecificOutput.additionalContext, /绑定不可用/);
  assert.match(response.hookSpecificOutput.additionalContext, /不得启动或修改任何 Harness 状态/);
});

test('binding fails closed when the active visible Coordinator is missing or changed', async t => {
  const fixture = await createTemporaryFixture('agent-harness-coordinator-binding-');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const installedPlugin = resolve(fixture, 'plugin');
  const controlRoot = resolve(fixture, 'harness');
  const workspaceRoot = resolve(fixture, 'workspace');
  await Promise.all([mkdir(installedPlugin, { recursive: true }), mkdir(workspaceRoot, { recursive: true })]);
  const active = await createActiveReleaseFixture(controlRoot);
  await configureBindings({ pluginRoot: installedPlugin, controlRoot, workspaceRoot, entrypoint: 'runtime/bin/agent-harness.mjs', dataRoot: 'data', projectSpecs: ['engine|cardworld-engine|engine-delivery|cardworld-engine-profile'] });
  await writeFile(active.coordinatorEntrypoint, '// changed coordinator\n', 'utf8');
  const response = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: workspaceRoot }, { pluginRoot: installedPlugin });
  assert.match(response.hookSpecificOutput.additionalContext, /绑定不可用/);
  assert.match(response.hookSpecificOutput.additionalContext, /Codex 渠道文件/);
  assert.match(response.hookSpecificOutput.additionalContext, /不得启动或修改任何 Harness 状态/);
});

test('binding rejects a Codex channel overlay for another Core digest', async t => {
  const fixture = await createTemporaryFixture('agent-harness-channel-binding-');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const controlRoot = resolve(fixture, 'harness');
  const workspaceRoot = resolve(fixture, 'workspace');
  const pluginRoot = resolve(fixture, 'plugin');
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(pluginRoot, { recursive: true })]);
  await createActiveReleaseFixture(controlRoot);
  const channelFile = resolve(controlRoot, 'runtime', 'codex-channel-manifest.json');
  const channel = JSON.parse(await readFile(channelFile, 'utf8'));
  channel.requiresCore.packageDigest = 'f'.repeat(64);
  delete channel.artifactDigest;
  channel.artifactDigest = digestJson(channel);
  await writeFile(channelFile, `${JSON.stringify(channel)}\n`);
  await assert.rejects(
    () => configureBindings({ pluginRoot, controlRoot, workspaceRoot, entrypoint: 'runtime/bin/agent-harness.mjs', dataRoot: 'data', projectSpecs: ['engine|cardworld-engine|engine-delivery|cardworld-engine-profile'] }),
    /Codex 渠道清单与 active Core runtime 不匹配/,
  );
});

test('binding accepts only linked worktrees with the configured Git common directory', async t => {
  const fixture = await createTemporaryFixture('agent-harness-worktree-binding-');
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
  const active = await createActiveReleaseFixture(controlRoot);
  await Promise.all([
    writeFile(resolve(gitDirectory, 'commondir'), '../..\n', 'utf8'),
    writeFile(resolve(linkedWorktree, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8'),
  ]);
  const configured = await configureBindings({
    pluginRoot: localPluginRoot,
    controlRoot,
    workspaceRoot: repositoryRoot,
    entrypoint: 'runtime/bin/agent-harness.mjs',
    dataRoot: 'data',
    projectSpecs: ['engine|cardworld-engine|engine-delivery|cardworld-engine-profile'],
  });
  assert.equal(configured.projects.engine.workspaceIdentity.type, 'git-common-dir');
  const linked = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: linkedWorktree }, { pluginRoot: localPluginRoot });
  assert.match(linked.hookSpecificOutput.additionalContext, /"workspaceMatch":"linked-worktree"/);
  assert.match(linked.hookSpecificOutput.additionalContext, /"executionWorkspaceRoot"/);
  const unrelated = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: unrelatedWorkspace }, { pluginRoot: localPluginRoot });
  assert.match(unrelated.hookSpecificOutput.additionalContext, /不是该仓库经验证的 linked worktree/);
});

test('each project alias can bind and validate an independent workspace', async t => {
  const fixture = await createTemporaryFixture('agent-harness-multi-workspace-binding-');
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const pluginRoot = resolve(fixture, 'plugin');
  const controlRoot = resolve(fixture, 'control');
  const engineRoot = resolve(fixture, 'CardWorld');
  const collectionRoot = resolve(fixture, 'tabletop-collection');
  await Promise.all([mkdir(pluginRoot, { recursive: true }), mkdir(controlRoot, { recursive: true }), mkdir(engineRoot, { recursive: true }), mkdir(collectionRoot, { recursive: true })]);
  await createActiveReleaseFixture(controlRoot);
  const configured = await configureBindings({
    pluginRoot,
    controlRoot,
    entrypoint: 'runtime/bin/agent-harness.mjs',
    dataRoot: 'data',
    projectSpecs: [
      `engine|cardworld-engine|engine-delivery|cardworld-engine-profile|${engineRoot}`,
      `collection|tabletop-collection|collection-batch|tabletop-collection-profile|${collectionRoot}`,
    ],
  });
  assert.equal(configured.projects.engine.workspaceRoot, engineRoot);
  assert.equal(configured.projects.collection.workspaceRoot, collectionRoot);
  const engine = await hookResponse({ prompt: 'h:engine quality V3.8.4', cwd: engineRoot }, { pluginRoot });
  assert.match(engine.hookSpecificOutput.additionalContext, /"projectAlias":"engine"/);
  const collection = await hookResponse({ prompt: 'h:collection quality B1 all', cwd: collectionRoot }, { pluginRoot });
  assert.match(collection.hookSpecificOutput.additionalContext, /"projectAlias":"collection"/);
  const denied = await hookResponse({ prompt: 'h:collection quality B1 all', cwd: engineRoot }, { pluginRoot });
  assert.match(denied.hookSpecificOutput.additionalContext, /不是该仓库经验证的 linked worktree/);
});

test('the same pseudo actions resolve through the explicitly selected Extension command manifest', () => {
  const defaultEngineQuality = resolveCommandIntent(cardWorldCommandManifest, { action: 'quality', target: 'V3.8.4', arguments: [] });
  assert.equal(defaultEngineQuality.preset, 'full');
  assert.equal(defaultEngineQuality.sourcePolicy, 'review-and-repair');
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
