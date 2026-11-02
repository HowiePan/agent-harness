import { relative, resolve } from 'node:path';
import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertInside, assertNoLinkPath, slash } from '../common/paths.mjs';
import { inspectDeliveryPaths } from './delivery-paths.mjs';

const within = (root, path) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);

export const assertDeliveryOutputRejection = ({ feature, rejection, workspaceRoot }) => {
  const check = feature.metadata?.deliveryBatch?.checks?.find(item => item.id === rejection?.checkId);
  assert(rejection?.code === 'MANAGED_PATH_LINK_FORBIDDEN' && check
    && rejection.checkDigest === digestJson(check) && typeof rejection.path === 'string'
    && check.outputs.some(root => within(root, rejection.path)),
  'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED', 'Output rejection must bind an exact pinned delivery check and its declared output path.');
  const absolute = assertInside(workspaceRoot, resolve(workspaceRoot, rejection.path), 'rejected delivery output');
  let observed = false;
  try { assertNoLinkPath(workspaceRoot, absolute, 'delivery verification input'); }
  catch (error) {
    if (error.code !== rejection.code) throw error;
    observed = resolve(error.details.path) === absolute;
  }
  assert(observed, 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED', 'The exact output link rejection is no longer reproducible.');
  return rejection;
};

export const inspectDeliveryOutputRejection = async ({ feature, workspaceRoot, onProgress }) => {
  for (const check of feature.metadata?.deliveryBatch?.checks ?? []) {
    try { await inspectDeliveryPaths(workspaceRoot, check.outputs, onProgress); }
    catch (error) {
      if (error.code !== 'MANAGED_PATH_LINK_FORBIDDEN' || !error.details?.path) throw error;
      const rejection = { code: error.code, checkId: check.id, checkDigest: digestJson(check),
        path: slash(relative(workspaceRoot, error.details.path)) };
      return assertDeliveryOutputRejection({ feature, rejection, workspaceRoot });
    }
  }
  return null;
};
