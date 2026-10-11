import { assert } from '../common/errors.mjs';
import { slash } from '../common/paths.mjs';

const safeScopePath = value => {
  if (typeof value !== 'string' || value.includes('\\')) return null;
  const path = slash(value).replace(/\/+$/, '');
  if (!path || path.startsWith('/') || path.includes(':') || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) return null;
  return path;
};
const overlaps = (left, right) => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};
export const qualityRepairScopeCandidates = (feature, blocker) => {
  const requested = blocker?.repairCandidatePaths;
  if (feature?.metadata?.stage !== 'quality-repair' || blocker?.kind !== 'scope'
    || !Array.isArray(requested) || requested.length < 1 || requested.length > 3) return [];
  const permitted = (feature.metadata?.qualityContext?.repairScopePaths ?? []).map(safeScopePath);
  const originals = (feature.metadata?.repairFindings ?? []).flatMap(item => item.affectedPaths ?? []).map(safeScopePath);
  const candidates = requested.map(safeScopePath);
  const forbidden = (feature.forbiddenPaths ?? []).map(safeScopePath);
  const outputs = (feature.metadata?.qualityContext?.verificationOutputPaths ?? []).map(safeScopePath);
  const allowed = (feature.allowedPaths ?? []).map(safeScopePath);
  if (!permitted.length || !originals.length || [...permitted, ...originals, ...candidates, ...forbidden, ...outputs, ...allowed].some(path => !path)) return [];
  const originalRoots = new Set(originals.map(path => path.split('/')[0].toLowerCase()));
  if (!candidates.every(path => originalRoots.has(path.split('/')[0].toLowerCase())
    && permitted.some(scope => path === scope || path.startsWith(`${scope}/`))
    && !allowed.some(scope => path === scope || path.startsWith(`${scope}/`))
    && !forbidden.some(scope => overlaps(path, scope))
    && !outputs.some(output => overlaps(path, output)))) return [];
  return [...new Set(candidates)];
};

export const QUALITY_SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

export const validateFinding = finding => {
  assert(QUALITY_SEVERITIES.includes(finding.severity), 'FINDING_SEVERITY_INVALID', `Unsupported finding severity: ${finding.severity}`);
  assert(finding.id && finding.summary, 'FINDING_INVALID', 'A finding requires id and summary.');
  const list = value => [...new Set((value ?? []).map(item => String(item).replaceAll('\\', '/')))];
  return {
    id: String(finding.id),
    severity: finding.severity,
    summary: String(finding.summary),
    source: String(finding.source ?? 'review'),
    status: finding.status ?? 'open',
    featureId: finding.featureId ?? null,
    evidence: [...new Set((finding.evidence ?? []).map(String))],
    affectedPaths: list(finding.affectedPaths),
    symbols: list(finding.symbols),
    contracts: list(finding.contracts),
    generatedOutputs: list(finding.generatedOutputs),
    conflictKeys: list(finding.conflictKeys),
    evidenceRefs: [...new Set(finding.evidenceRefs ?? [])],
    resolutionEvidenceRefs: [...new Set(finding.resolutionEvidenceRefs ?? [])],
    openedAt: finding.openedAt,
    resolvedAt: finding.resolvedAt ?? null,
  };
};

export const openBlockingFindings = findings => findings.filter(finding => QUALITY_SEVERITIES.includes(finding.severity) && finding.status !== 'resolved');
export const qualityCanClose = findings => openBlockingFindings(findings).length === 0;
