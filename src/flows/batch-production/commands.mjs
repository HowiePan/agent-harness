import { defineCommandManifest } from '../../platform/extensions/command-contract.mjs';

export const batchProductionCommandManifest = defineCommandManifest({
  protocolVersion: '1.0',
  id: 'batch-production-commands',
  profileId: 'batch-production',
  workflowId: 'batch-production',
  actions: {
    full: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness..release-receipt', stateChanging: true } } },
    rules: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness', stateChanging: true } } },
    launch: { targetKind: 'batch-id', presets: { default: { scope: 'batch-launch', stateChanging: true } } },
    produce: { targetKind: 'batch-id', presets: { default: { scope: 'batch-production', stateChanging: true } } },
    quality: {
      aliases: ['qa'], targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'item-harness-acceptance', stateChanging: true },
        item: { scope: 'single-item-harness-acceptance', stateChanging: true, argumentPrefix: 'item:' },
        'review-only': { scope: 'item-harness-acceptance', stateChanging: true, sourcePolicy: 'read-only' },
        'repair-known': { scope: 'item-quality-repair', stateChanging: true, sourcePolicy: 'repair' },
        closeout: { scope: 'item-quality-closeout', stateChanging: true, sourcePolicy: 'read-only' },
      },
    },
    review: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'independent-release-review', stateChanging: true, sourcePolicy: 'read-only' },
        item: { scope: 'single-item-release-review', stateChanging: true, sourcePolicy: 'read-only', argumentPrefix: 'item:' },
      },
    },
    accept: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'user-acceptance', stateChanging: true },
        item: { scope: 'single-item-user-acceptance', stateChanging: true, argumentPrefix: 'item:' },
      },
    },
    close: { targetKind: 'batch-id', presets: { default: { scope: 'batch-close..release-receipt', stateChanging: true } } },
    prerelease: { targetKind: 'batch-id', presets: { default: { scope: 'batch-release-preparation', stateChanging: true } } },
    release: { targetKind: 'batch-id', presets: { default: { scope: 'batch-release-promotion', stateChanging: true, effectClasses: ['formal-batch-release'] } } },
    status: { targetKind: 'batch-id-or-run-id', presets: { default: { scope: 'status', stateChanging: false } } },
    resume: { targetKind: 'batch-id-or-run-id', presets: { default: { scope: 'ordinary-resume', stateChanging: true } } },
    recover: {
      targetKind: 'run-id', defaultPreset: 'assess', presets: {
        assess: { scope: 'recovery-assessment', stateChanging: false },
        hard: { scope: 'hard-recovery', stateChanging: true, replayability: 'authority-only', effectClasses: ['authority-epoch-transition', 'transport-invalidation', 'completion-revalidation', 'rollback-snapshot'] },
      },
    },
  },
});
