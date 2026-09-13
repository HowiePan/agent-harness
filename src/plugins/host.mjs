import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertPluginIntent, validatePluginInstance, validatePluginManifest } from './contracts.mjs';

export class PluginHost {
  constructor({ allowedPermissions = [] } = {}) {
    this.allowedPermissions = new Set(allowedPermissions);
    this.plugins = new Map();
  }

  register(manifestInput, instance) {
    const manifest = validatePluginManifest(manifestInput);
    assert(!this.plugins.has(manifest.id), 'PLUGIN_DUPLICATE', `Plugin already registered: ${manifest.id}`);
    const denied = manifest.permissions.filter(permission => !this.allowedPermissions.has(permission));
    assert(denied.length === 0, 'PLUGIN_PERMISSION_DENIED', `Plugin ${manifest.id} requests denied permissions.`, { denied });
    validatePluginInstance(manifest, instance);
    this.plugins.set(manifest.id, { manifest: Object.freeze(manifest), instance });
    return manifest;
  }

  get(id, kind = undefined) {
    const plugin = this.plugins.get(id);
    assert(plugin, 'PLUGIN_NOT_FOUND', `Plugin not found: ${id}`);
    if (kind) assert(plugin.manifest.kind === kind, 'PLUGIN_KIND_MISMATCH', `Plugin ${id} is not a ${kind}.`);
    return plugin;
  }

  async invoke(id, method, ...args) {
    const plugin = this.get(id);
    assert(typeof plugin.instance[method] === 'function', 'PLUGIN_METHOD_INVALID', `Plugin ${id} does not implement ${method}().`);
    return assertPluginIntent(await plugin.instance[method](...args));
  }

  snapshot() {
    const manifests = [...this.plugins.values()].map(plugin => plugin.manifest).sort((a, b) => a.id.localeCompare(b.id));
    return { manifests, digest: digestJson(manifests) };
  }
}
