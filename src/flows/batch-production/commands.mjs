import { defineCommandManifest } from '../../platform/extensions/command-contract.mjs';

export const tabletopCollectionCommandManifest = defineCommandManifest({
  protocolVersion: '1.0',
  id: 'batch-production-commands',
  profileId: 'collection-batch',
  workflowId: 'collection-batch-production',
  actions: {
    full: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness..release-receipt', stateChanging: true } } },
    rules: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness', stateChanging: true } } },
    launch: { targetKind: 'batch-id', presets: { default: { scope: 'batch-launch', stateChanging: true } } },
    produce: { targetKind: 'batch-id', presets: { default: { scope: 'round-production', stateChanging: true } } },
    quality: {
      aliases: ['qa'], targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'game-harness-acceptance', stateChanging: true },
        game: { scope: 'single-game-harness-acceptance', stateChanging: true, argumentPrefix: 'game:' },
      },
    },
    review: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'independent-release-review', stateChanging: true, sourcePolicy: 'read-only' },
        game: { scope: 'single-game-release-review', stateChanging: true, sourcePolicy: 'read-only', argumentPrefix: 'game:' },
      },
    },
    accept: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'user-acceptance', stateChanging: true },
        game: { scope: 'single-game-user-acceptance', stateChanging: true, argumentPrefix: 'game:' },
      },
    },
    close: { targetKind: 'batch-id', presets: { default: { scope: 'batch-close..release-receipt', stateChanging: true } } },
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
