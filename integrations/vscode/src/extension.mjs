import { createVSCodeVisibleHostAdapter, VSCODE_HOST_PROVIDER } from './adapter.mjs';
import { createChatParticipantHandler } from './chat/participant.mjs';
import { RunTreeProvider } from './views/run-tree-provider.mjs';
import { LedgerTreeProvider } from './views/ledger-provider.mjs';
import { openFeatureDiff } from './review/diff-viewer.mjs';
import { initializeVSCodeProject } from './initialization.mjs';

let harnessInstance = null;

export const activateWithVSCode = async (context, vscode) => {
  const getHarness = async () => harnessInstance;
  const initializeProject = async options => {
    const workspaceRoot = options?.projectRoot ?? vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
    let decisionPath = options?.decisionPath;
    if (!decisionPath && typeof vscode?.window?.showOpenDialog === 'function') {
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select Authority Decision JSON', filters: { JSON: ['json'] } });
      decisionPath = selected?.[0]?.fsPath;
    }
    const result = await initializeVSCodeProject({ ...options, projectRoot: workspaceRoot, configPath: options?.configPath ?? `${workspaceRoot}/harness.json`, decisionPath });
    harnessInstance = result.harness;
    return { ...result, harness: undefined };
  };

  if (context.subscriptions && typeof vscode?.chat?.createChatParticipant === 'function') {
    const participant = vscode.chat.createChatParticipant(
      'agent-harness.chat',
      createChatParticipantHandler({ getHarness, initializeProject })
    );
    context.subscriptions.push(participant);
  }

  const runTreeProvider = new RunTreeProvider({ getHarness });
  const ledgerTreeProvider = new LedgerTreeProvider({ getHarness });

  if (vscode?.window?.registerTreeDataProvider) {
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('agent-harness.runs', runTreeProvider),
      vscode.window.registerTreeDataProvider('agent-harness.findings', ledgerTreeProvider)
    );
  }

  if (vscode?.commands?.registerCommand) {
    context.subscriptions.push(
      vscode.commands.registerCommand('agent-harness.showDiff', async (baseUri, changedUri, title) => {
        return openFeatureDiff({ vscode, baseUri, changedUri, title });
      }),
      vscode.commands.registerCommand('agent-harness.initializeProject', initializeProject)
    );
  }

  return {
    getHarness,
    setHarness: h => { harnessInstance = h; },
    initializeProject,
    createHostAdapter: opts => createVSCodeVisibleHostAdapter(opts),
    lifecycleExecutionSupported: false,
  };
};

/** VS Code Extension Activation Entry Point. */
export const activate = async context => {
  const vscode = await import('vscode');
  return activateWithVSCode(context, vscode);
};

export const deactivate = () => {
  harnessInstance = null;
};

export { createVSCodeVisibleHostAdapter, VSCODE_HOST_PROVIDER } from './adapter.mjs';
export { createChatParticipantHandler } from './chat/participant.mjs';
export { RunTreeProvider } from './views/run-tree-provider.mjs';
export { LedgerTreeProvider } from './views/ledger-provider.mjs';
export { openFeatureDiff } from './review/diff-viewer.mjs';
export { initializeVSCodeProject } from './initialization.mjs';
