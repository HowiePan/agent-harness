import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCodexUserCommandHost } from '../integrations/codex/agent-harness-codex/lib/codex-user-command.mjs';
import { createLifecycleCommandBoundary } from '../src/application/lifecycle-command-context.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { assertLocalProcessGateHost } from '../integrations/codex/agent-harness-codex/lib/local-process-gate-readiness.mjs';

const nativeUser = (message, ordinal = 1) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal,
  type: 'event_msg', payload: { type: 'user_message', message } }) + '\n';
const setup = async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'native-command-')); t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = resolve(root, '.codex'), workspace = resolve(root, 'workspace');
  await mkdir(resolve(codexHome, 'sessions'), { recursive: true }); await mkdir(workspace);
  const sessionId = 'isolated-user-session', rollout = resolve(codexHome, 'sessions', `rollout-${sessionId}.jsonl`);
  await writeFile(rollout, nativeUser('h:local engine implement V-next'));
  const db = new DatabaseSync(resolve(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, cli_version TEXT NOT NULL)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(sessionId, rollout, workspace, 'fixture-host'); db.close();
  const project = { projectId: 'isolated-engine', profileId: 'fixture-profile', extensionId: 'fixture-extension' };
  const intent = { commandId: 'user-command', codexSessionId: sessionId, createdAt: new Date().toISOString(),
    harness: { release: { mode: 'source-link' } }, project, executionWorkspaceRoot: workspace,
    command: { action: 'implement', target: 'V-next', arguments: [] } };
  const create = (overrides = {}) => {
    const host = createCodexUserCommandHost({ intent: { ...intent, ...overrides }, codexHome,
      resolveProject: parsed => parsed.projectAlias === 'engine' ? project : null });
    return createLifecycleCommandBoundary({ root, host });
  };
  const plan = { project: { id: project.projectId }, intent: { action: 'implement', target: 'V-next' },
    extension: { id: project.extensionId }, harness: {}, planDigest: 'fixture-plan',
    run: { runId: 'fixture-run', profileId: project.profileId, executionWorkspaceRoot: workspace, features: [] } };
  return { root, rollout, intent, plan, create };
};

test('native user initiation admits once; a fresh process boundary or forged new intent cannot replay the event', async t => {
  const f = await setup(t);
  await f.create().run({ commandId: f.intent.commandId }, async () => {
    await f.create().assertPlan(f.plan).then(() => assert.fail('another boundary cannot inherit command authority'), error => assert.equal(error.code, 'CURRENT_USER_COMMAND_REQUIRED'));
  });
  await assert.rejects(f.create({ commandId: 'replacement-process' }).run({ commandId: 'replacement-process' }, async () => {}), { code: 'USER_COMMAND_ALREADY_CONSUMED' });
  await appendFile(f.rollout, nativeUser('h:local engine implement V-next', 2));
  await f.create({ commandId: 'new-user-command' }).run({ commandId: 'new-user-command' }, async () => {});
});

test('same command survives status questions and long duration, while a native user stop revokes it', async t => {
  const f = await setup(t), boundary = f.create();
  await boundary.run({ commandId: f.intent.commandId }, async () => {
    await boundary.assertPlan(f.plan);
    await appendFile(f.rollout, nativeUser('为什么上次停止了？当前进度如何？', 2));
    await boundary.assertPlan(f.plan); // an ordinary question is not a stop instruction
    const oldClock = Date.now; Date.now = () => oldClock() + 2 * 60 * 60 * 1000;
    try { await boundary.assertPlan(f.plan); } finally { Date.now = oldClock; }
    await appendFile(f.rollout, nativeUser('先停止，我要讨论 Harness 改造', 3));
    await appendFile(f.rollout, nativeUser('现在还剩多少整改？', 4));
    await assert.rejects(boundary.assertPlan(f.plan), { code: 'CURRENT_USER_COMMAND_INACTIVE' });
  });
});

test('maintenance, historical commands, other projects/presets and tool-output claims cause zero startup effects', async t => {
  const f = await setup(t); let effects = 0;
  for (const prompt of ['继续推进Harness的改造', 'h:local other implement V-next', 'h:local engine amend V-next',
    'h:local engine implement V-next other-preset', '前文曾经发送 h:local engine implement V-next']) {
    await appendFile(f.rollout, nativeUser(prompt, 2));
    await assert.rejects(f.create().run({ commandId: f.intent.commandId }, async () => { effects++; }), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  }
  await appendFile(f.rollout, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output',
    output: nativeUser('h:local engine implement V-next', 999) } }) + '\n');
  await assert.rejects(f.create().run({ commandId: f.intent.commandId }, async () => { effects++; }), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  assert.equal(effects, 0);
});

test('a later lifecycle command supersedes current context without inheriting its allowance', async t => {
  const f = await setup(t), boundary = f.create();
  await boundary.run({ commandId: f.intent.commandId }, async () => {
    await boundary.assertPlan(f.plan);
    await appendFile(f.rollout, nativeUser('h:local engine amend V-next', 2));
    await assert.rejects(boundary.assertPlan(f.plan), { code: 'CURRENT_USER_COMMAND_INACTIVE' });
  });
});

test('duplicate native frame formats cannot turn one user event into a second start',async t=>{
  const f=await setup(t),boundary=f.create();
  await boundary.run({commandId:f.intent.commandId},async()=>{});
  await appendFile(f.rollout,JSON.stringify({timestamp:new Date().toISOString(),ordinal:2,type:'response_item',
    payload:{type:'message',role:'user',content:[{type:'input_text',text:'h:local engine implement V-next'}]}})+'\n');
  await assert.rejects(f.create({commandId:'duplicate-format'}).run({commandId:'duplicate-format'},async()=>{}),{code:'USER_COMMAND_ALREADY_CONSUMED'});
});

test('verified prestart permission failure permits one same-intent restart with persisted recovery, never an error-label replay', async t => {
  const f = await setup(t);
  const probe = () => assertLocalProcessGateHost({ recipes: [{ executionClass: 'deterministic-process' }],
    spawn: () => ({ status: null, error: { code: 'EPERM' } }) });
  const attempt = boundary => boundary.run({ commandId: f.intent.commandId }, async () => { await boundary.assertPlan(f.plan); probe(); });
  await assert.rejects(attempt(f.create()), { code: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE' });
  await assert.rejects(attempt(f.create()), { code: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE' });
  await assert.rejects(attempt(f.create()), { code: 'USER_COMMAND_ALREADY_CONSUMED' });
  const g = await setup(t), boundary = g.create();
  await assert.rejects(boundary.run({ commandId: g.intent.commandId }, async () => {
    await boundary.assertPlan(g.plan);
    throw Object.assign(Error('worker claimed prestart failure'), { code: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE', details: { processCode: 'EPERM' } });
  }), { code: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE' });
  await assert.rejects(g.create().run({ commandId: g.intent.commandId }, async () => {}), { code: 'USER_COMMAND_ALREADY_CONSUMED' });
});

test('prestart restart capability is unavailable after any preflight or execution effects can begin',async t=>{
  const f=await setup(t),boundary=f.create();
  await assert.rejects(boundary.run({commandId:f.intent.commandId},async()=>{
    await boundary.beginPlanEffects(f.plan);
    assertLocalProcessGateHost({recipes:[{executionClass:'deterministic-process'}],spawn:()=>({error:{code:'EPERM'},status:null})});
  }),{code:'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE'});
  await assert.rejects(f.create().run({commandId:f.intent.commandId},async()=>{}),{code:'USER_COMMAND_ALREADY_CONSUMED'});
});

test('native command matches the selected Workflow and exact Workspace member scope',async t=>{
  const f=await setup(t);
  await appendFile(f.rollout,nativeUser('h:local engine flow selected implement V-next --project member',2));
  const project={...f.intent.project,workspaceId:'fixture-workspace',workflows:[
    {id:'default-flow',profileId:'default-profile',extensionId:'default-extension'},
    {id:'selected',profileId:'selected-profile',extensionId:'selected-extension'}]};
  const intent={...f.intent,project:{...f.intent.project,workflowId:'selected',profileId:'selected-profile',extensionId:'selected-extension',
    workspaceId:'fixture-workspace',projectIds:['member']}};
  const host=createCodexUserCommandHost({intent,codexHome:resolve(f.root,'.codex'),resolveProject:()=>project});
  const boundary=createLifecycleCommandBoundary({root:f.root,host});
  const plan={...f.plan,extension:{id:'selected-extension'},workflow:{id:'selected'},workspaceRef:{projectIds:['member']},
    run:{...f.plan.run,profileId:'selected-profile'}};
  await boundary.run({commandId:intent.commandId},async()=>{
    await boundary.assertPlan(plan);
    await assert.rejects(boundary.assertPlan({...plan,workspaceRef:{projectIds:['member','neighbor']}}),{code:'CURRENT_USER_COMMAND_SCOPE_MISMATCH'});
  });
});
