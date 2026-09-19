import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';

const idPattern = /^[a-z][a-z0-9.-]*$/;
const versionPattern = /^\d+\.\d+\.\d+$/;

/** A workflow is immutable data. Template implementations belong to an approved Extension. */
export const defineWorkflowDefinition = input => {
  if (input?.artifactDigest) {
    const { artifactDigest, ...body } = input;
    assert(artifactDigest === digestJson(body), 'WORKFLOW_DIGEST_MISMATCH', 'Workflow Definition digest changed.');
    return Object.freeze(structuredClone(input));
  }
  assert(idPattern.test(input?.id ?? ''), 'WORKFLOW_ID_INVALID', 'Workflow requires a stable ID.');
  assert(versionPattern.test(input?.version ?? ''), 'WORKFLOW_VERSION_INVALID', 'Workflow requires a semantic version.');
  assert(input?.profileId && idPattern.test(input.profileId), 'WORKFLOW_PROFILE_INVALID', 'Workflow requires a Profile ID.');
  assert(input?.routes && typeof input.routes === 'object' && !Array.isArray(input.routes), 'WORKFLOW_ROUTES_REQUIRED', 'Workflow requires routes.');
  for (const [routeId, nodes] of Object.entries(input.routes)) {
    assert(idPattern.test(routeId) && Array.isArray(nodes) && nodes.length, 'WORKFLOW_ROUTE_INVALID', `Invalid workflow route: ${routeId}`);
    const known = new Set();
    for (const node of nodes) {
      assert(idPattern.test(node?.id ?? '') && idPattern.test(node?.template ?? ''), 'WORKFLOW_NODE_INVALID', `Invalid node in ${routeId}.`);
      assert(!known.has(node.id), 'WORKFLOW_NODE_DUPLICATE', `Duplicate node ${node.id}.`);
      assert(node.forEach === undefined || idPattern.test(node.forEach), 'WORKFLOW_FANOUT_INVALID', 'Node fan-out requires a named item collection.');
      for (const dependency of node.dependsOn ?? []) assert(known.has(dependency), 'WORKFLOW_DEPENDENCY_INVALID', `Node ${node.id} depends on a missing or later node ${dependency}.`);
      known.add(node.id);
    }
  }
  const body = structuredClone(input);
  const definition = { ...body, schemaVersion: '1.0', artifactDigest: digestJson({ ...body, schemaVersion: '1.0' }) };
  return Object.freeze(definition);
};

/** Deterministically expand a route into a validated Feature DAG. */
export const compileWorkflowFeatures = ({ definition, routeId, templates, context, items = { item: [null] } }) => {
  const { artifactDigest, ...definitionBody } = definition ?? {};
  assert(artifactDigest === digestJson(definitionBody), 'WORKFLOW_DIGEST_MISMATCH', 'Workflow Definition digest changed.');
  const route = definition.routes[routeId];
  assert(route, 'WORKFLOW_ROUTE_UNKNOWN', `Unknown workflow route: ${routeId}`);
  const collections = Array.isArray(items) ? { item: items } : items;
  assert(collections && typeof collections === 'object' && Object.values(collections).every(values => Array.isArray(values) && values.length > 0 && values.length <= 100 && new Set(values.map(item => JSON.stringify(item))).size === values.length), 'WORKFLOW_FANOUT_BUDGET', 'Workflow item fan-out must be unique and at most 100.');
  const emitted = new Map();
  const features = [];
  for (const node of route) {
    const template = templates[node.template];
    assert(typeof template === 'function', 'WORKFLOW_TEMPLATE_MISSING', `Missing node template: ${node.template}`);
    const nodeItems = node.forEach ? collections[node.forEach] : [null];
    assert(Array.isArray(nodeItems) && nodeItems.length > 0, 'WORKFLOW_FANOUT_INPUT_MISSING', `Missing item collection ${node.forEach}.`);
    const entries = [];
    for (let index = 0; index < nodeItems.length; index += 1) {
      const item = nodeItems[index];
      const dependencies = (node.dependsOn ?? []).flatMap(id => {
        const prior = emitted.get(id);
        assert(prior, 'WORKFLOW_DEPENDENCY_INVALID', `Unresolved dependency ${id}.`);
        if (prior.length === 1) return [prior[0].id];
        if (node.forEach && route.find(candidate => candidate.id === id)?.forEach === node.forEach) return [prior[index].id];
        return prior.map(entry => entry.id);
      });
      const feature = template({ context: structuredClone(context), node: structuredClone(node), item: structuredClone(item), index, dependsOn: [...new Set(dependencies)] });
      assert(feature?.executionClass === 'agent-reasoning', 'WORKFLOW_TEMPLATE_FEATURE_INVALID', `Template ${node.template} must return an Agent Feature.`);
      feature.dependsOn = [...new Set(dependencies)];
      feature.metadata = { ...(feature.metadata ?? {}), workflow: { id: definition.id, version: definition.version, artifactDigest: definition.artifactDigest, nodeId: node.id, templateId: node.template } };
      entries.push(feature);
      features.push(feature);
    }
    emitted.set(node.id, entries);
  }
  return validateWorkGraph(features);
};
