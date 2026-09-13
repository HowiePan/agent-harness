import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  const parsed = {
    pluginRoot: take('--plugin-root'),
    controlRoot: take('--control-root'),
    workspaceRoot: take('--workspace-root'),
    entrypoint: take('--entrypoint'),
    dataRoot: take('--data-root'),
    projectSpecs: takeAll('--project'),
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
  const workspaceRoot = resolve(input.workspaceRoot);
  const entrypoint = resolve(controlRoot, input.entrypoint);
  const dataRoot = resolve(controlRoot, input.dataRoot);
  const projectSpecs = input.projectSpecs ?? [];
  if (!inside(controlRoot, entrypoint) || !inside(controlRoot, dataRoot)) throw new Error('entrypoint and dataRoot must stay inside controlRoot.');
  await Promise.all([access(controlRoot), access(workspaceRoot), access(entrypoint)]);

  const projects = {};
  for (const spec of projectSpecs) {
    const [alias, projectId, profileId, extensionId, extra] = spec.split('|');
    if (extra !== undefined || !/^[a-z][a-z0-9-]{0,31}$/.test(alias ?? '') || !projectId || !profileId || !extensionId || projects[alias]) throw new Error(`Invalid --project value: ${spec}`);
    projects[alias] = { projectId, profileId, extensionId };
  }
  if (!Object.keys(projects).length) throw new Error('At least one --project alias is required.');

  const directory = resolve(pluginRoot, '.plugin-data');
  const target = resolve(directory, 'bindings.json');
  const temporary = resolve(directory, `bindings.${process.pid}.tmp`);
  await mkdir(directory, { recursive: true });
  const document = { protocolVersion: '1.0', harness: { controlRoot, entrypoint, dataRoot }, workspaceRoot, projects };
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
