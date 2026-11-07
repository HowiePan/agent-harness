import { open, readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assert } from '../../../../src/common/errors.mjs';
import { createLifecycleCommandHost } from '../../../../src/application/lifecycle-command-context.mjs';
import { verifyDevelopmentSourceManifest } from '../../../../src/application/development-source.mjs';
import { validateProjectHarnessConfig } from '../../../../src/application/project-initialization.mjs';
import { locateCodexRollout } from './codex-rollout-host-exchange.mjs';
import { loadBindings, parsePseudoCommand } from '../hooks/pseudo-command-router.mjs';
import { isLocalProcessGateHostFailure } from './local-process-gate-readiness.mjs';

const parse = prompt => parsePseudoCommand(prompt.replace(/^h:local\s+/, 'h:'));
const isStop = prompt => /^(?:请)?(?:先停止|停止(?:执行|实施|运行)?(?:[，。！？,!\s]|$)|先停(?:[，。,!\s]|$)|停下|取消(?:任务|执行|实施)|不要继续|stop\b|cancel\b)/i.test(prompt);
const userText = record => record.type === 'event_msg' && record.payload?.type === 'user_message'
  ? record.payload.message : record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user'
    ? record.payload.content?.filter(p => p.type === 'input_text').map(p => p.text).join('\n') : null;

/** Reads native user frames only. Tool output, quoted histories and worker claims cannot initiate. */
export const createCodexUserCommandHost = ({ intent, codexHome, stateDbPath, locate = locateCodexRollout,
  resolveProject = null } = {}) => {
  let path = null, cursor = 0, partial = '', decoder = new StringDecoder('utf8'), latest = null, activeReference = null, revoked = false;
  const scan = async () => {
    const host = await locate({ codexHome, stateDbPath, codexSessionId: intent.codexSessionId, expectedCwd: intent.executionWorkspaceRoot });
    assert(!path || path === host.path, 'USER_COMMAND_ROLLOUT_CHANGED', 'The native command source changed; prepare recovery instead of replaying.');
    path = host.path;
    const handle = await open(path, 'r');
    try {
      const size = (await handle.stat()).size;
      assert(size >= cursor, 'USER_COMMAND_ROLLOUT_TRUNCATED', 'The native command source was truncated.');
      // Fixed bounded window on admission, incremental reads afterwards. Never load the session as one JSON object.
      let skip = false;
      if (cursor === 0 && size > 32 * 1024 * 1024) { cursor = size - 32 * 1024 * 1024; skip = true; }
      while (cursor < size) {
        const chunk = Buffer.alloc(Math.min(65536, size - cursor));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, cursor); if (!bytesRead) break;
        cursor += bytesRead; partial += decoder.write(chunk.subarray(0, bytesRead));
        assert(Buffer.byteLength(partial) <= 8 * 1024 * 1024, 'USER_COMMAND_FRAME_TOO_LARGE', 'Native command frame exceeded the observation limit.');
        let newline;
        while ((newline = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
          if (skip) { skip = false; continue; } if (!line) continue;
          const record = JSON.parse(line), text = userText(record);
          if (typeof text !== 'string' || !text.trim()) continue;
          const prompt = text.trim(), timestamp = record.timestamp;
          // Native event and response frames can describe the same user message.
          if (latest?.prompt === prompt && latest.type !== record.type) continue;
          latest = { prompt, timestamp, type: record.type,
            reference: digestJson({ sessionId: intent.codexSessionId, timestamp,
              ordinal: record.ordinal ?? null, prompt: sha256(prompt) }) };
          if (activeReference && latest.reference !== activeReference && (parse(prompt)?.kind === 'command' || isStop(prompt))) revoked = true;
        }
      }
      assert(!partial, 'USER_COMMAND_FRAME_INCOMPLETE', 'Native command observation ends in an incomplete frame; retry observation in the current command.');
      return latest;
    } finally { await handle.close(); }
  };
  const observe = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await scan(); }
      catch(error) { if (error.code !== 'USER_COMMAND_FRAME_INCOMPLETE' || attempt >= 2) throw error; await delay(25); }
    }
  };
  const binding = async parsed => {
    if (resolveProject) return resolveProject(parsed);
    let bindings;
    if (intent.harness.release.mode === 'source-link') {
      const { manifest } = await verifyDevelopmentSourceManifest(intent.harness.release.developmentManifest);
      const config = validateProjectHarnessConfig(JSON.parse(await readFile(manifest.configPath, 'utf8')));
      if (config.binding.alias !== parsed.projectAlias || config.binding.projectId !== intent.project.projectId) return null;
      bindings = await loadBindings({pluginData:resolve(manifest.dataRoot,'development','local-codex','.plugin-data'),pluginRoot:null,fallbackPluginRoot:null});
    } else bindings = await loadBindings();
    return bindings.projects?.[parsed.projectAlias] ?? bindings.workspaces?.[parsed.projectAlias] ?? null;
  };
  return createLifecycleCommandHost({ provider: 'codex-native-user-command',
    verifyPrestartRetry: error => isLocalProcessGateHostFailure(error) && error.details?.processCode === 'EPERM',
    async verifyCommand(request) {
      const observed = await observe(), parsed = observed && parse(observed.prompt);
      const bound = parsed?.kind === 'command' ? await binding(parsed) : null;
      const workflow = parsed?.workflowId ? bound?.workflows?.find(w=>w.id===parsed.workflowId)
        : bound?.workflows?.length===1 ? bound.workflows[0] : null;
      const project = workflow ? {...bound,profileId:workflow.profileId,extensionId:workflow.extensionId,workflowId:workflow.id} : bound;
      const age = Date.parse(intent.createdAt) - Date.parse(observed?.timestamp);
      const admissionAge = Date.now() - Date.parse(intent.createdAt);
      assert(request.commandId === intent.commandId && parsed?.kind === 'command' && project?.projectId === intent.project.projectId
        && project.extensionId === intent.project.extensionId && project.profileId === intent.project.profileId
        && parsed.action === intent.command.action && parsed.target === intent.command.target
        && digestJson(parsed.arguments) === digestJson(intent.command.arguments)
        && digestJson(parsed.projectIds??[]) === digestJson(intent.project.projectIds??[])
        && (!parsed.projectIds || bound.workspaceId && bound.workspaceId===intent.project.workspaceId)
        && (!bound.workflows?.length || Boolean(workflow) && workflow.id === intent.project.workflowId)
        && (!parsed.workflowId || parsed.workflowId === intent.project.workflowId)
        && age >= -5000 && age <= 600000 && admissionAge >= -5000 && admissionAge <= 600000,
      'CURRENT_USER_COMMAND_REQUIRED', 'The latest native user message does not initiate this exact bound command.',
      {nativeUserObserved:Boolean(observed),commandFrameMatched:parsed?.kind==='command',userMessageDigest:observed?sha256(observed.prompt):null});
      activeReference = observed.reference;
      return { verified: true, purpose: 'business', commandId: intent.commandId, reference: activeReference, userIssuedAt:observed.timestamp, dataRoot: intent.harness.dataRoot,
        command: { arguments: parsed.arguments, workflowId: intent.project.workflowId ?? null,
          projectIds:intent.project.projectIds??null,
          extensionId: intent.project.extensionId, profileId: intent.project.profileId },
        scope: { projectId: intent.project.projectId, action: parsed.action, target: parsed.target,
          workspaceRoot: intent.executionWorkspaceRoot } };
    },
    async verifyActive(attestation) {
      await observe();
      if (attestation.reference !== activeReference) return { active: false };
      return { active: !revoked && activeReference !== null };
    },
  });
};
