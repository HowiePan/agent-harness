import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/index.mjs';
import { configureLocalSourceRoutes, selectLocalSourceBindingsDir } from '../integrations/codex/agent-harness-codex/hooks/local-source-route.mjs';
import { writeLocalSourceRoutes } from '../integrations/codex/agent-harness-codex/scripts/configure-local-routes.mjs';

test('local source routing chooses the nearest registered project and fails closed on drift', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'local-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(root, 'repo');
  const child = resolve(repo, 'tabletop-collection');
  const controlRoot = resolve(root, 'control');
  const engineBindings = resolve(controlRoot, 'engine', '.plugin-data');
  const collectionBindings = resolve(controlRoot, 'collection', '.plugin-data');
  for (const directory of [resolve(repo, '.git'), child, engineBindings, collectionBindings]) await mkdir(directory, { recursive: true });
  const engineConfig = { binding: { alias: 'engine', projectId: 'cardworld-engine' } };
  const collectionConfig = { binding: { alias: 'collection', projectId: 'tabletop-collection' } };
  await writeFile(resolve(repo, 'harness.json'), JSON.stringify(engineConfig));
  await writeFile(resolve(child, 'harness.json'), JSON.stringify(collectionConfig));
  await writeFile(resolve(engineBindings, 'bindings.json'), JSON.stringify({ harness: { controlRoot }, projects: { engine: { projectId: 'cardworld-engine', workspaceRoot: repo } } }));
  await writeFile(resolve(collectionBindings, 'bindings.json'), JSON.stringify({ harness: { controlRoot }, projects: { collection: { projectId: 'tabletop-collection', workspaceRoot: child } } }));
  const routes = [
    { alias: 'engine', projectId: 'cardworld-engine', projectRoot: repo, bindingsDir: engineBindings },
    { alias: 'collection', projectId: 'tabletop-collection', projectRoot: child, bindingsDir: collectionBindings },
  ];
  assert.deepEqual((await writeLocalSourceRoutes({ defaultBindingsDir: engineBindings, routes })).aliases, ['engine', 'collection']);
  const choose = (cwd, prompt) => selectLocalSourceBindingsDir({ event: { cwd, prompt }, defaultBindingsDir: engineBindings });
  assert.equal(await choose(child, 'h:local collection produce B1'), collectionBindings);
  assert.equal(await choose(repo, 'h:local engine plan V3.8.5'), engineBindings);
  assert.equal(await choose(child, 'h:local engine plan V3.8.5'), engineBindings);
  await assert.rejects(() => choose(repo, 'h:local collection produce B1'), { code: 'LOCAL_SOURCE_ROUTE_ALIAS_UNKNOWN' });
  await assert.rejects(() => configureLocalSourceRoutes({ defaultBindingsDir: engineBindings, routes: [{ ...routes[1], projectId: 'wrong' }] }), { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  await writeFile(resolve(child, 'harness.json'), JSON.stringify({ binding: { alias: 'collection', projectId: 'changed' } }));
  await assert.rejects(() => choose(child, 'h:local collection produce B1'), { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  await writeFile(resolve(child, 'harness.json'), '{');
  await assert.rejects(() => choose(child, 'h:local engine plan V3.8.5'), { code: 'LOCAL_SOURCE_ROUTE_CONFIG_INVALID' });
  assert.equal(JSON.parse(await readFile(resolve(engineBindings, 'project-routes.json'), 'utf8')).entries.length, 2);
});
