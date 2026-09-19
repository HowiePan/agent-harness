import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { defineMemorySpace } from '../resources/memory/memory-store.mjs';

export const REFERENCE_MEMORY_PROVIDER = Object.freeze({ id: 'reference-memory-store', version: '1.0.0', artifactDigest: digestJson({ id: 'reference-memory-store', version: '1.0.0', contract: 'workspace-resource-provider-v1' }) });

/** Provider methods return values or receipts; they never mutate Kernel Authority. */
export class ResourceProviderRegistry {
  constructor({ memoryStore }) {
    this.providers = new Map();
    this.register(REFERENCE_MEMORY_PROVIDER, {
      resolveSpace: ({ binding, workspaceRef, projectId, sessionId }) => defineMemorySpace({
        scope: { workspace: 'common', project: 'project', workflow: 'workflow', source: 'source', session: 'session' }[binding.scope],
        domainId: `workspace:${workspaceRef.workspaceId}:resource:${binding.id}`,
        projectId,
        ...(binding.scope === 'workflow' || binding.scope === 'source' || binding.scope === 'session' ? { workflowId: binding.workflowId } : {}),
        ...(binding.scope === 'source' ? { sourceId: binding.sourceId } : {}),
        ...(binding.scope === 'session' ? { sessionId } : {}),
      }),
      query: args => memoryStore.query(args),
      read: space => memoryStore.read(space),
    });
  }

  register(ref, implementation) {
    assert(ref?.id && /^\d+\.\d+\.\d+$/.test(ref.version ?? '') && /^[a-f0-9]{64}$/.test(ref.artifactDigest ?? '') && implementation && typeof implementation === 'object', 'RESOURCE_PROVIDER_INVALID', 'Resource Provider requires exact identity and operations.');
    assert(!this.providers.has(ref.id), 'RESOURCE_PROVIDER_DUPLICATE', `Resource Provider ${ref.id} is already installed.`);
    this.providers.set(ref.id, { ref: structuredClone(ref), implementation });
  }

  resolve(binding) {
    const provider = this.providers.get(binding.providerRef?.id);
    assert(provider && digestJson(provider.ref) === digestJson(binding.providerRef), 'RESOURCE_PROVIDER_IDENTITY_MISMATCH', `Resource Provider ${binding.providerRef?.id} is not installed at the bound version and digest.`);
    return provider.implementation;
  }
}
