import { scheduleFeatures } from '../../../kernel/work-graph.mjs';
import { envelope } from '../contracts.mjs';

export const createConflictScheduler = ({ manifest }) => ({
  async select(snapshot) {
    const selected = scheduleFeatures({
      features: snapshot.features,
      activeFeatureIds: snapshot.activeFeatureIds ?? [],
      limit: snapshot.limit,
      canDispatch: feature => !snapshot.deniedFeatureIds?.includes(feature.id),
    });
    return envelope(manifest, 'intent', { operation: 'schedule', featureIds: selected.map(feature => feature.id), snapshotRevision: snapshot.revision });
  },
});
