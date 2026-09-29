import { digestJson } from '../../common/canonical.mjs';

/** Compare complete proposed Feature records while preserving both digest identities. */
export const diffPlanFeatures = (previous, current) => {
  const key = feature => `${feature.projectId}/${feature.id}`;
  const before = new Map((previous?.proposedFeatures ?? []).map(feature => [key(feature), feature]));
  const after = new Map((current?.proposedFeatures ?? []).map(feature => [key(feature), feature]));
  const changes = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldFeature = before.get(id);
    const newFeature = after.get(id);
    const disposition = !oldFeature ? 'added' : !newFeature ? 'removed'
      : digestJson(oldFeature) === digestJson(newFeature) ? 'unchanged' : 'modified';
    changes.push({ id, disposition, beforeDigest: oldFeature ? digestJson(oldFeature) : null, afterDigest: newFeature ? digestJson(newFeature) : null });
  }
  return changes;
};
