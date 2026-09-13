export const manifest = { id: 'external-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: ['external'], permissions: [] };
export const createPlugin = async config => ({
  async select(snapshot) { return { type: 'intent', pluginId: manifest.id, pluginVersion: manifest.version, payload: { featureIds: snapshot.features.slice(0, config.limit ?? 1).map(feature => feature.id) } }; },
});
