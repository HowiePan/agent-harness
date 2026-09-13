import { envelope } from '../contracts.mjs';
import { assert } from '../../errors.mjs';

export const createStaticModelRouter = ({ manifest, routes, fallback }) => ({
  async route(request) {
    const route = routes.find(candidate => (candidate.roles?.includes(request.role) ?? true) && (candidate.capabilities ?? []).every(capability => request.capabilities?.includes(capability)) && Number(candidate.maxRisk ?? Infinity) >= Number(request.risk ?? 0)) ?? fallback;
    assert(route?.provider && route?.model, 'MODEL_ROUTE_NOT_CONFIGURED', 'No configured model route matches this request.', { role: request.role, capabilities: request.capabilities ?? [], risk: Number(request.risk ?? 0) });
    return envelope(manifest, 'intent', { operation: 'model-route', route: structuredClone(route), requestDigest: request.requestDigest });
  },
});
