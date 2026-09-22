import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = ['index.mjs', 'extension.mjs', 'planner.mjs', 'graph/definition.mjs', 'contracts/index.mjs', 'policy/index.mjs'];
const imports = /(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)[('\s]*['"]([^'"]+)['"]/g;

export const validateFlowImport = ({ root, flowId, file, specifier }) => {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(file), specifier);
  const legacyRoot = resolve(root, 'integrations', 'legacy-consumers');
  if (!relative(legacyRoot, target).split(sep).includes('..')) {
    return `${relative(root, file)} imports a legacy consumer implementation`;
  }
  const flowsRoot = resolve(root, 'src', 'flows');
  const parts = relative(flowsRoot, target).split(sep);
  if (parts[0] === '..' || parts[0] === flowId || !['graph', 'nodes', 'policy'].includes(parts[1])) return null;
  return `${relative(root, file)} imports private ${parts[0]}/${parts[1]} from another Flow`;
};

export const checkFlowStructure = async root => {
  const errors = [];
  const flowsRoot = resolve(root, 'src', 'flows');
  const walk = async (directory, flowId) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(file, flowId);
      else if (entry.name.endsWith('.mjs')) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(imports)) {
          const error = validateFlowImport({ root, flowId, file, specifier: match[1] });
          if (error) errors.push(error);
        }
      }
    }
  };
  for (const entry of await readdir(flowsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const path of required) {
      try { await access(resolve(flowsRoot, entry.name, path)); }
      catch { errors.push(`missing Flow file: src/flows/${entry.name}/${path}`); }
    }
    try { await access(resolve(flowsRoot, entry.name, 'nodes')); }
    catch { errors.push(`missing stage nodes: src/flows/${entry.name}/nodes`); }
    try { await access(resolve(root, 'docs', 'flows', entry.name, 'design.md')); }
    catch { errors.push(`missing Flow design: docs/flows/${entry.name}/design.md`); }
    try {
      const module = await import(pathToFileURL(resolve(flowsRoot, entry.name, 'extension.mjs')).href);
      for (const workflow of module.extensionPack?.workflows ?? []) for (const [routeId, nodes] of Object.entries(workflow.routes ?? {})) for (const node of nodes) {
        if (!node.task?.taskDigest) errors.push(`Flow Node lacks a versioned Task Contract: ${entry.name}/${routeId}/${node.id}`);
        if (!Object.keys(node.outputPorts ?? {}).length) errors.push(`Flow Node lacks a typed output port: ${entry.name}/${routeId}/${node.id}`);
        for (const [portId] of Object.entries(node.outputPorts ?? {})) if (!node.outputValueSchemas?.[portId]) errors.push(`Flow Node lacks an output value Schema: ${entry.name}/${routeId}/${node.id}/${portId}`);
      }
    } catch (error) { errors.push(`cannot inspect Flow contracts: ${entry.name}: ${error.code ?? error.message}`); }
    await walk(resolve(flowsRoot, entry.name), entry.name);
  }
  for (const area of ['kernel', 'platform']) {
    const visit = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.name.endsWith('.mjs')) {
          const source = await readFile(file, 'utf8');
          if (area === 'platform' && /\b(?:Codex|CardWorld|Collection)\b/.test(source)) errors.push(`${relative(root, file)} contains a vendor or consumer-specific implementation`);
          for (const match of source.matchAll(imports)) {
            if (match[1].startsWith('.') && relative(flowsRoot, resolve(dirname(file), match[1])).split(sep)[0] !== '..') errors.push(`${relative(root, file)} imports a concrete Flow`);
          }
        }
      }
    };
    await visit(resolve(root, 'src', area));
  }
  return errors;
};
