import { createVSCodeVisibleHostAdapter, VSCODE_HOST_PROVIDER } from './adapter.mjs';
import { createChatParticipantHandler } from './chat/participant.mjs';
import { RunTreeProvider } from './views/run-tree-provider.mjs';
import { LedgerTreeProvider } from './views/ledger-provider.mjs';
import { openFeatureDiff } from './review/diff-viewer.mjs';

let harnessInstance = null;

/**
 * VS Code Extension Activation Entry Point.
 */
export const activate = async context => {
  const getHarness = async () => harnessInstance;

  // 1. Register Chat Participant
  if (context.subscriptions && typeof context.vscode?.chat?.createChatParticipant === 'function') {
    const participant = context.vscode.chat.createChatParticipant(
      'agent-harness.chat',
      createChatParticipantHandler({ getHarness })
    );
    context.subscriptions.push(participant);
  }

  // 2. Register Activity Bar Views
  const runTreeProvider = new RunTreeProvider({ getHarness });
  const ledgerTreeProvider = new LedgerTreeProvider({ getHarness });

  if (context.vscode?.window?.registerTreeDataProvider) {
    context.subscriptions.push(
      context.vscode.window.registerTreeDataProvider('agent-harness.runs', runTreeProvider),
      context.vscode.window.registerTreeDataProvider('agent-harness.findings', ledgerTreeProvider)
    );
  }

  // 3. Register Commands
  if (context.vscode?.commands?.registerCommand) {
    context.subscriptions.push(
      context.vscode.commands.registerCommand('agent-harness.showDiff', async (baseUri, changedUri, title) => {
        return openFeatureDiff({ vscode: context.vscode, baseUri, changedUri, title });
      })
    );
  }

  return {
    getHarness,
    setHarness: h => { harnessInstance = h; },
    createHostAdapter: opts => createVSCodeVisibleHostAdapter({ ...opts, vscode: context.vscode }),
  };
};

export const deactivate = () => {
  harnessInstance = null;
};

export { createVSCodeVisibleHostAdapter, VSCODE_HOST_PROVIDER } from './adapter.mjs';
export { createChatParticipantHandler } from './chat/participant.mjs';
export { RunTreeProvider } from './views/run-tree-provider.mjs';
export { LedgerTreeProvider } from './views/ledger-provider.mjs';
export { openFeatureDiff } from './review/diff-viewer.mjs';
