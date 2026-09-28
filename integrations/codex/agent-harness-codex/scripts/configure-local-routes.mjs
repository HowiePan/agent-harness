#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureLocalSourceRoutes } from '../hooks/local-source-route.mjs';

export const writeLocalSourceRoutes = async ({ defaultBindingsDir, routes }) => {
  const document = await configureLocalSourceRoutes({ defaultBindingsDir, routes });
  const target = resolve(defaultBindingsDir, 'project-routes.json');
  const temporary = resolve(defaultBindingsDir, `project-routes.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, target); }
  finally { await rm(temporary, { force: true }); }
  const persisted = JSON.parse(await readFile(target, 'utf8'));
  return { ok: true, routeFile: target, aliases: persisted.entries.map(entry => entry.alias) };
};

const main = async () => {
  let defaultBindingsDir;
  const routes = [];
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--bindings-dir') defaultBindingsDir = value;
    else if (flag === '--route') {
      const [alias, projectId, projectRoot, bindingsDir, extra] = value.split('|');
      if (extra !== undefined || ![alias, projectId, projectRoot, bindingsDir].every(Boolean)) throw new Error(`Invalid route ${value}.`);
      routes.push({ alias, projectId, projectRoot, bindingsDir });
    } else throw new Error(`Unknown flag ${flag}.`);
  }
  if (!defaultBindingsDir || !routes.length) throw new Error('Usage: configure-local-routes.mjs --bindings-dir <root-bindings-dir> --route <alias|projectId|projectRoot|bindingsDir> [...]');
  process.stdout.write(`${JSON.stringify(await writeLocalSourceRoutes({ defaultBindingsDir, routes }))}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.code ?? 'LOCAL_SOURCE_ROUTE_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
}
