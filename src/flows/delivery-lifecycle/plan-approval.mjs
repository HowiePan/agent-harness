import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../common/canonical.mjs';
import { safeSegment } from '../../common/paths.mjs';
import { atomicWrite } from '../../kernel/atomic-io.mjs';

const latestOutput = (state, stage, port) => {
  const ids = new Set(state.features.filter(feature => feature.metadata?.stage === stage && feature.state === 'completed').map(feature => feature.id));
  return [...(state.submissions ?? [])].reverse().find(submission => ids.has(submission.featureId) && !submission.supersededAt && submission.result?.status === 'completed')?.result.outputs?.[port]?.value ?? null;
};

const line = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/([`*_{}\[\]()#+.!|<>])/g, '\\$1').trim();
const list = (heading, values) => values?.length ? [`### ${heading}`, '', ...values.map(value => `- ${line(value)}`), ''] : [];

export const planApprovalSnapshot = state => {
  const plan = latestOutput(state, 'version-planning', 'plan');
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
  for (const item of plan.proposedFeatures ?? []) {
    rows.push(`### ${line(item.id)} · ${line(item.projectId)} · ${line(item.disposition)}`, '');
    rows.push(`- 项目内依赖：${(item.dependsOn ?? []).length ? item.dependsOn.map(line).join('、') : '无'}`);
    rows.push(`- 建议路径：${(item.allowedPaths ?? []).length ? item.allowedPaths.map(line).join('；') : '无'}`);
    rows.push('');
    rows.push(...list('外部前置', item.externalPrerequisites), ...list('交付合同', item.contracts), ...list('验证', item.verification));
  }
  rows.push(...list('独立审查发现', review.findings));
  if (plan.acceptanceCoverage && typeof plan.acceptanceCoverage === 'object') {
    rows.push('## 门禁覆盖', '');
    for (const [gate, ids] of Object.entries(plan.acceptanceCoverage).sort(([a], [b]) => a.localeCompare(b))) rows.push(`- ${line(gate)}：${(ids ?? []).map(line).join('、')}`);
    rows.push('');
  }
  rows.push(...list('顺序与冲突', plan.orderingAndConflicts), ...list('受保护操作', plan.protectedOperations));
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
