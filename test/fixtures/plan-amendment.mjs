import { digestJson } from '../../src/common/canonical.mjs';

export const amendmentFixture = () => {
  const parentPlan = { features: ['A0', 'A1', 'A2'], proposedFeatures: [
    { id: 'A0', projectId: 'sample', disposition: 'project-owned', allowedPaths: ['src'], dependsOn: [], contracts: ['foundation'], verification: [] },
    { id: 'A1', projectId: 'sample', disposition: 'project-owned', allowedPaths: ['src'], dependsOn: ['A0'], contracts: ['runtime'], verification: [] },
    { id: 'A2', projectId: 'sample', disposition: 'project-owned', allowedPaths: ['src'], dependsOn: ['A1'], contracts: ['consumers'], verification: [] },
  ] };
  const revision = { parentRunId: 'base-plan', parentPlanDigest: 'a'.repeat(64), parentPlan,
    changeRequestDigest: 'b'.repeat(64), affectedImplementationRuns: [],
    amendmentScope: { version: 'plan-amendment/1', artifactRoot: 'docs/amend', featureIds: ['A1', 'A2'],
      planPointers: ['/proposedFeatures/1/contracts', '/proposedFeatures/1/dependsOn', '/proposedFeatures/2/contracts'], documents: [] } };
  const patch = { version: 'plan-amendment/1', basePlanDigest: revision.parentPlanDigest,
    changeRequestDigest: revision.changeRequestDigest,
    changes: [{ path: '/proposedFeatures/1/contracts', expectedDigest: digestJson(['runtime']), value: ['runtime and prerequisite consumer conversion'] }], documents: [] };
  return { parentPlan, revision, patch };
};
