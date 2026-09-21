import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const safeStage = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};
const normalize = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  throw new Error(`Hook diagnostic cannot canonicalize ${typeof value}.`);
};
const digestJson = value => createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
const sha256 = value => createHash('sha256').update(String(value ?? '')).digest('hex');

const bindingCandidates = ({ pluginData = process.env.PLUGIN_DATA, pluginRoot = process.env.PLUGIN_ROOT, fallbackPluginRoot = modulePluginRoot } = {}) => [
  ...(pluginData ? [resolve(pluginData, 'bindings.json')] : []),
  ...[...new Set([pluginRoot, fallbackPluginRoot].filter(Boolean))].map(root => resolve(root, '.plugin-data', 'bindings.json')),
];

const loadDiagnosticRoots = async options => {
  for (const file of [...new Set(bindingCandidates(options))]) {
    let bindings;
    try { bindings = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const controlRoot = resolve(bindings?.harness?.controlRoot ?? '');
    const dataRoot = resolve(bindings?.harness?.dataRoot ?? '');
    if (!isAbsolute(bindings?.harness?.controlRoot ?? '') || !isAbsolute(bindings?.harness?.dataRoot ?? '') || !inside(controlRoot, dataRoot)) throw Object.assign(new Error(`Hook diagnostic binding roots are invalid: ${file}`), { code: 'CODEX_HOST_HOOK_DIAGNOSTIC_BINDING_INVALID' });
    return { controlRoot, dataRoot, bindingFile: file };
  }
  throw Object.assign(new Error('Hook diagnostic cannot resolve the installed binding file.'), { code: 'CODEX_HOST_HOOK_DIAGNOSTIC_BINDING_MISSING' });
};

export const createHookBootstrapTrace = async ({ event = null, options = {}, now = () => new Date().toISOString(), invocationId = `hook_${randomUUID().replaceAll('-', '')}` } = {}) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(invocationId)) throw Object.assign(new Error('Hook diagnostic invocation ID is invalid.'), { code: 'CODEX_HOST_HOOK_DIAGNOSTIC_ID_INVALID' });
  const { controlRoot, dataRoot, bindingFile } = await loadDiagnosticRoots(options);
  const root = resolve(dataRoot, 'diagnostics', 'codex-host-hook');
  const invocationRoot = resolve(root, invocationId);
  if (!inside(controlRoot, root) || !inside(root, invocationRoot)) throw Object.assign(new Error('Hook diagnostic path escapes the standalone control root.'), { code: 'CODEX_HOST_HOOK_DIAGNOSTIC_PATH_INVALID' });
  await mkdir(invocationRoot, { recursive: true });
  let revision = 0;
  const record = async (stage, details = {}) => {
    if (!safeStage(stage)) throw Object.assign(new Error(`Hook diagnostic stage is invalid: ${stage}`), { code: 'CODEX_HOST_HOOK_DIAGNOSTIC_STAGE_INVALID' });
    revision += 1;
    const body = {
      protocolVersion: '1.0',
      kind: 'codex-host-hook-bootstrap-state',
      invocationId,
      revision,
      stage,
      bindingFileDigest: sha256(bindingFile),
      hookEventName: event?.hook_event_name ?? null,
      toolName: event?.tool_name ?? null,
      sessionIdDigest: event?.session_id ? sha256(event.session_id) : null,
      observedAt: now(),
      ...structuredClone(details),
    };
    const receipt = { ...body, receiptDigest: digestJson(body) };
    const target = resolve(invocationRoot, `${String(revision).padStart(2, '0')}-${stage}.json`);
    const temporary = `${target}.stage-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
    return receipt;
  };
  return Object.freeze({ invocationId, controlRoot, dataRoot, record });
};
