import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

const safe = value => String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || digestJson(value).slice(0, 12);
const relativeOutput = path => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('..') && !path.includes('\\');

/** Neutral reference node template. Business behavior remains in declarative nodes. */
export const createReferenceFeature = ({ context, node, item, dependsOn }) => {
  const input = context.intent.workflowInput ?? {};
  const outputPath = node.outputKey ? input.outputPaths?.[node.outputKey] : null;
  if (node.outputKey) assert(relativeOutput(outputPath), 'WORKFLOW_OUTPUT_PATH_INVALID', `Missing safe output path: ${node.outputKey}`);
  const itemId = item?.sourceId ?? item?.id ?? item;
  const sourceIds = item?.sourceId ? [item.sourceId] : node.readAllSources ? (input.sourceManifest?.sources ?? []).map(source => source.sourceId) : node.sourceType ? (input.sourceManifest?.sources ?? []).filter(source => source.type === node.sourceType).map(source => source.sourceId) : [];
  return {
    id: `${node.id}/${safe(context.intent.target)}${itemId ? `/${safe(itemId)}` : ''}`,
    executionClass: 'agent-reasoning', kind: node.kind ?? node.id,
    ownerRole: node.role ?? 'analyst', logicalRoot: `${node.id}:${context.intent.target}`, laneId: itemId ? safe(itemId) : node.id,
    acceptance: structuredClone(node.acceptance ?? [`Complete ${node.id} for ${context.intent.target} with cited evidence and a structured result.`]),
    steps: [{ id: 'execute', title: `Complete ${node.id}.` }], dependsOn,
    allowedPaths: outputPath ? [outputPath] : [], forbiddenPaths: ['.git', '.agent-harness-data'],
    conflictKeys: outputPath ? [`output:${outputPath}`] : [], gatePlan: [],
    metadata: { stage: node.id, target: context.intent.target, sourcePolicy: outputPath ? 'write' : 'read-only',
      sourceIds, outputPath, outputPorts: structuredClone(node.outputPorts ?? {}), outputValueSchemas: structuredClone(node.outputValueSchemas ?? {}), outputChecks: structuredClone(node.outputChecks ?? []),
      questionRevision: input.questionRevision ?? null,
      sourceManifestDigest: input.sourceManifest?.manifestDigest ?? null,
      memorySnapshotDigest: digestJson(input.memorySnapshot ?? []),
      ...(node.id === 'lookup' ? { expectedHit: (input.memorySnapshot ?? []).some(record => record.status === 'verified' && record.validity === 'current' && record.kind !== 'negative' && !(input.memorySnapshot ?? []).some(rejected => rejected.kind === 'negative' && rejected.validity === 'current' && rejected.topic === digestJson(record.claim))) } : {}),
    },
  };
};
