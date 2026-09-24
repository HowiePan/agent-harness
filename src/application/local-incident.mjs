import { digestJson } from '../common/canonical.mjs';

const hostEffectFailure = /^(?:CODEX_ROLLOUT_|CODEX_COLLABORATION_|CODEX_HOST_EFFECT_)/;
const hostFailure = /^(?:CODEX_ROLLOUT_|CODEX_COLLABORATION_|CODEX_HOST_EFFECT_|CODEX_HOST_HOOK_|VISIBLE_AGENT_HOST_)/;
const authorityFailure = new Set(['AUTHORITY_DIGEST_MISMATCH', 'RUN_LINEAGE_AUTHORITY_DIGEST_MISMATCH']);
const invalidInvocation = /^(?:LOCAL_SOURCE_COMMAND_INVALID|LOCAL_SOURCE_INITIALIZATION_REQUIRED)$/;
const projectAttention = new Set(['feature-gates-not-passed', 'stable-gates-not-passed', 'final-gates-not-passed']);
const sourceStale = new Set(['HARNESS_SOURCE_IDENTITY_CHANGED', 'SOURCE_LINK_RELEASE_STALE']);
const environmentFailure = new Set(['LOCAL_PROCESS_GATE_HOST_UNAVAILABLE']);
const localBindingFailure = /^(?:LOCAL_SOURCE_|VISIBLE_LIFECYCLE_(?:COORDINATOR|WORKFLOW|WORKSPACE)_IDENTITY_MISMATCH)/;

/** Classify a source-linked failure without depending on a particular Workflow. */
export const classifyLocalIncident = ({ error, phase, projectId = null, workflowId = null, action = null, target = null, runId = null } = {}) => {
  const code = typeof error === 'string' ? error : error?.code ?? 'UNEXPECTED_ERROR';
  const isHostFailure = hostFailure.test(code);
  const isHostEffectFailure = hostEffectFailure.test(code);
  const isAuthorityFailure = authorityFailure.has(code);
  const isInvocationError = invalidInvocation.test(code);
  const isSourceStale = sourceStale.has(code);
  const isEnvironmentFailure = environmentFailure.has(code);
  const isBindingFailure = localBindingFailure.test(code);
  const patchLevelHint = isHostFailure ? 'H3' : isAuthorityFailure || code === 'DEVELOPMENT_PATCH_INCOMPATIBLE' ? 'H4' : null;
  const severity = isAuthorityFailure ? 'P0'
    : isInvocationError ? 'P3'
      : projectAttention.has(code) || isEnvironmentFailure || isBindingFailure || isSourceStale || code === 'DEVELOPMENT_PATCH_INCOMPATIBLE' ? 'P2'
        : 'P1';
  const origin = isInvocationError ? 'invocation' : projectAttention.has(code) ? 'project' : isEnvironmentFailure ? 'environment' : isBindingFailure || isSourceStale ? 'binding' : isHostFailure || isAuthorityFailure || code === 'DEVELOPMENT_PATCH_INCOMPATIBLE' ? 'harness' : 'undetermined';
  const disposition = isInvocationError ? 'correct-invocation'
    : origin === 'project' ? 'resolve-project-gates'
    : isEnvironmentFailure ? 'restore-captured-process-capability'
    : isSourceStale ? 'sync-source-and-revalidate-binding'
    : patchLevelHint === 'H4' ? 'plan-migration-or-new-release'
      : isHostEffectFailure ? 'contain-effect-and-repair-in-harness-maintenance'
        : isHostFailure ? 'repair-host-integration-in-harness-maintenance'
        : origin === 'binding' ? 'verify-local-binding-and-diagnose-source'
          : 'diagnose-origin-before-repair';
  const context = { code, phase: phase ?? 'unknown', projectId, workflowId, action, target, runId };
  const containment = error?.details?.containment?.disposition ?? null;
  return Object.freeze({
    protocolVersion: '1.0', kind: 'local-harness-incident',
    incidentId: digestJson(context), ...context,
    origin, severity, severityStatus: isHostFailure || isAuthorityFailure || isInvocationError || isSourceStale || isEnvironmentFailure || projectAttention.has(code) || code === 'DEVELOPMENT_PATCH_INCOMPATIBLE' ? 'classified' : 'provisional',
    patchLevelHint, disposition,
    containment, maintenanceContext: origin === 'harness' ? 'independent-harness-checkout' : origin === 'binding' ? 'verify-bound-project-checkout-then-independent-harness-checkout-if-needed' : null,
    currentExecution: containment ? 'contained' : isHostEffectFailure ? 'contain-and-verify-before-repair' : 'hold-untrusted-command',
    continuation: isInvocationError ? 'resubmit-corrected-command'
      : origin === 'project' ? 'resolve-project-gates-then-replan'
      : isEnvironmentFailure ? 'retry-preflight-with-captured-process-capability'
      : isSourceStale ? 'dev-sync-then-retry-command'
      : patchLevelHint === 'H4' ? 'review-migration-or-release-plan'
        : origin === 'binding' ? 'restore-trusted-binding-then-retry-command'
          : origin === 'undetermined' ? 'inspect-evidence-then-classify-origin-and-severity'
            : 'classify-patch-H0-H4-then-resume-or-replan',
  });
};
