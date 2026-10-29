import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { writeDevelopmentSourceManifest } from '../src/application/development-source.mjs';
import { createProjectInitializationPlan, applyProjectInitializationPlan } from '../src/application/project-initialization.mjs';
import { createLocalDevelopmentInvocation } from '../src/application/local-development-invocation.mjs';
import { syncDevelopmentSource } from '../src/interfaces/cli/local-development-sync.mjs';
import { inspectDevelopmentAmendment } from '../src/interfaces/cli/commands/plan-amendment.mjs';
import { configureBindings } from '../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs';
import { writeLocalSourceRoutes } from '../integrations/codex/agent-harness-codex/scripts/configure-local-routes.mjs';
import { resolveLocalSourceProjectBindingsDir } from '../integrations/codex/agent-harness-codex/hooks/local-source-route.mjs';
import { AuthorityStore } from '../src/kernel/authority-store.mjs';

test('official forced rebind updates the actual Hook index after harness.json changes without creating a Run', async t => {
  const controlRoot = resolve(process.cwd());
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'route-rebind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(root, 'project'); const dataRoot = resolve(root, 'data');
  await mkdir(resolve(projectRoot, '.git'), { recursive: true });
  const configPath = resolve(projectRoot, 'harness.json');
  const config = { schemaVersion: '1.0', kind: 'agent-harness-project', extensions: [
    { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
    { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' }],
  project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { gateRecipes: [], maxConcurrency: 1,
    planChangeRequests: { 'route-check': { target: 'V1.0.0', kind: 'dependency', summary: 'Route readiness check',
      requirements: ['Verify the actual Hook route'], acceptance: ['Reject stale routes'],
      amendmentScope: { version: 'plan-amendment/1', artifactRoot: 'docs/amend', featureIds: ['A01'],
        planPointers: ['/proposedFeatures/0'], documents: [] } } } } },
  binding: { alias: 'engine', projectId: 'route-rebind', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' } };
  await writeFile(configPath, JSON.stringify(config));
  const development = await writeDevelopmentSourceManifest({ bindingId: 'route-rebind', sourceRoot: controlRoot,
    controlRoot, dataRoot, configPath, projectRoot });
  const releaseIdentity = { ...development.manifest.release, verified: true, development: true };
  const plan = await createProjectInitializationPlan(configPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode: 'source-link' });
  const developmentInvocation = await createLocalDevelopmentInvocation({ projectRoot, configPath, controlRoot, dataRoot, cwd: projectRoot });
  const initialized = await applyProjectInitializationPlan(plan, { controlRoot, dataRoot, releaseIdentity, developmentInvocation, commandId: 'initial-route-rebind' });
  const host = initialized.receipt.hostBinding;
  const pluginRoot = resolve(dataRoot, 'development', 'local-codex'); const bindingsDir = resolve(pluginRoot, '.plugin-data');
  await configureBindings({ pluginRoot, controlRoot, dataRoot, entrypoint: development.manifest.entrypoint,
    developmentManifest: development.file, projectSpecs: [`${host.alias}|${host.projectId}|${host.profileId}|${host.extensionId}|${host.workspaceRoot}`],
    workflowSpecs: host.workflows.map(item => `${host.alias}|${item.id}|${item.version}|${item.artifactDigest}|${item.profileId}|${item.extensionId}`) });
  await writeLocalSourceRoutes({ defaultBindingsDir: bindingsDir, routes: [{ alias: host.alias, projectId: host.projectId, projectRoot, bindingsDir }] });
  config.project.input.maxConcurrency = 2; await writeFile(configPath, JSON.stringify(config));
  const inspect = () => resolveLocalSourceProjectBindingsDir({ cwd: projectRoot, projectAlias: host.alias, defaultBindingsDir: bindingsDir });
  await assert.rejects(inspect(), { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  await assert.rejects(inspectDevelopmentAmendment({ manifestFile: development.file, selector: 'route-check' }),
    { code: 'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH' });
  const synced = await syncDevelopmentSource(development.file, { forceRebind: true, commandId: 'refresh-route-rebind', cwd: projectRoot });
  assert(synced.initialization.receipt.configDigest);
  assert.equal(await inspect(), bindingsDir);
  const index = JSON.parse(await readFile(resolve(bindingsDir, 'project-routes.json'), 'utf8'));
  assert.equal(index.entries[0].configSha256, synced.initialization.receipt.configDigest);
  assert.equal((await new AuthorityStore({ root: dataRoot, controlRoot }).list(host.projectId)).length, 0);
});
