import { createDeliveryTemplates } from '../../nodes/delivery/feature.mjs';

const qualityAllowedPaths = Object.freeze([
  'card_world_engine/src', 'card_world_engine/tests', 'card_world_engine/Cargo.toml', 'card_world_engine/Cargo.lock',
  'card_world_web/src', 'card_world_web/tests', 'docs/versions/v3/v3.8.4.md', 'docs/versions/INDEX.md', 'docs/integration_guide.md',
]);
const actionPaths = Object.freeze({
  requirements: ['docs/requirements.md', 'docs/versions'],
  plan: ['docs/versions', 'docs/requirements.md'],
  implement: [...qualityAllowedPaths],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
  review: [], deliver: [],
});

export const engineTemplates = createDeliveryTemplates({
  actionPaths, qualityRootPrefix: 'engine',
  forbiddenPaths: ['.git', '.agent-harness-data', '.cardworld-local', 'F:/agent-harness'],
});
