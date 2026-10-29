import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { refreshLocalSourceRoute } from '../src/interfaces/cli/local-source-route-refresh.mjs';
import { resolveLocalSourceProjectBindingsDir } from '../integrations/codex/agent-harness-codex/hooks/local-source-route.mjs';
import { writeLocalSourceRoutes } from '../integrations/codex/agent-harness-codex/scripts/configure-local-routes.mjs';
import { makeFixture } from './test-support.mjs';

const fixture = async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const controlRoot = f.root;
  const bindingsDir = resolve(controlRoot, 'bindings');
  const childRoot = resolve(f.workspace, 'child');
  const childBindings = resolve(controlRoot, 'child-bindings');
  for (const dir of [bindingsDir, childBindings, childRoot, resolve(f.workspace, '.git')]) await mkdir(dir, { recursive: true });
  const config = { binding: { alias: 'engine', projectId: 'engine' }, revision: 1 };
  await writeFile(resolve(f.workspace, 'harness.json'), JSON.stringify(config));
  await writeFile(resolve(childRoot, 'harness.json'), JSON.stringify({ binding: { alias: 'child', projectId: 'child' } }));
  await writeFile(resolve(bindingsDir, 'bindings.json'), JSON.stringify({ harness: { controlRoot }, projects: { engine: { projectId: 'engine', workspaceRoot: f.workspace } } }));
  await writeFile(resolve(childBindings, 'bindings.json'), JSON.stringify({ harness: { controlRoot }, projects: { child: { projectId: 'child', workspaceRoot: childRoot } } }));
  await writeLocalSourceRoutes({ defaultBindingsDir: bindingsDir, routes: [
    { alias: 'engine', projectId: 'engine', projectRoot: f.workspace, bindingsDir },
    { alias: 'child', projectId: 'child', projectRoot: childRoot, bindingsDir: childBindings },
  ] });
  const inspect = () => resolveLocalSourceProjectBindingsDir({ cwd: f.workspace, projectAlias: 'engine', defaultBindingsDir: bindingsDir });
  const receipt = async () => {
    const body = { kind: 'project-initialization-receipt', mode: 'source-link', alias: 'engine', projectRoot: f.workspace,
      configPath: resolve(f.workspace, 'harness.json'), configDigest: sha256(await readFile(resolve(f.workspace, 'harness.json'))),
      hostBinding: { alias: 'engine', projectId: 'engine', workspaceRoot: f.workspace } };
    return { receipt: { ...body, receiptDigest: digestJson(body) } };
  };
  return { ...f, controlRoot, bindingsDir, config, inspect, receipt };
};

test('trusted rebind refreshes the Hook route pin and preserves unrelated child routes; later drift still blocks', async t => {
  const f = await fixture(t);
  const routeFile = resolve(f.bindingsDir, 'project-routes.json');
  const before = JSON.parse(await readFile(routeFile));
  f.config.revision = 2;
  await writeFile(resolve(f.workspace, 'harness.json'), JSON.stringify(f.config));
  await assert.rejects(f.inspect(), error => error.code === 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH'
    && error.details.field === 'configSha256');
  const initialization = await f.receipt();
  const refreshed = await refreshLocalSourceRoute({ ...f, initialization });
  assert.equal(refreshed.updated, true);
  assert.equal(await f.inspect(), f.bindingsDir);
  const after = JSON.parse(await readFile(routeFile));
  assert.deepEqual(after.entries[1], before.entries[1]);
  assert.equal((await refreshLocalSourceRoute({ ...f, initialization })).updated, false);
  await writeFile(resolve(f.workspace, 'harness.json'), JSON.stringify({ ...f.config, revision: 3 }));
  await assert.rejects(f.inspect(), { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  await assert.rejects(refreshLocalSourceRoute({ ...f, initialization }), { code: 'LOCAL_SOURCE_ROUTE_REFRESH_CONFIG_CHANGED' });
});

test('route refresh rejects forged receipt and changed project identity without overwriting the index', async t => {
  const f = await fixture(t); const routeFile = resolve(f.bindingsDir, 'project-routes.json');
  const before = await readFile(routeFile, 'utf8');
  const initialization = await f.receipt(); initialization.receipt.configDigest = 'a'.repeat(64);
  await assert.rejects(refreshLocalSourceRoute({ ...f, initialization }), { code: 'LOCAL_SOURCE_ROUTE_REFRESH_RECEIPT_INVALID' });
  await writeFile(resolve(f.workspace, 'harness.json'), JSON.stringify({ binding: { alias: 'engine', projectId: 'other' } }));
  await assert.rejects(refreshLocalSourceRoute({ ...f, initialization: await f.receipt() }), { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  assert.equal(await readFile(routeFile, 'utf8'), before);
});
