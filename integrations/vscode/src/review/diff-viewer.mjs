import { assert } from '../../../../src/common/errors.mjs';

/**
 * Triggers VS Code diff editor for reviewing changed files produced by a Feature submission.
 */
export const openFeatureDiff = async ({ vscode, baseUri, changedUri, title = 'Feature Review Diff' }) => {
  assert(vscode?.commands?.executeCommand, 'VSCODE_API_UNAVAILABLE', 'VS Code commands API is not available.');
  return vscode.commands.executeCommand('vscode.diff', baseUri, changedUri, title);
};
