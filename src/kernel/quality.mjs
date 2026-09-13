import { assert } from '../errors.mjs';

export const QUALITY_SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

export const validateFinding = finding => {
  assert(QUALITY_SEVERITIES.includes(finding.severity), 'FINDING_SEVERITY_INVALID', `Unsupported finding severity: ${finding.severity}`);
  assert(finding.id && finding.summary, 'FINDING_INVALID', 'A finding requires id and summary.');
  return {
    id: String(finding.id),
    severity: finding.severity,
    summary: String(finding.summary),
    source: String(finding.source ?? 'review'),
    status: finding.status ?? 'open',
    featureId: finding.featureId ?? null,
    evidence: [...new Set((finding.evidence ?? []).map(String))],
    evidenceRefs: [...new Set(finding.evidenceRefs ?? [])],
    resolutionEvidenceRefs: [...new Set(finding.resolutionEvidenceRefs ?? [])],
    openedAt: finding.openedAt,
    resolvedAt: finding.resolvedAt ?? null,
  };
};

export const openBlockingFindings = findings => findings.filter(finding => QUALITY_SEVERITIES.includes(finding.severity) && finding.status !== 'resolved');
export const qualityCanClose = findings => openBlockingFindings(findings).length === 0;
