import { cp, lstat, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { assert } from '../../errors.mjs';
import { assertInside, slash } from '../../paths.mjs';
import { atomicWrite } from '../../kernel/atomic-io.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../../workspace-snapshot.mjs';
import { sha256 } from '../../canonical.mjs';
import { assertHarnessWritePath } from '../../write-boundary.mjs';

const optionalStat = async path => {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const fileDigest = async path => {
  const info = await optionalStat(path);
  if (!info) return null;
  assert(info.isFile(), 'ISOLATED_PATH_NOT_FILE', `Isolated integration supports regular files only: ${path}`);
  return sha256(await readFile(path));
};

const excludedBy = (relativePath, exclusions) => exclusions.some(value => relativePath === value || relativePath.startsWith(`${value}/`));

export const createIsolatedWorkspaceProvider = ({ manifestId, controlRoot }) => ({
  async prepare({ project, packet, runtimeDirectory }) {
    assertHarnessWritePath(runtimeDirectory, 'isolated Runtime directory', controlRoot);
    const sourceRoot = resolve(packet.workspace?.root ?? project.workspace.root);
    const workspaceRoot = resolve(runtimeDirectory, 'workspace');
    const config = project.policy?.runtimeConfigs?.[manifestId] ?? {};
    const linkedDirectories = [...new Set(config.linkedDirectories ?? ['node_modules'])].map(slash);
    const exclusions = [...new Set(['.git', '.agent-harness-data', ...(project.workspace.excluded ?? []), ...linkedDirectories])].map(value => slash(value).replace(/^\.\//, '').replace(/\/$/, ''));
    await cp(sourceRoot, workspaceRoot, {
      recursive: true,
      filter: async path => {
        const rel = slash(relative(sourceRoot, path));
        if (rel && excludedBy(rel, exclusions)) return false;
        return !(await lstat(path)).isSymbolicLink();
      },
    });
    for (const linked of linkedDirectories) {
      const source = assertInside(sourceRoot, resolve(sourceRoot, linked), 'linked dependency source');
      if (!await optionalStat(source)) continue;
      const target = assertInside(workspaceRoot, resolve(workspaceRoot, linked), 'linked dependency target');
      await mkdir(dirname(target), { recursive: true });
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const captureExcluded = project.workspace.excluded ?? [];
    const baseSnapshot = await captureWorkspace(sourceRoot, { excluded: captureExcluded });
    const isolatedSnapshot = await captureWorkspace(workspaceRoot, { excluded: captureExcluded });
    assert(baseSnapshot.digest === isolatedSnapshot.digest, 'ISOLATED_WORKSPACE_BASELINE_MISMATCH', 'Isolated workspace does not match the Project source baseline.');
    return { sourceRoot, workspaceRoot, runtimeDirectory, captureExcluded, baseSnapshot, isolatedSnapshot, changedFiles: [] };
  },

  async inspect(context, result) {
    const finalSnapshot = await captureWorkspace(context.workspaceRoot, { excluded: context.captureExcluded });
    const actual = diffWorkspaceSnapshots(context.isolatedSnapshot, finalSnapshot);
    const claimed = [...new Set(result?.changedFiles ?? [])].map(slash).sort();
    assert(JSON.stringify(actual) === JSON.stringify(claimed), 'ISOLATED_CHANGED_FILES_MISMATCH', 'Runtime changed-files claim does not match its isolated workspace.', { actual, claimed });
    context.changedFiles = actual;
    context.finalSnapshot = finalSnapshot;
    return actual;
  },

  async integrate(context) {
    for (const relativePath of context.changedFiles) {
      const source = assertInside(context.workspaceRoot, resolve(context.workspaceRoot, relativePath), 'isolated source');
      const target = assertInside(context.sourceRoot, resolve(context.sourceRoot, relativePath), 'integration target');
      const baseline = context.baseSnapshot.files.find(file => file.path === relativePath)?.sha256 ?? null;
      const current = await fileDigest(target);
      assert(current === baseline, 'ISOLATED_INTEGRATION_CONFLICT', `Project file changed after isolated dispatch: ${relativePath}`, { baseline, current });
      const sourceInfo = await optionalStat(source);
      if (!sourceInfo) await rm(target, { force: true });
      else {
        assert(sourceInfo.isFile(), 'ISOLATED_PATH_NOT_FILE', `Isolated integration supports regular files only: ${relativePath}`);
        await atomicWrite(target, await readFile(source), { root: context.sourceRoot });
      }
    }
    await rm(context.workspaceRoot, { recursive: true, force: true });
    return { changedFiles: [...context.changedFiles] };
  },

  async discard(context) {
    await rm(context.workspaceRoot, { recursive: true, force: true });
  },
});
