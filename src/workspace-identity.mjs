import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { assert } from './errors.mjs';

const optionalLstat = async path => {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

export const resolveGitWorkspaceIdentity = async workspaceRoot => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'WORKSPACE_ROOT_INVALID', 'Git workspace identity requires an absolute workspace root.');
  const root = resolve(workspaceRoot);
  const marker = resolve(root, '.git');
  const markerInfo = await optionalLstat(marker);
  assert(markerInfo, 'WORKSPACE_GIT_METADATA_REQUIRED', `Workspace does not expose .git metadata: ${root}`);

  let gitDirectory;
  if (markerInfo.isDirectory()) gitDirectory = marker;
  else {
    assert(markerInfo.isFile(), 'WORKSPACE_GIT_METADATA_INVALID', `Workspace .git metadata is not a file or directory: ${marker}`);
    const match = (await readFile(marker, 'utf8')).trim().match(/^gitdir:\s*(.+)$/i);
    assert(match?.[1], 'WORKSPACE_GITDIR_INVALID', `Workspace .git file does not declare gitdir: ${marker}`);
    gitDirectory = resolve(root, match[1]);
    const directoryInfo = await optionalLstat(gitDirectory);
    assert(directoryInfo?.isDirectory(), 'WORKSPACE_GITDIR_INVALID', `Workspace gitdir does not exist: ${gitDirectory}`);
  }

  let commonDirectory = gitDirectory;
  try {
    const common = (await readFile(resolve(gitDirectory, 'commondir'), 'utf8')).trim();
    assert(common, 'WORKSPACE_GIT_COMMON_DIR_INVALID', `Workspace commondir is empty: ${gitDirectory}`);
    commonDirectory = resolve(gitDirectory, common);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  commonDirectory = await realpath(commonDirectory);
  return Object.freeze({ type: 'git-common-dir', commonDir: commonDirectory });
};

export const resolveProjectWorkspace = async (project, requestedRoot = undefined) => {
  const declaredRoot = resolve(project.workspace.root);
  const selector = project.workspace.rootSelector ?? 'descriptor-root';
  if (selector === 'descriptor-root') {
    if (requestedRoot !== undefined) {
      assert(isAbsolute(requestedRoot), 'PROJECT_EXECUTION_WORKSPACE_INVALID', 'Execution workspace override must be absolute.');
      assert(samePath(requestedRoot, declaredRoot), 'PROJECT_EXECUTION_WORKSPACE_DENIED', 'Project Descriptor does not allow a different execution workspace.', { declaredRoot, requestedRoot: resolve(requestedRoot) });
    }
    return Object.freeze({ root: declaredRoot, selector, identity: null });
  }
  assert(selector === 'git-worktree', 'PROJECT_WORKSPACE_SELECTOR_INVALID', `Unsupported Project workspace rootSelector: ${selector}`);
  const root = resolve(requestedRoot ?? declaredRoot);
  assert(isAbsolute(root), 'PROJECT_EXECUTION_WORKSPACE_INVALID', 'Execution workspace must be absolute.');
  const [declaredIdentity, identity] = await Promise.all([
    resolveGitWorkspaceIdentity(declaredRoot),
    resolveGitWorkspaceIdentity(root),
  ]);
  assert(samePath(declaredIdentity.commonDir, identity.commonDir), 'PROJECT_EXECUTION_WORKSPACE_MISMATCH', 'Execution workspace is not a linked worktree of the registered Project repository.', { declaredRoot, requestedRoot: root, declaredIdentity, requestedIdentity: identity });
  return Object.freeze({ root, selector, identity });
};
