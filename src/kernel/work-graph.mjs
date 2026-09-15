import { assert } from '../errors.mjs';
import { EXECUTION_CLASSES, assertExecutionClass } from '../execution-boundary.mjs';
import { slash } from '../paths.mjs';

const unique = values => [...new Set(values ?? [])];
const list = value => unique(Array.isArray(value) ? value.map(String) : []);

export const normalizeFeature = feature => ({
  id: String(feature.id ?? ''),
  executionClass: String(feature.executionClass ?? ''),
  kind: String(feature.kind ?? 'implementation'),
  ownerRole: String(feature.ownerRole ?? 'worker'),
  logicalRoot: String(feature.logicalRoot ?? feature.id ?? ''),
  laneId: String(feature.laneId ?? feature.gameId ?? feature.ownerRole ?? 'default'),
  acceptance: list(feature.acceptance),
  steps: Array.isArray(feature.steps) ? feature.steps.map((step, index) => ({ id: String(step.id ?? `step-${index + 1}`), title: String(step.title ?? step.id ?? `Step ${index + 1}`) })) : [],
  dependsOn: list(feature.dependsOn),
  allowedPaths: list(feature.allowedPaths).map(slash),
  forbiddenPaths: list(feature.forbiddenPaths).map(slash),
  symbols: list(feature.symbols),
  contracts: list(feature.contracts),
  generatedOutputs: list(feature.generatedOutputs).map(slash),
  artifactInputs: list(feature.artifactInputs),
  artifactOutputs: list(feature.artifactOutputs),
  conflictKeys: list(feature.conflictKeys),
  conflictsWith: list(feature.conflictsWith),
  gatePlan: list(feature.gatePlan),
  attemptLimit: Number.isInteger(feature.attemptLimit) && feature.attemptLimit > 0 ? feature.attemptLimit : 3,
  metadata: structuredClone(feature.metadata ?? {}),
  state: feature.state ?? 'pending',
});

export const validateWorkGraph = features => {
  assert(Array.isArray(features) && features.length > 0, 'FEATURES_REQUIRED', 'A run requires at least one Feature.');
  const normalized = features.map(normalizeFeature);
  const ids = new Set();
  for (const feature of normalized) {
    assertExecutionClass(feature.executionClass, EXECUTION_CLASSES.AGENT_REASONING, { code: 'FEATURE_EXECUTION_CLASS_INVALID', subject: `Feature ${feature.id || '<unknown>'}` });
    assert(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(feature.id), 'FEATURE_ID_INVALID', `Invalid Feature ID: ${feature.id}`);
    assert(!ids.has(feature.id), 'FEATURE_ID_DUPLICATE', `Duplicate Feature ID: ${feature.id}`);
    assert(feature.acceptance.length > 0, 'FEATURE_ACCEPTANCE_REQUIRED', `Feature ${feature.id} requires acceptance criteria.`);
    assert(feature.logicalRoot, 'FEATURE_LOGICAL_ROOT_REQUIRED', `Feature ${feature.id} requires a stable logical root.`);
    ids.add(feature.id);
  }
  for (const feature of normalized) for (const dependency of feature.dependsOn) assert(ids.has(dependency), 'FEATURE_DEPENDENCY_UNKNOWN', `Feature ${feature.id} depends on unknown Feature ${dependency}.`);
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    assert(!visiting.has(id), 'FEATURE_GRAPH_CYCLE', `Feature dependency cycle includes ${id}.`);
    visiting.add(id);
    for (const dependency of normalized.find(feature => feature.id === id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return normalized;
};

const intersects = (left, right) => left.some(value => right.includes(value));
const pathOverlap = (left, right) => {
  const a = slash(left).replace(/\/$/, '');
  const b = slash(right).replace(/\/$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export const featuresConflict = (left, right) => {
  if (left.id === right.id) return false;
  if (left.dependsOn.includes(right.id) || right.dependsOn.includes(left.id)) return true;
  if (left.conflictsWith.includes(right.id) || right.conflictsWith.includes(left.id)) return true;
  if (intersects(left.conflictKeys, right.conflictKeys)) return true;
  if (intersects(left.symbols, right.symbols) || intersects(left.contracts, right.contracts)) return true;
  if (intersects(left.artifactOutputs, [...right.artifactInputs, ...right.artifactOutputs]) || intersects(right.artifactOutputs, left.artifactInputs)) return true;
  const leftPaths = [...left.allowedPaths, ...left.generatedOutputs];
  const rightPaths = [...right.allowedPaths, ...right.generatedOutputs];
  return leftPaths.some(a => rightPaths.some(b => pathOverlap(a, b)));
};

export const dependencySatisfied = (feature, features) => feature.dependsOn.every(id => features.find(candidate => candidate.id === id)?.state === 'completed');

const roundRobin = features => {
  const lanes = new Map();
  for (const feature of features) lanes.set(feature.laneId, [...(lanes.get(feature.laneId) ?? []), feature]);
  const output = [];
  while (lanes.size) {
    for (const [lane, values] of [...lanes]) {
      output.push(values.shift());
      if (!values.length) lanes.delete(lane);
    }
  }
  return output;
};

export const scheduleFeatures = ({ features, activeFeatureIds = [], limit, canDispatch = () => true, candidateFeatureIds = null }) => {
  const active = activeFeatureIds.map(id => features.find(feature => feature.id === id)).filter(Boolean);
  const eligible = features.filter(feature => ['pending', 'ready'].includes(feature.state) && dependencySatisfied(feature, features) && canDispatch(feature));
  const candidates = candidateFeatureIds ? candidateFeatureIds.map(id => eligible.find(feature => feature.id === id)).filter(Boolean) : roundRobin(eligible);
  const selected = [];
  for (const feature of candidates) {
    if (selected.length >= limit) break;
    if ([...active, ...selected].some(other => featuresConflict(feature, other))) continue;
    selected.push(feature);
  }
  return selected;
};
