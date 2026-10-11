import { slash } from '../../common/paths.mjs';

const within = (root, path) => path === root || path.startsWith(`${root}/`);
export const qualityFindingInScope = (finding, roots) => {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  const paths = finding.affectedPaths?.length ? finding.affectedPaths : finding.sourcePath ? [finding.sourcePath] : [];
  return paths.length > 0 && paths.every(value => {
    const path = slash(value);
    return path && !path.startsWith('/') && !path.includes(':')
      && path.split('/').every(segment => segment && segment !== '.' && segment !== '..')
      && roots.some(root => within(slash(root).replace(/\/$/, ''), path));
  });
};

export const classifyQualityFindings = (findings, roots) => {
  const actionable = [];
  const deliveryPrerequisites = [];
  for (const finding of findings ?? []) {
    if (qualityFindingInScope(finding, roots)) actionable.push(finding);
    else deliveryPrerequisites.push({
      id: finding.id, summary: finding.summary, severity: finding.severity,
      evidence: [...(finding.evidence ?? [])], affectedPaths: [...(finding.affectedPaths ?? [])],
      classification: 'delivery-prerequisite', reason: 'outside-quality-source-scope',
    });
  }
  return { findings: actionable, deliveryPrerequisites };
};
