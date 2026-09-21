import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertQualityInventorySnapshot } from './quality-target.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const safePath = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(part => part === '..' || part === '.');

export const sealKnownFindingInventory = ({ projectId, target, declaration, snapshot }) => {
  assert(typeof projectId === 'string' && projectId.length > 0 && typeof target === 'string' && target.length > 0 && digestPattern.test(snapshot?.digest ?? '') && Array.isArray(snapshot?.files), 'QUALITY_FINDING_INVENTORY_INVALID', 'Known Finding inventory requires a project, target, and source snapshot.');
  assert(declaration?.version === '1.0' && Array.isArray(declaration.sources) && declaration.sources.length > 0 && Array.isArray(declaration.findings), 'QUALITY_FINDING_INVENTORY_REQUIRED', 'Quality planning requires a versioned known Finding inventory with pinned sources.');
  const sources = declaration.sources.map(source => {
    assert(safePath(source?.path) && digestPattern.test(source?.sha256 ?? ''), 'QUALITY_FINDING_INVENTORY_SOURCE_INVALID', 'Known Finding source requires a safe path and SHA-256 digest.');
    const file = snapshot.files.find(item => item.path === source.path);
    assert(file?.sha256 === source.sha256, 'QUALITY_FINDING_INVENTORY_SOURCE_DRIFT', `Known Finding source changed or is missing: ${source.path}`);
    return { path: source.path, sha256: source.sha256 };
  });
  assert(new Set(sources.map(source => source.path)).size === sources.length, 'QUALITY_FINDING_INVENTORY_SOURCE_DUPLICATE', 'Known Finding source paths must be unique.');
  const sourcePaths = new Set(sources.map(source => source.path));
  const ids = new Set();
  const aliases = new Set();
  const findings = declaration.findings.map(item => {
    assert(typeof item?.id === 'string' && item.id.length > 0 && ['P0', 'P1', 'P2', 'P3'].includes(item.severity) && sourcePaths.has(item.sourcePath), 'QUALITY_FINDING_INVENTORY_ITEM_INVALID', 'Known Finding requires a canonical ID, P0-P3 severity, and pinned source path.');
    assert(!ids.has(item.id), 'QUALITY_FINDING_INVENTORY_ITEM_DUPLICATE', `Known Finding ID is duplicated: ${item.id}`);
    ids.add(item.id);
    const itemAliases = item.aliases ?? [];
    assert(Array.isArray(itemAliases) && itemAliases.every(alias => typeof alias === 'string' && alias.length > 0 && alias !== item.id && !aliases.has(alias)), 'QUALITY_FINDING_INVENTORY_ALIAS_INVALID', 'Known Finding aliases must be unique and explicit.');
    itemAliases.forEach(alias => aliases.add(alias));
    return { id: item.id, severity: item.severity, sourcePath: item.sourcePath, aliases: [...itemAliases].sort() };
  });
  assert([...aliases].every(alias => !ids.has(alias)), 'QUALITY_FINDING_INVENTORY_ALIAS_INVALID', 'An alias cannot equal another canonical Finding ID.');
  const body = { version: '1.0', projectId, target, sourceDigest: snapshot.digest, sources: sources.sort((a, b) => a.path.localeCompare(b.path)), findings: findings.sort((a, b) => a.id.localeCompare(b.id)) };
  return Object.freeze({ ...body, inventoryDigest: digestJson(body) });
};

export const sealLegacyFindingInventory = ({ projectId, target, declaration }) => {
  assert(declaration?.version === '1.0' && Array.isArray(declaration.sources) && declaration.sources.length > 0, 'QUALITY_FINDING_INVENTORY_REQUIRED', 'Legacy quality migration requires a versioned inventory declaration with pinned sources.');
  return sealKnownFindingInventory({
    projectId,
    target,
    declaration,
    snapshot: {
      digest: digestJson({ kind: 'legacy-project-inventory-source', projectId, target, sources: declaration.sources }),
      files: declaration.sources.map(source => ({ path: source.path, sha256: source.sha256 })),
    },
  });
};

export const assertKnownFindingInventory = inventory => {
  if (inventory?.version === '2.0') return assertQualityInventorySnapshot(inventory);
  assert(inventory?.version === '1.0' && digestPattern.test(inventory?.sourceDigest ?? '') && Array.isArray(inventory?.sources) && Array.isArray(inventory?.findings), 'QUALITY_FINDING_INVENTORY_INVALID', 'Known Finding inventory is invalid.');
  const { inventoryDigest, ...body } = inventory;
  assert(inventoryDigest === digestJson(body), 'QUALITY_FINDING_INVENTORY_DIGEST_MISMATCH', 'Known Finding inventory digest does not match its contents.');
  const canonical = sealKnownFindingInventory({
    projectId: inventory.projectId, target: inventory.target,
    declaration: { version: inventory.version, sources: inventory.sources, findings: inventory.findings },
    snapshot: { digest: inventory.sourceDigest, files: inventory.sources },
  });
  assert(inventoryDigest === canonical.inventoryDigest, 'QUALITY_FINDING_INVENTORY_INVALID', 'Known Finding inventory is not canonical.');
  return inventory;
};

export const assertKnownFindingDispositions = (result, inventory) => {
  assertKnownFindingInventory(inventory);
  if (result.status !== 'completed') return result;
  const dispositions = result.knownFindingDispositions;
  assert(Array.isArray(dispositions), 'QUALITY_FINDING_INVENTORY_INCOMPLETE', 'Completed quality review must return known Finding dispositions.');
  const expected = new Map(inventory.findings.map(item => [item.id, item]));
  const actual = new Set();
  for (const item of dispositions) {
    assert(expected.has(item?.id) && !actual.has(item.id) && ['open', 'not-reproduced'].includes(item.disposition) && Array.isArray(item.evidence) && item.evidence.length > 0, 'QUALITY_FINDING_INVENTORY_INCOMPLETE', 'Known Finding disposition is missing, duplicated, unknown, or unsupported.');
    actual.add(item.id);
    const finding = (result.findings ?? []).find(candidate => candidate.id === item.id);
    assert(item.disposition !== 'open' || (finding?.severity === expected.get(item.id).severity && Array.isArray(finding.evidence) && finding.evidence.length > 0), 'QUALITY_FINDING_INVENTORY_INCOMPLETE', `Open known Finding lacks a matching evidence-backed Finding: ${item.id}`);
    assert(item.disposition !== 'not-reproduced' || !finding, 'QUALITY_FINDING_INVENTORY_INCOMPLETE', `Known Finding cannot be both open and not reproduced: ${item.id}`);
  }
  assert(actual.size === expected.size, 'QUALITY_FINDING_INVENTORY_INCOMPLETE', 'Completed quality review omitted known Finding dispositions.', { missing: [...expected.keys()].filter(id => !actual.has(id)) });
  return result;
};
