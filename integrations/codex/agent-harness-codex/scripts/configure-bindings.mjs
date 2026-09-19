import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveGitWorkspaceIdentity } from '../hooks/pseudo-command-router.mjs';
import { validateActiveReleaseBinding } from '../lib/active-release-binding.mjs';

const parseArguments = input => {
  const args = [...input];
  const take = flag => {
    const index = args.indexOf(flag);
    if (index < 0 || index + 1 >= args.length) throw new Error(`Missing ${flag}`);
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const takeAll = flag => {
    const values = [];
    for (;;) {
      const index = args.indexOf(flag);
      if (index < 0) return values;
      if (index + 1 >= args.length) throw new Error(`Missing ${flag}`);
      values.push(args[index + 1]);
      args.splice(index, 2);
    }
  };
  const takeOptional = flag => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    if (index + 1 >= args.length) throw new Error(`Missing ${flag}`);
    const value = args[index + 1];
    args.splice(index, 2);
    return value;
  };
  const parsed = {
    pluginRoot: take('--plugin-root'),
    controlRoot: take('--control-root'),
    workspaceRoot: takeOptional('--workspace-root'),
    entrypoint: take('--entrypoint'),
    dataRoot: take('--data-root'),
    memoryRoot: takeOptional('--memory-root'),
    projectSpecs: takeAll('--project'),
    workspaceSpecs: takeAll('--workspace'),
    workflowSpecs: takeAll('--workflow'),
  };
  if (args.length) throw new Error(`Unknown arguments: ${args.join(' ')}`);
  return parsed;
};

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

export const configureBindings = async input => {
  const pluginRoot = resolve(input.pluginRoot);
  const controlRoot = resolve(input.controlRoot);
  const workspaceRoot = input.workspaceRoot ? resolve(input.workspaceRoot) : null;
  const entrypoint = resolve(controlRoot, input.entrypoint);
  const dataRoot = resolve(controlRoot, input.dataRoot);
  const memoryRoot = input.memoryRoot ? resolve(controlRoot, input.memoryRoot) : null;
  const projectSpecs = input.projectSpecs ?? [];
  const workspaceSpecs = input.workspaceSpecs ?? [];
  const workflowSpecs = input.workflowSpecs ?? [];
  if (!inside(controlRoot, entrypoint) || !inside(controlRoot, dataRoot) || (memoryRoot && !inside(controlRoot, memoryRoot))) throw new Error('entrypoint, dataRoot, and memoryRoot must stay inside controlRoot.');
  await Promise.all([access(controlRoot), access(entrypoint)]);
  const activeRelease = await validateActiveReleaseBinding({ controlRoot, dataRoot, entrypoint, verifyAllFiles: true });
  const release = { version: activeRelease.version, artifactDigest: activeRelease.artifactDigest, generationId: activeRelease.generationId, pointerDigest: activeRelease.pointerDigest };

  const projects = {};
  const workspaces = {};
  for (const spec of projectSpecs) {
    const [alias, projectId, profileId, extensionId, projectWorkspaceInput, extra] = spec.split('|');
    const projectWorkspaceRoot = projectWorkspaceInput ? resolve(projectWorkspaceInput) : workspaceRoot;
    if (extra !== undefined || !/^[a-z][a-z0-9-]{0,31}$/.test(alias ?? '') || !projectId || !profileId || !extensionId || !projectWorkspaceRoot || projects[alias]) throw new Error(`Invalid --project value: ${spec}`);
    await access(projectWorkspaceRoot);
    const workspaceIdentity = await resolveGitWorkspaceIdentity(projectWorkspaceRoot);
    projects[alias] = { projectId, profileId, extensionId, workspaceRoot: projectWorkspaceRoot, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
  }
  for (const spec of workspaceSpecs) {
    const [alias, workspaceId, executionTargetId, workspaceRootInput, extra] = spec.split('|');
    const workspaceRoot = workspaceRootInput ? resolve(workspaceRootInput) : null;
    if (extra !== undefined || ![alias, workspaceId, executionTargetId].every(value => /^[a-z][a-z0-9-]{0,31}$/.test(value ?? '')) || !workspaceRoot || projects[alias] || workspaces[alias]) throw new Error(`Invalid --workspace value: ${spec}`);
    await access(workspaceRoot);
    const workspaceIdentity = await resolveGitWorkspaceIdentity(workspaceRoot);
    workspaces[alias] = { workspaceId, executionTargetId, workspaceRoot, ...(workspaceIdentity ? { workspaceIdentity } : {}) };
  }
  for (const spec of workflowSpecs) {
    const [alias, id, version, artifactDigest, profileId, extensionId, extra] = spec.split('|');
    const binding = projects[alias] ?? workspaces[alias];
    if (extra !== undefined || !binding || !/^[a-z][a-z0-9-]{0,31}$/.test(id ?? '') || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[a-f0-9]{64}$/.test(artifactDigest ?? '') || !profileId || !extensionId) throw new Error(`Invalid --workflow value: ${spec}`);
    binding.workflows ??= [];
    if (binding.workflows.some(workflow => workflow.id === id)) throw new Error(`Duplicate workflow binding: ${alias}/${id}`);
    binding.workflows.push({ id, version, artifactDigest, profileId, extensionId });
  }
  if (!Object.keys(projects).length && !Object.keys(workspaces).length) throw new Error('At least one --project or --workspace alias is required.');
  if (Object.values(workspaces).some(workspace => !workspace.workflows?.length)) throw new Error('Each Workspace alias requires at least one --workflow binding.');

  const directory = resolve(pluginRoot, '.plugin-data');
  const target = resolve(directory, 'bindings.json');
  const temporary = resolve(directory, `bindings.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true });
  const document = { protocolVersion: '1.0', harness: { controlRoot, entrypoint, dataRoot, ...(memoryRoot ? { memoryRoot } : {}), release }, projects, workspaces };
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await rm(target, { force: true });
    await rename(temporary, target);
  }
  return { ok: true, bindingFile: target, ...document };
};

const main = async () => {
  const result = await configureBindings(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Agent Harness binding configuration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
