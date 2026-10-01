import { createDeliveryTemplates } from '../../../../src/flows/delivery-lifecycle/nodes/delivery/feature.mjs';

const implementationAllowedPaths = Object.freeze([
  'card_world_engine',
  'card_world_web/src', 'card_world_web/tests', 'card_world_web/public/wasm',
  'card_world_web/package.json', 'card_world_web/yarn.lock', 'card_world_web/vite.config.ts',
  'scripts', 'docs/versions', 'docs/schemas', 'docs/integration_guide.md',
  'docs/benchmarks.md', 'docs/requirements.md', 'docs/project_plan.md', 'docs/engine_design', 'CHANGELOG.md',
]);
export const CARDWORLD_ACTION_PATHS = Object.freeze({
  requirements: ['docs/requirements.md', 'docs/versions'],
  plan: ['docs/versions', 'docs/requirements.md'],
  implement: [...implementationAllowedPaths],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
  review: [], deliver: [],
});

export const engineTemplates = createDeliveryTemplates({
  actionPaths: CARDWORLD_ACTION_PATHS,
  qualityRootPrefix: 'engine',
  forbiddenPaths: ['.git', '.agent-harness-data'],
});
