export const node = (id, dependsOn = [], options = {}) => ({ id, template: 'reference-feature', dependsOn, ...options });
