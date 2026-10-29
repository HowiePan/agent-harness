import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../common/canonical.mjs';
import { safeSegment } from '../../common/paths.mjs';
import { atomicWrite } from '../../kernel/atomic-io.mjs';
import { diffPlanFeatures } from './plan-diff.mjs';
import { resolvedPlanAmendment } from './plan-amendment.mjs';

const latestOutput = (state, stage, port) => {
  const ids = new Set(state.features.filter(feature => feature.metadata?.stage === stage && feature.state === 'completed').map(feature => feature.id));
  return [...(state.submissions ?? [])].reverse().find(submission => ids.has(submission.featureId) && !submission.supersededAt && submission.result?.status === 'completed')?.result.outputs?.[port]?.value ?? null;
};

export const reviewedPlanProposal = state => {
  const patch = latestOutput(state, 'version-planning', 'amendment');
  return patch ? resolvedPlanAmendment(state.metadata.planRevision, patch, { workspaceRoot: state.metadata.workspace?.root })
    : latestOutput(state, 'version-planning', 'plan');
};

// Values follow fixed Markdown prefixes. Keep inline punctuation literal so
// validation expressions and paths remain readable in the review source.
const line = value => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''))
  .replace(/[\r\n\t]+/g, ' ').trim();

export const planApprovalSnapshot = (state, { legacyStructuredValues = false } = {}) => {
  // Read-only compatibility with sealed archives produced before structured
  // values were rendered as JSON. The default approval bytes never change.
  const renderLine = legacyStructuredValues
    ? value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim() : line;
  const renderList = (heading, values) => values?.length
    ? [`### ${heading}`, '', ...values.map(value => `- ${renderLine(value)}`), ''] : [];
  const plan = reviewedPlanProposal(state);
  const review = latestOutput(state, 'plan-review', 'plan-review');
  if (!plan || !review) return null;
  const planDigest = digestJson({ projectId: state.projectId, runId: state.runId, sourceDigest: state.sourceDigest, plan, review });
  const target = state.metadata?.commandIntent?.target ?? state.runId;
  const rows = [
    `# ${line(target)} 实施计划审阅稿`, '',
    `> 项目：${line(state.projectId)}；Run：${line(state.runId)}；源码摘要：${state.sourceDigest}。`,
    `> 规划摘要：${planDigest}。独立 Agent 审查：${review.approved === true ? '通过' : '未通过'}；人工审核须以此摘要和本文件摘要记录 Authority Decision。`,
    '> 本文件列出未来工作的建议范围；规划本身不授予实施写权限。', '',
    '## 工作包', '',
  ];
  if (plan.amendment) {
    rows.push('## 局部修订', '', `- 原批准规划摘要：${plan.amendment.basePlanDigest}`,
      `- 增量补丁摘要：${plan.amendment.deltaDigest}`,
      `- 独立审查范围：${plan.amendment.affectedFeatureIds.join('、')}`,
      `- 机器合成完整计划：${plan.amendment.artifactRoot}/plan.json`,
      `- 可读增量差异：${plan.readablePlan}`,
      '- 未受影响内容由原计划承接；本次批准绑定原计划、精确补丁、合成计划与审查结果。', '');
  }
  for (const item of (plan.proposedFeatures ?? []).filter(item => !plan.amendment
    || plan.amendment.affectedFeatureIds.includes(item.id))) {
    rows.push(`### ${line(item.id)} · ${line(item.projectId)} · ${line(item.disposition)}`, '');
    rows.push(`- 项目内依赖：${(item.dependsOn ?? []).length ? item.dependsOn.map(line).join('、') : '无'}`);
    rows.push(`- 建议路径：${(item.allowedPaths ?? []).length ? item.allowedPaths.map(line).join('；') : '无'}`);
    rows.push('');
    rows.push(...renderList('外部前置', item.externalPrerequisites), ...renderList('交付合同', item.contracts), ...renderList('验证', item.verification));
  }
  if (plan.amendment) rows.push('## 未变工作包', '',
    ...(plan.proposedFeatures ?? []).filter(item => !plan.amendment.affectedFeatureIds.includes(item.id))
      .map(item => `- ${line(item.id)}；内容摘要 ${digestJson(item)}；按原批准合同承接。`), '');
  if (state.metadata?.planRevision) {
    const revision = state.metadata.planRevision;
    const changes = diffPlanFeatures(revision.parentPlan, plan);
    rows.push('## 相对上一版的修订', '', `- 上一版 Run：${line(revision.parentRunId)}`,
      `- 上一版规划摘要：${line(revision.parentPlanDigest)}`,
      `- 变更单：${line(state.metadata.changeRequest?.id ?? '无；根据源码或上次审查修订')}`,
      `- 差异摘要：${digestJson(changes)}`, '');
    if (revision.revisionBasis?.length) {
      rows.push('### 修订依据', '');
      for (const basis of revision.revisionBasis) {
        if (basis.kind === 'registered-change-request') rows.push(`- 登记变更单 ${line(basis.id)}；摘要 ${line(basis.digest)}`);
        else if (basis.kind === 'rejected-plan-review') rows.push(`- 上次审查未通过；Authority ${line(basis.authorityDigest)}；发现摘要 ${line(basis.findingsDigest)}`);
        else if (basis.kind === 'verified-source-delta') rows.push(`- 已核验源码差异 ${line(basis.fromSourceDigest)} → ${line(basis.toSourceDigest)}；快照证据 ${line(basis.snapshotEvidenceRef)}；差异摘要 ${line(basis.changeDigest)}；路径 ${basis.changedPaths.map(line).join('、')}`);
      }
      rows.push('');
    }
    if (state.metadata.changeRequest) {
      rows.push(`- 变更类型：${line(state.metadata.changeRequest.kind)}`,
        `- 变更摘要：${line(state.metadata.changeRequest.summary)}`,
        `- 变更单摘要：${line(state.metadata.changeRequest.digest)}`, '');
      rows.push(...renderList('新增或变动的需求', state.metadata.changeRequest.requirements),
        ...renderList('变更验收标准', state.metadata.changeRequest.acceptance));
    }
    for (const change of changes) rows.push(`- ${line(change.disposition)}：${line(change.id)}`);
    rows.push('');
  }
  rows.push(...renderList('独立审查发现', review.findings));
  if (plan.acceptanceCoverage && typeof plan.acceptanceCoverage === 'object') {
    rows.push('## 门禁覆盖', '');
    for (const [gate, ids] of Object.entries(plan.acceptanceCoverage).sort(([a], [b]) => a.localeCompare(b))) rows.push(`- ${line(gate)}：${(ids ?? []).map(line).join('、')}`);
    rows.push('');
  }
  rows.push(...renderList('顺序与冲突', plan.orderingAndConflicts), ...renderList('受保护操作', plan.protectedOperations));
  rows.push('## 审核决定', '', review.approved === true
    ? '此处尚无人工批准。你确认此计划后，须记录 `implementation-plan-approved` Decision，并绑定上方规划摘要与此 Markdown 的 SHA-256。'
    : '独立 Agent 审查未通过；需修订并重新规划，此稿不得批准实施。', '');
  const markdown = `${rows.join('\n')}\n`;
  return { projectId: state.projectId, runId: state.runId, target, sourceDigest: state.sourceDigest, reviewApproved: review.approved === true, planDigest, artifactDigest: sha256(markdown), markdown };
};

export const planApprovalSatisfied = state => {
  const snapshot = planApprovalSnapshot(state);
  if (!snapshot?.reviewApproved) return false;
  return (state.decisions ?? []).some(decision => decision.id === 'implementation-plan-approved' && decision.decision === 'approved'
    && decision.actor && decision.projectId === snapshot.projectId && decision.runId === snapshot.runId
    && decision.planDigest === snapshot.planDigest && decision.artifactDigest === snapshot.artifactDigest);
};

export const ensurePlanApprovalArtifact = async (dataRoot, state) => {
  const snapshot = planApprovalSnapshot(state);
  if (!snapshot) return null;
  const path = resolve(dataRoot, 'outputs', safeSegment(state.projectId, 'projectId'), safeSegment(state.runId, 'runId'), 'plan-review.md');
  await atomicWrite(path, snapshot.markdown, { root: dataRoot });
  const { markdown, ...identity } = snapshot;
  return { ...identity, path };
};
