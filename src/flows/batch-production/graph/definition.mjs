import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';

const collectionNode = (id, action, dependsOn = [], options = {}) => ({ id, template: 'collection-stage', action, forEach: 'item', dependsOn, ...options });
export const collectionWorkflowDefinition = defineWorkflowDefinition({
  id: 'collection-batch-production', version: '1.0.0', profileId: 'collection-batch',
  routes: {
    full: [collectionNode('rules', 'rules'), collectionNode('produce', 'produce', ['rules']), collectionNode('quality', 'quality', ['produce'], { qualityReview: true }), collectionNode('review', 'review', ['quality'], { readOnly: true }), collectionNode('accept', 'accept', ['review'], { readOnly: true })],
    rules: [collectionNode('rules', 'rules')], launch: [collectionNode('launch', 'launch', [], { readOnly: true })],
    produce: [collectionNode('produce', 'produce')], quality: [collectionNode('quality', 'quality', [], { qualityReview: true })],
    review: [collectionNode('review', 'review', [], { readOnly: true })], accept: [collectionNode('accept', 'accept', [], { readOnly: true })],
    close: [collectionNode('close', 'close', [], { readOnly: true })],
  },
});
