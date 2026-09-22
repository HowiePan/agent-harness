import { deliveryNode } from '../node.mjs';

export const planNode = deliveryNode('plan', 'plan', 'version-planning', ['canonical'], {
  acceptance: ['Generate deterministic feature plan and dependency graph for the targeted release.'],
});

export const planNodes = [planNode];
