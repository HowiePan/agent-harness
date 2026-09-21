const boundedText = (value, fallback, limit) => {
  const text = typeof value === 'string' && value.length ? value : fallback;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
};

const issueSummary = issue => ({
  code: boundedText(issue?.code, 'UNKNOWN_READINESS_ISSUE', 128),
  message: boundedText(issue?.message, 'Execution readiness reported an unspecified issue.', 240),
});

const stopConditionSummary = condition => ({
  type: boundedText(condition?.type, 'unknown', 128),
  ...(typeof condition?.action === 'string' ? { action: boundedText(condition.action, 'unknown', 128) } : {}),
  ...(typeof condition?.requiresFeatureCompletion === 'boolean' ? { requiresFeatureCompletion: condition.requiresFeatureCompletion } : {}),
  ...(typeof condition?.requiresAllFindingsResolved === 'boolean' ? { requiresAllFindingsResolved: condition.requiresAllFindingsResolved } : {}),
  requiredFinalGateCount: Array.isArray(condition?.requiredFinalGates) ? condition.requiredFinalGates.length : 0,
});

export const createPlannedLifecycleEvent = ({ commandId, intentDigest, plan }) => ({
  kind: 'codex-visible-lifecycle-event',
  phase: 'planned',
  commandId,
  intentDigest,
  planDigest: plan.planDigest,
  summary: {
    logicalTaskKey: plan.logicalTaskKey,
    projectId: plan.project.id,
    ...(plan.workspaceRef?.workspaceId ? { workspaceId: plan.workspaceRef.workspaceId } : {}),
    ...(plan.workflow?.id ? { workflowId: plan.workflow.id } : {}),
    action: plan.intent.action,
    target: plan.intent.target,
    runId: plan.run.runId,
    featureCount: plan.run.features.length,
    sourceDigest: plan.run.sourceDigest,
    runtimePluginId: plan.run.runtimePluginId,
    agentExecutionMode: plan.run.agentExecutionMode,
    stopCondition: stopConditionSummary(plan.stopCondition),
  },
});

export const createPreflightLifecycleEvent = ({ commandId, intentDigest, planDigest, report }) => ({
  kind: 'codex-visible-lifecycle-event',
  phase: 'preflight',
  commandId,
  intentDigest,
  planDigest,
  executionReady: report.executionReady,
  reportDigest: report.reportDigest,
  expiresAt: report.expiresAt,
  checkSummary: {
    total: report.checks.length,
    ready: report.checks.filter(check => check.ready).length,
    blockers: report.checks.filter(check => !check.ready).length,
    omittedBlockers: Math.max(0, report.checks.filter(check => !check.ready).length - 12),
  },
  checks: report.checks.filter(check => !check.ready).slice(0, 12).map(check => ({
    id: check.id,
    ready: check.ready,
    issueCount: check.issues.length,
    issues: check.issues.slice(0, 3).map(issueSummary),
    omittedIssues: Math.max(0, check.issues.length - 3),
  })),
  writeProbe: {
    attempted: report.writeProbe.attempted,
    ready: report.writeProbe.ready,
    cleaned: report.writeProbe.cleaned,
  },
  lineage: {
    action: report.lineageResolution.action,
    reasonCode: report.lineageResolution.reasonCode ?? null,
  },
});
