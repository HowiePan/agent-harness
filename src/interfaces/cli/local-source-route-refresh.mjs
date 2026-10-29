import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertNoLinkPath } from '../../common/paths.mjs';
import { atomicWriteJson, withDirectoryLock } from '../../kernel/atomic-io.mjs';

const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** Refresh only an existing, identity-matched route after verified project initialization. */
export const refreshLocalSourceRoute = async ({ bindingsDir, controlRoot, initialization }) => {
  const routeFile = assertNoLinkPath(controlRoot, resolve(bindingsDir, 'project-routes.json'), 'local source route');
  try { await readFile(routeFile); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const receipt = initialization?.receipt;
  assert(receipt?.kind === 'project-initialization-receipt' && receipt.mode === 'source-link'
    && receipt.receiptDigest === digestJson(withoutKeys(receipt, ['receiptDigest']))
    && receipt.alias === receipt.hostBinding?.alias
    && samePath(receipt.configPath, resolve(receipt.projectRoot, 'harness.json')),
  'LOCAL_SOURCE_ROUTE_REFRESH_RECEIPT_INVALID', 'Route refresh requires an exact project initialization receipt.');
  return withDirectoryLock(`${routeFile}.lock`, async () => {
    const index = JSON.parse(await readFile(routeFile, 'utf8'));
    assert(index.schemaVersion === '1.0' && index.kind === 'local-source-routes'
      && samePath(await realpath(index.controlRoot), await realpath(controlRoot)) && Array.isArray(index.entries),
    'LOCAL_SOURCE_ROUTE_INDEX_INVALID', 'Route refresh requires the registered control boundary.');
    const matches = index.entries.filter(item => item.alias === receipt.alias && samePath(item.projectRoot, receipt.projectRoot));
    assert(matches.length === 1 && matches[0].projectId === receipt.hostBinding.projectId
      && samePath(matches[0].bindingsDir, bindingsDir),
    'LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH', 'A refresh cannot add, redirect or reidentify a route.');
    const selected = matches[0];
    const { configureLocalSourceRoutes } = await import('../../../integrations/codex/agent-harness-codex/hooks/local-source-route.mjs');
    const verified = await configureLocalSourceRoutes({ defaultBindingsDir: bindingsDir, routes: [selected] });
    const next = verified.entries[0];
    assert(next.configSha256 === receipt.configDigest, 'LOCAL_SOURCE_ROUTE_REFRESH_CONFIG_CHANGED',
      'Configuration changed after the trusted project rebind.');
    const previousConfigSha256 = selected.configSha256;
    if (previousConfigSha256 !== next.configSha256) {
      selected.configSha256 = next.configSha256;
      await atomicWriteJson(routeFile, index, { root: controlRoot });
    }
    return { routeFile, alias: receipt.alias, previousConfigSha256, configSha256: next.configSha256,
      updated: previousConfigSha256 !== next.configSha256 };
  }, { root: controlRoot });
};
