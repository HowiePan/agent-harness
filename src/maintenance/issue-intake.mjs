import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';
import { atomicWrite, atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { safeSegment, slash } from '../paths.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/issue-intake.schema.json', import.meta.url), 'utf8'));
const receiptSchema = JSON.parse(readFileSync(new URL('../../schemas/issue-intake-receipt.schema.json', import.meta.url), 'utf8'));
const sensitiveKey = /(?:authorization|cookie|credential|password|private.?key|prompt|secret|token)/i;
const sensitiveValue = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,})/i;

const collectSensitiveContent = (value, path = '$', output = []) => {
  if (Array.isArray(value)) value.forEach((item, index) => collectSensitiveContent(item, `${path}[${index}]`, output));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) output.push(`${path}.${key}`);
    collectSensitiveContent(child, `${path}.${key}`, output);
  }
  else if (typeof value === 'string' && sensitiveValue.test(value)) output.push(path);
  return output;
};

const jsonBlock = value => `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;

const renderIssue = (issueId, intake) => {
  const missing = intake.missingEvidence?.length ? intake.missingEvidence.map(item => `- ${item}`).join('\n') : '- 无';
  return `# ${issueId}：${intake.summary}\n\n` +
    `- 状态：Intake / Pending Triage\n` +
    `- 级别：${intake.severity}\n` +
    `- 观察时间：${intake.observedAt}\n` +
    `- 项目别名：${intake.projectAlias}\n` +
    (intake.workspace ? `- Workspace：${intake.workspace.workspaceId} (${intake.workspace.alias})\n- 成员项目：${intake.workspace.projectIds.join(', ') || '未指定'}\n` : '') +
    `- Project：${intake.project.projectId}\n` +
    `- Profile：${intake.project.profileId}\n` +
    `- Extension：${intake.project.extensionId}\n` +
    (intake.workflow ? `- Workflow：${intake.workflow.id}@${intake.workflow.version}#${intake.workflow.artifactDigest}\n${intake.workflow.runId ? `- Run：${intake.workflow.runId}\n` : ''}` : '') +
    `- Intake 摘要：${intake.intakeDigest}\n\n` +
    `## 期望\n${jsonBlock(intake.expected)}\n` +
    `## 实际\n${jsonBlock(intake.actual)}\n` +
    `## 复现\n\n${intake.reproduction.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n` +
    `## 缺失证据\n\n${missing}\n\n` +
    `## 对话上下文\n\n完整的已脱敏上下文保存在同目录的 \`intake.json\`；对话只作为问题输入，不是 Harness Authority。共记录 ${intake.conversation.excerpts.length} 条摘录。\n\n` +
    `## 脱敏\n\n确认：是\n\n移除项：${intake.sanitization.removed.length ? intake.sanitization.removed.join('；') : '无'}\n`;
};

const writeExact = async (file, bytes, root) => {
  if (existsSync(file)) {
    assert((await readFile(file)).equals(Buffer.from(bytes)), 'ISSUE_RECORD_CONFLICT', 'An issue record path already contains different content.', { file });
    return file;
  }
  return atomicWrite(file, bytes, { root });
};

export const createIssueIntake = input => {
  assertJsonSchema(input, schema, { code: 'ISSUE_INTAKE_SCHEMA_INVALID', label: 'Issue Intake' });
  assert(input.conversation.excerpts.length <= 50, 'ISSUE_INTAKE_CONTEXT_LIMIT_EXCEEDED', 'Issue Intake accepts at most 50 relevant conversation excerpts.');
  const sensitive = collectSensitiveContent(input);
  assert(sensitive.length === 0, 'ISSUE_INTAKE_SENSITIVE_CONTENT_REJECTED', 'Issue Intake contains sensitive field names or recognizable credential material.', { sensitive });
  const body = structuredClone(withoutKeys(input, ['intakeDigest', 'incidentFingerprint']));
  if (body.correlation) body.incidentFingerprint = digestJson(body.workspace ? { workspace: body.workspace, project: body.project, workflow: body.workflow ?? null, correlation: body.correlation } : { project: body.project, correlation: body.correlation });
  assert(Buffer.byteLength(JSON.stringify(body)) <= 512 * 1024, 'ISSUE_INTAKE_SIZE_LIMIT_EXCEEDED', 'Issue Intake exceeds the 512 KiB limit.');
  return { ...body, intakeDigest: digestJson(body) };
};

export const verifyIssueIntake = input => {
  const intake = createIssueIntake(input);
  if (intake.incidentFingerprint) assert(input.incidentFingerprint === intake.incidentFingerprint, 'ISSUE_INCIDENT_FINGERPRINT_MISMATCH', 'Issue incident fingerprint mismatch.');
  assert(input.intakeDigest === intake.intakeDigest, 'ISSUE_INTAKE_DIGEST_MISMATCH', 'Issue Intake digest mismatch.');
  return intake;
};

export const recordIssueIntake = async (input, { controlRoot: controlRootInput, commandId, now = () => new Date().toISOString() } = {}) => {
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Issue recording requires a command ID.');
  const safeCommandId = safeSegment(commandId, 'commandId');
  const controlRoot = harnessControlRoot(controlRootInput);
  const issueRoot = assertHarnessWritePath(resolve(controlRoot, 'issues'), 'Issue register root', controlRoot);
  const intake = createIssueIntake(input);
  const requestDigest = digestJson({ operation: 'issue.record', intake });
  const date = new Date(intake.observedAt).toISOString().slice(0, 10).replaceAll('-', '');
  const issueId = `AH-${date}-${intake.intakeDigest.slice(0, 12).toUpperCase()}`;
  const issueDirectory = assertHarnessWritePath(resolve(issueRoot, issueId), 'Issue record directory', controlRoot);
  const receiptFile = assertHarnessWritePath(resolve(issueRoot, 'receipts', `${safeCommandId}.json`), 'Issue command receipt', controlRoot);
  const lock = assertHarnessWritePath(resolve(issueRoot, '.issue-register.lock'), 'Issue register lock', controlRoot);

  return withDirectoryLock(lock, async () => {
    const prior = await readJson(receiptFile, null);
    if (prior) {
      assertJsonSchema(prior, receiptSchema, { code: 'ISSUE_RECEIPT_SCHEMA_INVALID', label: 'Issue Intake Receipt' });
      assert(prior.requestDigest === requestDigest, 'COMMAND_ID_REUSED', 'Issue command ID was reused with different conversation input.');
      assert(prior.issueId === issueId && prior.intakeDigest === intake.intakeDigest, 'ISSUE_RECEIPT_CONTEXT_MISMATCH', 'Issue Intake Receipt does not match the current issue content.');
      const priorIssueFile = assertHarnessWritePath(resolve(controlRoot, prior.issueFile), 'Recorded issue file', controlRoot);
      const priorIntakeFile = assertHarnessWritePath(resolve(controlRoot, prior.intakeFile), 'Recorded issue intake file', controlRoot);
      const persistedIntake = verifyIssueIntake(await readJson(priorIntakeFile));
      assert(persistedIntake.intakeDigest === intake.intakeDigest, 'ISSUE_RECORD_CONFLICT', 'Recorded Issue Intake does not match its command Receipt.');
      assert((await readFile(priorIssueFile, 'utf8')) === renderIssue(issueId, persistedIntake), 'ISSUE_RECORD_CONFLICT', 'Recorded issue summary does not match its Issue Intake.');
      return { ...prior, reused: true, issueFile: priorIssueFile, intakeFile: priorIntakeFile, receiptFile };
    }

    const intakeFile = resolve(issueDirectory, 'intake.json');
    const issueFile = resolve(issueDirectory, 'issue.md');
    const receipt = {
      protocolVersion: '1.0',
      commandId: safeCommandId,
      operation: 'issue.record',
      requestDigest,
      issueId,
      intakeDigest: intake.intakeDigest,
      issueFile: slash(relative(controlRoot, issueFile)),
      intakeFile: slash(relative(controlRoot, intakeFile)),
      recordedAt: now(),
    };
    assertJsonSchema(receipt, receiptSchema, { code: 'ISSUE_RECEIPT_SCHEMA_INVALID', label: 'Issue Intake Receipt' });
    await writeExact(intakeFile, `${JSON.stringify(intake, null, 2)}\n`, controlRoot);
    await writeExact(issueFile, renderIssue(issueId, intake), controlRoot);
    await atomicWriteJson(receiptFile, receipt, { root: controlRoot });
    return { ...receipt, reused: false, issueFile, intakeFile, receiptFile };
  }, { root: controlRoot });
};
