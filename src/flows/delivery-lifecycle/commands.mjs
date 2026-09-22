import { defineCommandManifest } from '../../platform/extensions/command-contract.mjs';

export const cardWorldCommandManifest = defineCommandManifest({
  protocolVersion: '1.0',
  id: 'engine-delivery-commands',
  profileId: 'engine-delivery',
  workflowId: 'engine-delivery',
  actions: {
    full: { targetKind: 'version', presets: { default: { scope: 'requirement-intake..delivery-receipt', stateChanging: true } } },
    requirements: {
      aliases: ['req'], targetKind: 'version', defaultPreset: 'full', presets: {
        full: { scope: 'requirements..version-plan', stateChanging: true },
        'expand-to-plan': { scope: 'requirement-expansion..version-plan', stateChanging: true },
        'plan-only': { scope: 'version-planning', stateChanging: true },
      },
    },
    plan: { targetKind: 'version', presets: { default: { scope: 'version-planning', stateChanging: true } } },
    implement: { aliases: ['impl'], targetKind: 'version', presets: { default: { scope: 'implementation', stateChanging: true } } },
    scope: { targetKind: 'version', presets: { default: { scope: 'scope-resolution', stateChanging: true } } },
    quality: {
      aliases: ['qa'], targetKind: 'version', defaultPreset: 'full', presets: {
        full: { scope: 'quality', stateChanging: true, sourcePolicy: 'review-and-repair' },
        'review-only': { scope: 'quality', stateChanging: true, sourcePolicy: 'read-only' },
        recheck: { scope: 'quality-recheck', stateChanging: true, sourcePolicy: 'read-only' },
      },
    },
    docs: { targetKind: 'version', presets: { default: { scope: 'docs-closeout', stateChanging: true } } },
    review: { targetKind: 'version', presets: { default: { scope: 'user-code-review', stateChanging: true, sourcePolicy: 'read-only' } } },
    deliver: { targetKind: 'version', presets: { default: { scope: 'delivery-receipt', stateChanging: true } } },
    status: { targetKind: 'version-or-run-id', presets: { default: { scope: 'status', stateChanging: false } } },
    resume: { targetKind: 'version-or-run-id', presets: { default: { scope: 'ordinary-resume', stateChanging: true } } },
    recover: {
      targetKind: 'run-id', defaultPreset: 'assess', presets: {
        assess: { scope: 'recovery-assessment', stateChanging: false },
        hard: { scope: 'hard-recovery', stateChanging: true, replayability: 'authority-only', effectClasses: ['authority-epoch-transition', 'transport-invalidation', 'completion-revalidation', 'rollback-snapshot'] },
      },
    },
  },
});

export const deliveryLifecycleCommandManifest = cardWorldCommandManifest;
export const engineDeliveryCommandManifest = cardWorldCommandManifest;
