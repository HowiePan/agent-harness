import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertPluginIntent, validatePluginInstance, validatePluginManifest } from './contracts.mjs';
import { assertAgentRuntimeLaunchCapability } from '../execution/authorization.mjs';

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
    if (plugin.manifest.kind === 'agent-runtime' && plugin.manifest.permissions.includes('process.spawn') && method === 'spawn') {
      const packet = args[0];
      const options = args[1] ?? {};
      assertAgentRuntimeLaunchCapability(options.launchCapability, {
        grantDigest: options.executionGrantDigest,
        runtimePluginId: plugin.manifest.id,
        dispatchId: packet?.dispatchId,
        packetDigest: options.packetDigest,
      });
    }
    return assertPluginIntent(await plugin.instance[method](...args));
  }

  snapshot() {
    const manifests = [...this.plugins.values()].map(plugin => plugin.manifest).sort((a, b) => a.id.localeCompare(b.id));
    return { manifests, digest: digestJson(manifests) };
  }
}
