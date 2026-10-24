import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';

const idle = state => !state.leases.some(row => row.status === 'active')
  && !state.dispatches.some(row => ['requested', 'assigned'].includes(row.status));

export const isBlockedAmendmentDraft = state => state.metadata?.commandIntent?.action === 'amend'
  && state.status === 'ready' && idle(state)
  && !state.findings?.some(row => row.status !== 'resolved')
  && state.features.some(row => row.metadata?.stage === 'version-planning' && row.state === 'blocked'
    && row.blocker?.kind === 'scope')
  && state.submissions.some(row => row.result?.status === 'blocked' && row.result.failureClass === 'scope-blocker')
  && !state.submissions.some(row => row.result?.status === 'completed');

const extendsScope = (before, after) => {
  const same = (a, b) => digestJson(a) === digestJson(b);
  const includes = (a, b) => a.every(value => b.includes(value));
  return before && after && same(before.version, after.version) && same(before.artifactRoot, after.artifactRoot)
    && same(before.featureIds, after.featureIds)
    && same(before.baselineCompatibilityPaths ?? [], after.baselineCompatibilityPaths ?? [])
    && includes(before.planPointers, after.planPointers)
    && before.documents.length === after.documents.length
    && before.documents.every((doc, index) => {
      const next = after.documents[index];
      return same(doc.id, next.id) && same(doc.source, next.source) && same(doc.outputPath, next.outputPath)
        && includes(doc.allowedPointers, next.allowedPointers);
    });
};

/** A new human command may replace only an idle, unaccepted scope-blocked draft. */
export const selectAmendmentRetry = ({ states, intent, parentRunId, parentPlanDigest, request, scope }) => {
  const candidates = states.filter(state => !['closed', 'failed', 'incomplete', 'superseded'].includes(state.status)
    && state.metadata?.commandIntent?.action === 'amend'
    && state.metadata.commandIntent.target === intent.target
    && state.metadata.commandIntent.workflowId === intent.workflowId);
  assert(candidates.length <= 1, 'PLAN_AMENDMENT_RETRY_AMBIGUOUS', 'More than one unfinished amendment exists.');
  if (!candidates.length) return null;
  const prior = candidates[0];
  const revision = prior.metadata.planRevision;
  // An unchanged command continues its own immutable Plan; it does not authorize replacement.
  if (revision?.changeRequestDigest === digestJson(request)) return null;
  assert(isBlockedAmendmentDraft(prior) && prior.metadata.commandIntent.selector === intent.selector
    && revision.parentRunId === parentRunId && revision.parentPlanDigest === parentPlanDigest
    && extendsScope(revision.amendmentScope, scope),
  'PLAN_AMENDMENT_RETRY_UNSAFE', 'A revised scope must preserve the exact base, selector, affected Features and artifact identity; only an idle unaccepted scope-blocked draft can be replaced.');
  return { runId: prior.runId, revision: prior.revision, authorityDigest: prior.authorityDigest,
    lifecyclePlanDigest: prior.metadata.lifecyclePlanDigest, sourceDigest: prior.sourceDigest };
};

export const matchesAmendmentRetry = (state, plan) => {
  const ref = plan.intent?.planRevision?.replacesAmendment;
  return Boolean(ref && ref.runId === state.runId && ref.revision === state.revision
    && ref.authorityDigest === state.authorityDigest && ref.lifecyclePlanDigest === state.metadata.lifecyclePlanDigest
    && ref.sourceDigest === state.sourceDigest && isBlockedAmendmentDraft(state)
    && state.metadata.commandIntent.selector === plan.intent.selector
    && state.metadata.planRevision.parentRunId === plan.intent.planRevision.parentRunId
    && state.metadata.planRevision.parentPlanDigest === plan.intent.planRevision.parentPlanDigest
    && state.metadata.planRevision.changeRequestDigest !== plan.intent.planRevision.changeRequestDigest
    && extendsScope(state.metadata.planRevision.amendmentScope, plan.intent.planRevision.amendmentScope));
};
